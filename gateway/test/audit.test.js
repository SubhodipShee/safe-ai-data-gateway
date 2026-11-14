// Tests for Phase 4: the tamper-evident audit chain and the DPDP report.
// Each "ATTACK" test plays an attacker with FULL database access who tries to
// change the evidence, and checks that verify() catches it.
// Uses Atlas database "safe-ai-gateway-test-audit" (deleted afterwards).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createPublicKey } from 'node:crypto';
import { createAuditChain, computeEntryHash } from '../src/audit/audit-chain.js';
import { buildDpdpReport, parseReportPeriod } from '../src/audit/dpdp-report.js';
import { deriveSigningKeys, signMessage, verifySignature } from '../src/crypto/signing.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { AuditHead } from '../src/models/AuditHead.js';
import { connectTestDb, dropTestDb, SKIP_WITHOUT_DB } from './test-db.js';

const masterKey = randomBytes(32);
const chain = createAuditChain({ masterKey });

/** Writes n simple audit entries. */
async function writeEntries(n, overrides = {}) {
  const entries = Array.from({ length: n }, (_, i) => ({
    sessionId: 'session-aaaaaaaaaaaaaaaa',
    source: 'chatgpt.com',
    entityType: i % 2 ? 'EMAIL' : 'AADHAAR',
    count: i + 1,
    obfuscatedCount: 0,
    action: 'masked',
    ...overrides,
  }));
  return chain.append(entries);
}

/** The kinds of problems verify() found, e.g. ['modified']. */
async function problemKinds() {
  const result = await chain.verify();
  return result.problems.map((p) => p.kind);
}

// ---- Signing (no database needed) ----

describe('Ed25519 signing', () => {
  test('the same master key always gives the same signing key', () => {
    assert.equal(deriveSigningKeys(masterKey).publicKeyPem, deriveSigningKeys(masterKey).publicKeyPem);
  });
  test('a signature verifies; a changed message or another key does not', () => {
    const { privateKey, publicKey } = deriveSigningKeys(masterKey);
    const signature = signMessage(privateKey, 'chain ends at #5');
    assert.equal(verifySignature(publicKey, 'chain ends at #5', signature), true);
    assert.equal(verifySignature(publicKey, 'chain ends at #4', signature), false);
    assert.equal(verifySignature(deriveSigningKeys(randomBytes(32)).publicKey, 'chain ends at #5', signature), false);
  });
  test('the public key is a standard PEM that any tool can load', () => {
    const key = createPublicKey(deriveSigningKeys(masterKey).publicKeyPem);
    assert.equal(key.asymmetricKeyType, 'ed25519');
  });
});

describe('parseReportPeriod', () => {
  test('defaults to the last 30 days', () => {
    const { from, to } = parseReportPeriod();
    assert.equal(Math.round((to - from) / 86_400_000), 30);
  });
  test('rejects bad dates and reversed ranges', () => {
    assert.throws(() => parseReportPeriod('yesterday'), TypeError);
    assert.throws(() => parseReportPeriod('2026-12-01', '2026-11-01'), TypeError);
  });
});

// ---- The chain (Atlas) ----

