// Tests for Phase 7: the AI proxy (POST /v1/chat/completions).
// A FAKE AI provider runs locally and records everything it receives, so we can
// prove the real values never reach it. No real API key is needed.
// Uses Atlas database "safe-ai-gateway-test-proxy".
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/app.js';
import { createVault } from '../src/vault.js';
import { createAuditChain } from '../src/audit/audit-chain.js';
import { createLlmClient } from '../src/ai/llm-client.js';
import { providerForSource } from '../src/audit/dpdp-report.js';
import { clearPolicyCache } from '../src/policies.js';
import { Policy, seedDefaultPolicies } from '../src/models/Policy.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { connectTestDb, dropTestDb, SKIP_WITHOUT_DB } from './test-db.js';

// ---- The fake AI provider ----
const received = []; //  every request body the "AI" got
/** The messages the AI got in request i, without the gateway's own system instruction. */
const sentMessages = (i) => received[i].messages.filter((m) => !m.content.startsWith('Some values in this conversation'));
let mode = 'echo'; //      'echo' | 'rate-limit' | 'bad-key'

const fakeProvider = express();
fakeProvider.use(express.json());
fakeProvider.post('/v1/chat/completions', (req, res) => {
  received.push(req.body);
  if (mode === 'rate-limit') return res.status(429).set('Retry-After', '7').json({ error: { message: 'slow down' } });
  if (mode === 'bad-key') return res.status(401).json({ error: { message: 'invalid key' } });
  // Like a real AI, reply using the tags it was given.
  const lastMessage = req.body.messages.at(-1).content;
  const tags = lastMessage.match(/\[\[[A-Z_]+_\d+\]\]/g) ?? [];
  res.json({
    model: 'fake-model',
    choices: [{ message: { role: 'assistant', content: `Done. I have noted ${tags.join(' and ') || 'nothing'}.` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
});

let gateway;
let fakeServer;
let baseUrl;

async function chat(messages, headers = {}) {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'anything', messages }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('provider names in the DPDP report', () => {
  test('sources map to AI companies', () => {
    assert.equal(providerForSource('chatgpt.com'), 'OpenAI');
    assert.equal(providerForSource('api-proxy:groq'), 'Groq');
    assert.equal(providerForSource('playground:groq'), 'Groq (via playground)');
    assert.equal(providerForSource('something-else'), 'Unknown');
  });
});

describe('AI proxy (fake provider + Atlas)', { skip: SKIP_WITHOUT_DB }, () => {
  before(async () => {
    await connectTestDb('proxy');
    await seedDefaultPolicies();
    clearPolicyCache();

    fakeServer = await listen(fakeProvider);
    const masterKey = randomBytes(32);
    const llm = createLlmClient({
      provider: 'custom',
      baseUrl: `http://127.0.0.1:${fakeServer.address().port}/v1`,
      apiKey: 'test-key',
      model: 'fake-model',
    });
    gateway = await listen(createApp({
      vault: createVault({ masterKey }),
      auditChain: createAuditChain({ masterKey }),
      llm,
      providerKey: 'groq',
    }));
    baseUrl = `http://127.0.0.1:${gateway.address().port}`;
  });

  after(async () => {
    gateway?.close();
    fakeServer?.close();
    await dropTestDb();
  });

  beforeEach(() => {
    received.length = 0;
    mode = 'echo';
  });

  test('THE AI NEVER SEES THE REAL VALUES', async () => {
    await chat([{ role: 'user', content: 'Email rahul.verma@gmail.com about PAN ABCPE1234F and call +91 98765 43210' }]);
    const whatTheAiGot = JSON.stringify(received);
    for (const secret of ['rahul.verma@gmail.com', 'ABCPE1234F', '98765']) {
      assert.ok(!whatTheAiGot.includes(secret), `the AI received "${secret}"`);
    }
    assert.equal(sentMessages(0)[0].content, 'Email [[EMAIL_1]] about PAN [[PAN_1]] and call [[PHONE_1]]');
    assert.equal(received[0].messages[0].role, 'system', 'the keep-the-tags instruction comes first');
  });

  test('the reply comes back with the real values restored', async () => {
    const { status, body } = await chat([{ role: 'user', content: 'Email rahul@abc.com, PAN ABCPE1234F' }]);
    assert.equal(status, 200);
    assert.equal(body.choices[0].message.content, 'Done. I have noted rahul@abc.com and ABCPE1234F.');
    assert.equal(body.gateway.aiReplyWithTags, 'Done. I have noted [[EMAIL_1]] and [[PAN_1]].');
    assert.deepEqual(body.gateway.protected, { EMAIL: 1, PAN: 1 });
    assert.equal(body.object, 'chat.completion'); // still the OpenAI response format
  });

  test('a conversation keeps the SAME tags across turns (X-Session-Id)', async () => {
    const sessionId = randomUUID();
    const first = await chat([{ role: 'user', content: 'Remember rahul@abc.com' }], { 'X-Session-Id': sessionId });
    const history = [
      { role: 'user', content: 'Remember rahul@abc.com' },
      { role: 'assistant', content: first.body.choices[0].message.content }, // contains the REAL email
      { role: 'user', content: 'Now also priya@xyz.in' },
    ];
    await chat(history, { 'X-Session-Id': sessionId });

    const sent = sentMessages(1).map((m) => m.content);
    assert.equal(sent[1], 'Done. I have noted [[EMAIL_1]].', 'the history is masked too, with the same tag');
    assert.equal(sent[2], 'Now also [[EMAIL_2]]');
    assert.ok(!JSON.stringify(received).includes('rahul@abc.com'));
  });

  test('only the NEWEST message is audited (history is not counted twice)', async () => {
    const sessionId = randomUUID();
    await chat([
      { role: 'user', content: 'old: a@abc.com' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'new: PAN ABCPE1234F' },
    ], { 'X-Session-Id': sessionId });
    const logs = await AuditLog.find({ sessionId }).lean();
    assert.deepEqual(logs.map((l) => l.entityType), ['PAN']);
    assert.equal(logs[0].source, 'api-proxy:groq');
  });

  test('BLOCKED content is never sent to the AI at all', async () => {
    await Policy.updateOne({ _id: 'PRIVATE_KEY' }, { action: 'block' });
    clearPolicyCache();
    const { status, body } = await chat([{ role: 'user', content: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----' }]);
    assert.equal(status, 403);
    assert.equal(body.error.type, 'policy_violation');
    assert.equal(received.length, 0, 'the AI provider must not have been called');
    await Policy.updateOne({ _id: 'PRIVATE_KEY' }, { action: 'mask' });
    clearPolicyCache();
  });

  test('provider rate limit → 429 with Retry-After', async () => {
    mode = 'rate-limit';
    const { status, body, headers } = await chat([{ role: 'user', content: 'hi' }]);
    assert.equal(status, 429);
    assert.match(body.error.message, /free-tier limit/);
    assert.equal(headers.get('retry-after'), '7');
  });

  test('wrong API key → clear message, and the key is never echoed', async () => {
    mode = 'bad-key';
    const { status, body } = await chat([{ role: 'user', content: 'hi' }]);
    assert.equal(status, 502);
    assert.match(body.error.message, /rejected the API key/);
    assert.ok(!JSON.stringify(body).includes('test-key'));
  });

  test('bad requests → 400 in OpenAI error format', async () => {
    assert.equal((await chat([])).status, 400);
    assert.equal((await chat([{ role: 'hacker', content: 'x' }])).status, 400);
    assert.equal((await chat([{ role: 'user', content: 'x' }], { 'X-Session-Id': 'bad id!' })).status, 400);
    const streaming = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'x' }] }),
    });
    assert.equal(streaming.status, 400);
  });

  test('text parts ([{type:"text"}]) are masked too', async () => {
    await chat([{ role: 'user', content: [{ type: 'text', text: 'mail a@abc.com' }] }]);
    assert.equal(sentMessages(0)[0].content, 'mail [[EMAIL_1]]');
  });

  test('without an API key the proxy says so (503)', async () => {
    const masterKey = randomBytes(32);
    const noKeyGateway = await listen(createApp({
      vault: createVault({ masterKey }),
      auditChain: createAuditChain({ masterKey }),
      llm: createLlmClient({ provider: 'groq' }),
    }));
    const response = await fetch(`http://127.0.0.1:${noKeyGateway.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    noKeyGateway.close();
    assert.equal(response.status, 503);
  });
});
