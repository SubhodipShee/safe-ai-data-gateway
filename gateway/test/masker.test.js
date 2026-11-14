// Tests for masker.js: mask → (AI) → unmask, policies and the audit log.
// Uses Atlas database "safe-ai-gateway-test-masker" (deleted afterwards).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createVault } from '../src/vault.js';
import { createMasker } from '../src/masker.js';
import { createAuditChain } from '../src/audit/audit-chain.js';
import { clearPolicyCache } from '../src/policies.js';
import { Policy, seedDefaultPolicies } from '../src/models/Policy.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { VaultEntry } from '../src/models/VaultEntry.js';
import { detect } from '../src/detectors/index.js';
import { connectTestDb, dropTestDb, SKIP_WITHOUT_DB } from './test-db.js';

const masterKey = randomBytes(32);
const vault = createVault({ masterKey });
const auditChain = createAuditChain({ masterKey });
const masker = createMasker({ vault, auditChain });
const newSession = () => randomUUID();

// A realistic leaky prompt (fake data).
const PROMPT = [
  'Draft a refund email for Rahul (rahul.verma@gmail.com, +91 98765 43210).',
  'PAN ABCPE1234F, Aadhaar 2345 6789 0124. Write to rahul.verma@gmail.com again tomorrow.',
  'Key: AKIAIOSFODNN7EXAMPLE',
].join('\n');

/** Sets one type's policy and makes the masker see it immediately. */
async function setPolicy(type, action) {
  await Policy.updateOne({ _id: type }, { action }, { upsert: true });
  clearPolicyCache();
}