describe('audit chain (MongoDB Atlas)', { skip: SKIP_WITHOUT_DB }, () => {
  before(() => connectTestDb('audit'));
  after(() => dropTestDb());

  // Every test starts with an empty chain.
  beforeEach(async () => {
    await AuditLog.deleteMany({});
    await AuditHead.deleteMany({});
  });

  test('entries are numbered 1, 2, 3… and each links to the one before', async () => {
    const written = await writeEntries(3);
    assert.deepEqual(written.map((e) => e.seq), [1, 2, 3]);
    assert.equal(written[0].prevHash, '0'.repeat(64));
    assert.equal(written[1].prevHash, written[0].hash);
    assert.equal(written[2].prevHash, written[1].hash);
  });

  test('a clean chain verifies', async () => {
    await writeEntries(5);
    const result = await chain.verify();
    assert.equal(result.valid, true, JSON.stringify(result.problems));
    assert.equal(result.entriesChecked, 5);
    assert.equal(result.head.seq, 5);
  });

  test('the head is signed and points at the newest entry', async () => {
    const written = await writeEntries(2);
    const head = await AuditHead.findById('audit').lean();
    assert.equal(head.seq, 2);
    assert.equal(head.hash, written[1].hash);
  });

  test('ATTACK: change a number in an old entry → "modified"', async () => {
    await writeEntries(5);
    await AuditLog.updateOne({ seq: 3 }, { count: 999 });
    const result = await chain.verify();
    assert.equal(result.valid, false);
    assert.deepEqual(result.problems.map((p) => [p.seq, p.kind]), [[3, 'modified']]);
  });

  test('ATTACK: change "blocked" to "masked" (hide a blocked leak) → caught', async () => {
    await writeEntries(3, { action: 'blocked' });
    await AuditLog.updateOne({ seq: 2 }, { action: 'masked' });
    assert.deepEqual(await problemKinds(), ['modified']);
  });

  test('ATTACK: edit an entry AND recompute its hash → the NEXT link breaks', async () => {
    await writeEntries(5);
    const entry = await AuditLog.findOne({ seq: 3 }).lean();
    const forged = { ...entry, count: 999 };
    forged.hash = computeEntryHash(forged);
    await AuditLog.updateOne({ seq: 3 }, { count: 999, hash: forged.hash });
    const result = await chain.verify();
    assert.equal(result.valid, false);
    assert.deepEqual(result.problems.map((p) => [p.seq, p.kind]), [[4, 'broken-link']]);
  });

  test('ATTACK: delete an entry in the middle → "missing"', async () => {
    await writeEntries(5);
    await AuditLog.deleteOne({ seq: 3 });
    assert.deepEqual(await problemKinds(), ['missing']);
  });

  test('ATTACK: delete the NEWEST entries → the signed head catches it ("truncated")', async () => {
    await writeEntries(5);
    await AuditLog.deleteMany({ seq: { $gte: 4 } });
    const result = await chain.verify();
    assert.deepEqual(result.problems.map((p) => [p.seq, p.kind]), [[4, 'truncated']]);
  });

  test('ATTACK: rewrite the whole chain with correct hashes → no matching signed head', async () => {
    await writeEntries(3);
    // The attacker rebuilds all 3 entries with fake counts and perfectly valid links…
    let prevHash = '0'.repeat(64);
    for (const entry of await AuditLog.find().sort({ seq: 1 }).lean()) {
      const forged = { ...entry, count: 1, prevHash };
      forged.hash = computeEntryHash(forged);
      await AuditLog.updateOne({ _id: entry._id }, { count: 1, prevHash, hash: forged.hash });
      prevHash = forged.hash;
    }
    // …but can't produce a new signed head, so the newest entry no longer matches it.
    assert.deepEqual(await problemKinds(), ['head-mismatch']);
  });

  test('ATTACK: also edit the head → the signature is invalid', async () => {
    await writeEntries(3);
    await AuditHead.updateOne({ _id: 'audit' }, { hash: 'f'.repeat(64) });
    assert.deepEqual(await problemKinds(), ['bad-signature']);
  });

  test('ATTACK: delete the head entirely → "no-head"', async () => {
    await writeEntries(3);
    await AuditHead.deleteMany({});
    assert.deepEqual(await problemKinds(), ['no-head']);
  });

  test('a chain checked with a DIFFERENT master key fails (signature)', async () => {
    await writeEntries(2);
    const otherChain = createAuditChain({ masterKey: randomBytes(32) });
    const result = await otherChain.verify();
    assert.deepEqual(result.problems.map((p) => p.kind), ['bad-signature']);
  });

  test('RETENTION: old entries removed by the 90-day policy are a note, not a problem', async () => {
    await writeEntries(5);
    await AuditLog.deleteMany({ seq: { $lte: 2 } }); // as if the TTL index removed them
    const result = await chain.verify();
    assert.equal(result.valid, true, JSON.stringify(result.problems));
    assert.match(result.notes[0], /before #3 were removed/);
  });

  test('RACE: 20 simultaneous appends → numbers 1–20 with no gaps, chain valid', async () => {
    await Promise.all(Array.from({ length: 20 }, () => writeEntries(1)));
    const seqs = (await AuditLog.find().sort({ seq: 1 }).lean()).map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal((await chain.verify()).valid, true);
  });

  test('a SECOND gateway process (separate chain object) appends correctly to the same chain', async () => {
    await writeEntries(2);
    const secondProcess = createAuditChain({ masterKey });
    await secondProcess.append([{ sessionId: 'x'.repeat(16), source: 'claude.ai', entityType: 'PAN', count: 1, action: 'masked' }]);
    await writeEntries(1);
    const result = await chain.verify();
    assert.equal(result.valid, true, JSON.stringify(result.problems));
    assert.equal(result.entriesChecked, 4);
  });

  test('DPDP report: totals, categories, AI providers, bypass attempts and a valid signature', async () => {
    const session = randomUUID();
    await chain.append([
      { sessionId: session, source: 'chatgpt.com', entityType: 'AADHAAR', count: 2, obfuscatedCount: 1, action: 'masked' },
      { sessionId: session, source: 'chatgpt.com', entityType: 'EMAIL', count: 3, action: 'masked' },
      { sessionId: session, source: 'claude.ai', entityType: 'PRIVATE_KEY', count: 1, action: 'blocked' },
    ]);

    const report = await buildDpdpReport({ ...parseReportPeriod(), auditChain: chain });

    assert.deepEqual(report.totals, { itemsMasked: 5, itemsBlocked: 1, bypassAttempts: 1 });
    const categories = Object.fromEntries(report.byCategory.map((c) => [c.category, c.masked + c.blocked]));
    assert.deepEqual(categories, { 'Identity documents': 2, 'Contact details': 3, 'Credentials and secrets': 1 });
    const providers = Object.fromEntries(report.byDestination.map((d) => [d.aiProvider, d.masked + d.blocked]));
    assert.deepEqual(providers, { OpenAI: 5, Anthropic: 1 });
    assert.equal(report.auditLogIntegrity.valid, true);

    // The signature covers the report without its signature field.
    const { signature, ...body } = report;
    const { publicKey } = deriveSigningKeys(masterKey);
    assert.equal(verifySignature(publicKey, JSON.stringify(body), signature.value), true);
  });

  test('DPDP report shows a broken chain when the log was tampered with', async () => {
    await writeEntries(3);
    await AuditLog.updateOne({ seq: 2 }, { count: 0 });
    const report = await buildDpdpReport({ ...parseReportPeriod(), auditChain: chain });
    assert.equal(report.auditLogIntegrity.valid, false);
  });
});
