// Tests for the HTTP endpoints, the same way the playground and extension call them.
// Starts the app on a random free port; uses Atlas database "safe-ai-gateway-test-api".
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createVault } from '../src/vault.js';
import { createApp } from '../src/app.js';
import { createAuditChain } from '../src/audit/audit-chain.js';
import { clearPolicyCache } from '../src/policies.js';
import { Policy, seedDefaultPolicies } from '../src/models/Policy.js';
import { MAX_TEXT_LENGTH } from '../src/detectors/index.js';
import { connectTestDb, dropTestDb, SKIP_WITHOUT_DB } from './test-db.js';

let server;
let baseUrl;

/** Calls the test server and returns { status, body }. */
async function call(method, path, body, { raw } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

describe('HTTP API', { skip: SKIP_WITHOUT_DB }, () => {
  before(async () => {
    await connectTestDb('api');
    await seedDefaultPolicies();
    clearPolicyCache();
    const masterKey = randomBytes(32);
    const app = createApp({
      vault: createVault({ masterKey }),
      auditChain: createAuditChain({ masterKey }),
    });
    // Port 0 = "pick any free port".
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.close();
    await dropTestDb();
  });

  test('GET /health → 200 connected', async () => {
    const { status, body } = await call('GET', '/health');
    assert.equal(status, 200);
    assert.equal(body.db, 'connected');
  });

  test('GET / → redirects to the playground, which is served', async () => {
    const response = await fetch(baseUrl + '/', { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/playground.html');
    const page = await fetch(baseUrl + '/playground.html');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Safe AI Gateway/);
  });

  test('POST /mask then POST /unmask: full round trip', async () => {
    const sessionId = randomUUID();
    const text = 'Mail rahul@abc.com, PAN ABCPE1234F';

    const masked = await call('POST', '/mask', { sessionId, text, source: 'api-test' });
    assert.equal(masked.status, 200);
    assert.equal(masked.body.maskedText, 'Mail [[EMAIL_1]], PAN [[PAN_1]]');
    assert.deepEqual(masked.body.summary, { EMAIL: 1, PAN: 1 });

    const reply = 'Done! Wrote to [[EMAIL_1]] about [[PAN_1]].';
    const unmasked = await call('POST', '/unmask', { sessionId, text: reply });
    assert.equal(unmasked.status, 200);
    assert.equal(unmasked.body.text, 'Done! Wrote to rahul@abc.com about ABCPE1234F.');
    assert.equal(unmasked.body.restored, 2);
  });

  test('POST /mask → 403 when a "block" policy matches', async () => {
    await Policy.updateOne({ _id: 'PRIVATE_KEY' }, { action: 'block' });
    clearPolicyCache();
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const { status, body } = await call('POST', '/mask', { sessionId: randomUUID(), text: pem });
    assert.equal(status, 403);
    assert.equal(body.blocked, true);
    assert.deepEqual(body.blockedTypes, { PRIVATE_KEY: 1 });
    await Policy.updateOne({ _id: 'PRIVATE_KEY' }, { action: 'mask' });
    clearPolicyCache();
  });

  test('DELETE /session/:id → values can no longer be restored', async () => {
    const sessionId = randomUUID();
    await call('POST', '/mask', { sessionId, text: 'a@abc.com' });
    const deleted = await call('DELETE', `/session/${sessionId}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, 1);

    const unmasked = await call('POST', '/unmask', { sessionId, text: '[[EMAIL_1]]' });
    assert.equal(unmasked.body.text, '[[EMAIL_1]]');
  });

  test('400 for bad input', async () => {
    assert.equal((await call('POST', '/mask', { sessionId: 'short', text: 'x' })).status, 400);
    assert.equal((await call('POST', '/mask', { sessionId: randomUUID() })).status, 400);
    assert.equal((await call('POST', '/mask', { sessionId: randomUUID(), text: 'x', source: 42 })).status, 400);
    assert.equal((await call('POST', '/unmask', { text: 'x' })).status, 400);
    assert.equal((await call('DELETE', '/session/bad!id')).status, 400);
  });

  test('400 for broken JSON, 413 for text that is too long', async () => {
    assert.equal((await call('POST', '/mask', undefined, { raw: '{not json' })).status, 400);
    const tooLong = 'a'.repeat(MAX_TEXT_LENGTH + 1);
    assert.equal((await call('POST', '/mask', { sessionId: randomUUID(), text: tooLong })).status, 413);
  });

  test('GET /api/audit/verify → the chain written by /mask is valid', async () => {
    await call('POST', '/mask', { sessionId: randomUUID(), text: 'a@abc.com', source: 'chatgpt.com' });
    const { status, body } = await call('GET', '/api/audit/verify');
    assert.equal(status, 200);
    assert.equal(body.valid, true, JSON.stringify(body.problems));
    assert.ok(body.entriesChecked >= 1);
  });

  test('GET /api/reports/dpdp → signed report with counts only', async () => {
    const { status, body } = await call('GET', '/api/reports/dpdp');
    assert.equal(status, 200);
    assert.ok(body.totals.itemsMasked >= 1);
    assert.equal(body.signature.algorithm, 'Ed25519');
    assert.ok(!JSON.stringify(body).includes('a@abc.com'), 'the report must not contain values');
    assert.equal((await call('GET', '/api/reports/dpdp?from=not-a-date')).status, 400);
  });

  test('GET /api/audit/public-key → an Ed25519 public key', async () => {
    const { body } = await call('GET', '/api/audit/public-key');
    assert.equal(body.algorithm, 'Ed25519');
    assert.match(body.publicKeyPem, /BEGIN PUBLIC KEY/);
  });

  test('GET/PUT /api/policies: list all types and change one (Phase 9 dashboard)', async () => {
    const list = await call('GET', '/api/policies');
    assert.equal(list.status, 200);
    assert.ok(list.body.some((p) => p.type === 'PRIVATE_CODE' && p.action === 'block'), 'private code is blocked by default');

    const changed = await call('PUT', '/api/policies/PHONE', { action: 'allow' });
    assert.deepEqual(changed.body, { type: 'PHONE', action: 'allow' });
    const masked = await call('POST', '/mask', { sessionId: randomUUID(), text: 'call 9876543210' });
    assert.equal(masked.body.maskedText, 'call 9876543210', 'the change applies immediately');
    await call('PUT', '/api/policies/PHONE', { action: 'mask' });

    assert.equal((await call('PUT', '/api/policies/PHONE', { action: 'explode' })).status, 400);
    assert.equal((await call('PUT', '/api/policies/NOPE', { action: 'mask' })).status, 400);
  });

  test('GET /api/audit/recent → newest entries, counts only', async () => {
    await call('POST', '/mask', { sessionId: randomUUID(), text: 'mail zz.top@abc.com', source: 'chatgpt.com' });
    const { status, body } = await call('GET', '/api/audit/recent?limit=3');
    assert.equal(status, 200);
    assert.ok(body.length >= 1 && body.length <= 3);
    assert.equal(body[0].aiProvider, 'OpenAI');
    assert.ok(!JSON.stringify(body).includes('zz.top'), 'never the values');
  });

  test('404 for unknown endpoints', async () => {
    assert.equal((await call('GET', '/nope')).status, 404);
  });

  test('responses do not reveal the server technology', async () => {
    const { headers } = await call('GET', '/health');
    assert.equal(headers.get('x-powered-by'), null);
  });
});