describe('masker (MongoDB Atlas)', { skip: SKIP_WITHOUT_DB }, () => {
  before(async () => {
    await connectTestDb('masker');
    await seedDefaultPolicies();
  });
  after(() => dropTestDb());

  // Every test starts with all policies on "mask".
  beforeEach(async () => {
    await Policy.updateMany({}, { action: 'mask' });
    clearPolicyCache();
  });

  test('ROUND TRIP: unmask(mask(text)) gives back exactly the original text', async () => {
    const s = newSession();
    const masked = await masker.maskText({ sessionId: s, text: PROMPT });
    const restored = await masker.unmaskText({ sessionId: s, text: masked.maskedText });
    assert.equal(restored.text, PROMPT);
  });

  test('the masked text contains NONE of the sensitive values', async () => {
    const masked = await masker.maskText({ sessionId: newSession(), text: PROMPT });
    for (const finding of detect(PROMPT)) {
      assert.ok(!masked.maskedText.includes(finding.value), `leaked: ${finding.value}`);
    }
    assert.deepEqual(detect(masked.maskedText), [], 'the masked text should look clean to the detectors');
  });

  test('tags are numbered in order of appearance', async () => {
    const masked = await masker.maskText({ sessionId: newSession(), text: 'a@abc.com then b@abc.com' });
    assert.equal(masked.maskedText, '[[EMAIL_1]] then [[EMAIL_2]]');
  });

  test('a value repeated in the text gets the SAME tag each time', async () => {
    const masked = await masker.maskText({ sessionId: newSession(), text: PROMPT });
    assert.equal(masked.maskedText.match(/\[\[EMAIL_1\]\]/g).length, 2);
    assert.ok(!masked.maskedText.includes('[[EMAIL_2]]'));
  });

  test('the same value keeps its tag across messages in one session', async () => {
    const s = newSession();
    await masker.maskText({ sessionId: s, text: 'first: rahul@abc.com' });
    const second = await masker.maskText({ sessionId: s, text: 'priya@xyz.in and again rahul@abc.com' });
    assert.equal(second.maskedText, '[[EMAIL_2]] and again [[EMAIL_1]]');
  });

  test('the response never contains the real values', async () => {
    const masked = await masker.maskText({ sessionId: newSession(), text: PROMPT });
    const json = JSON.stringify(masked);
    assert.ok(!json.includes('rahul.verma'));
    assert.ok(!json.includes('ABCPE1234F'));
    for (const item of masked.items) assert.equal(item.value, undefined);
  });

  test('text with nothing sensitive is returned unchanged', async () => {
    const text = 'Summarise our Q3 meeting: revenue grew 12%.';
    const masked = await masker.maskText({ sessionId: newSession(), text });
    assert.equal(masked.maskedText, text);
    assert.deepEqual(masked.items, []);
  });

  test('POLICY "block": nothing is masked or stored, and the block is audited', async () => {
    await setPolicy('API_KEY', 'block');
    const s = newSession();
    const result = await masker.maskText({ sessionId: s, text: PROMPT, source: 'test' });

    assert.equal(result.blocked, true);
    assert.deepEqual(result.blockedTypes, { API_KEY: 1 });
    assert.equal(result.maskedText, undefined);
    assert.equal(await VaultEntry.countDocuments({ sessionId: s }), 0);

    const log = await AuditLog.findOne({ sessionId: s }).lean();
    assert.equal(log.action, 'blocked');
    assert.equal(log.entityType, 'API_KEY');
  });

  test('POLICY "allow": that type is left in the text', async () => {
    await setPolicy('PHONE', 'allow');
    const masked = await masker.maskText({ sessionId: newSession(), text: 'call +91 98765 43210 or a@abc.com' });
    assert.equal(masked.maskedText, 'call +91 98765 43210 or [[EMAIL_1]]');
  });

  test('AUDIT LOG: records types and counts, never the values', async () => {
    const s = newSession();
    await masker.maskText({ sessionId: s, text: PROMPT, source: 'chatgpt.com' });
    const logs = await AuditLog.find({ sessionId: s }).lean();

    const counts = Object.fromEntries(logs.map((l) => [l.entityType, l.count]));
    assert.deepEqual(counts, { EMAIL: 2, PHONE: 1, PAN: 1, AADHAAR: 1, API_KEY: 1 });
    assert.ok(logs.every((l) => l.action === 'masked' && l.source === 'chatgpt.com'));

    const everything = JSON.stringify(logs);
    assert.ok(!everything.includes('rahul') && !everything.includes('ABCPE1234F'));
  });

  test('UNMASK accepts tags the AI slightly changed', async () => {
    const s = newSession();
    await masker.maskText({ sessionId: s, text: 'a@abc.com' });
    for (const variant of ['[[EMAIL_1]]', '[EMAIL_1]', '[[ EMAIL_1 ]]', '[[EMAIL_1]', '[[EMAIL_01]]']) {
      const { text } = await masker.unmaskText({ sessionId: s, text: `to ${variant}.` });
      assert.equal(text, 'to a@abc.com.', `variant ${variant}`);
    }
  });

  test('UNMASK leaves unknown tags alone and reports them', async () => {
    const s = newSession();
    await masker.maskText({ sessionId: s, text: 'a@abc.com' });
    const result = await masker.unmaskText({ sessionId: s, text: '[[EMAIL_1]] and [[EMAIL_7]] and [[TODO_1]]' });
    assert.equal(result.text, 'a@abc.com and [[EMAIL_7]] and [[TODO_1]]');
    assert.equal(result.restored, 1);
    assert.deepEqual(result.unknown, ['[[EMAIL_7]]']);
  });

  test('UNMASK in a different session reveals nothing', async () => {
    const owner = newSession();
    await masker.maskText({ sessionId: owner, text: 'a@abc.com' });
    const stranger = await masker.unmaskText({ sessionId: newSession(), text: '[[EMAIL_1]]' });
    assert.equal(stranger.text, '[[EMAIL_1]]');
    assert.equal(stranger.restored, 0);
  });

  test('Phase 3.5: a Devanagari Aadhaar is masked, gets the SAME tag as the ASCII one, and restores as typed', async () => {
    const s = newSession();
    const first = await masker.maskText({ sessionId: s, text: 'Aadhaar 2345 6789 0124' });
    const second = await masker.maskText({ sessionId: s, text: 'फिर से: २३४५ ६७८९ ०१२४' });

    assert.equal(first.maskedText, 'Aadhaar [[AADHAAR_1]]');
    assert.equal(second.maskedText, 'फिर से: [[AADHAAR_1]]');
    assert.equal(second.bypassAttempts, 1);
    assert.equal(second.items[0].obfuscated, true);

    const restored = await masker.unmaskText({ sessionId: s, text: second.maskedText });
    assert.equal(restored.text, 'फिर से: 2345 6789 0124', 'the vault keeps the FIRST spelling it saw');

    const log = await AuditLog.findOne({ sessionId: s, obfuscatedCount: 1 }).lean();
    assert.equal(log.entityType, 'AADHAAR');
  });

  test('UNMASK handles values containing "$" (no special replace patterns)', async () => {
    const s = newSession();
    const secret = 'DB_PASSWORD=pa$$w0rd$&end';
    const masked = await masker.maskText({ sessionId: s, text: secret });
    const restored = await masker.unmaskText({ sessionId: s, text: masked.maskedText });
    assert.equal(restored.text, secret);
  });
});
