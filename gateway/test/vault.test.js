// Tests for vault.js. These use the REAL Atlas database, in a separate
// database called "safe-ai-gateway-test-vault" that is deleted when the tests finish.
// If there's no MONGODB_URI (e.g. on GitHub Actions), these tests are skipped.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createVault, normalizeForLookup, isValidSessionId } from '../src/vault.js';
import { Session } from '../src/models/Session.js';
import { VaultEntry } from '../src/models/VaultEntry.js';
import { connectTestDb, dropTestDb, SKIP_WITHOUT_DB } from './test-db.js';

const masterKey = randomBytes(32); // a throwaway key just for the tests
const vault = createVault({ masterKey, sessionTtlHours: 24 });
const newSession = () => randomUUID();

// ---- Tests that don't need the database ----

describe('normalizeForLookup', () => {
  test('emails ignore upper/lower case', () => {
    assert.equal(normalizeForLookup('EMAIL', ' Rahul@ABC.com '), 'rahul@abc.com');
  });
  test('Aadhaar / phone / account numbers ignore spaces and dashes', () => {
    assert.equal(normalizeForLookup('AADHAAR', '2345 6789 0124'), '234567890124');
    assert.equal(normalizeForLookup('PHONE', '+91 98765-43210'), '919876543210');
  });
  test('PAN ignores case', () => {
    assert.equal(normalizeForLookup('PAN', 'abcpe1234f'), 'ABCPE1234F');
  });
  test('secrets are kept EXACTLY (one different character = different secret)', () => {
    assert.equal(normalizeForLookup('API_KEY', 'AbC123'), 'AbC123');
  });
});

describe('isValidSessionId', () => {
  test('accepts UUIDs', () => assert.equal(isValidSessionId(randomUUID()), true));
  test('rejects short, empty or unsafe IDs', () => {
    assert.equal(isValidSessionId('abc'), false);
    assert.equal(isValidSessionId(''), false);
    assert.equal(isValidSessionId('{"$gt":""}xxxxxxxxxxxxx'), false); // NoSQL-injection-shaped input
    assert.equal(isValidSessionId(42), false);
  });
});

// ---- Tests that use Atlas ----

describe('vault (MongoDB Atlas)', { skip: SKIP_WITHOUT_DB }, () => {
  before(() => connectTestDb('vault'));
  after(() => dropTestDb());

  test('numbers values per type: EMAIL_1, EMAIL_2, PAN_1', async () => {
    const s = newSession();
    assert.equal(await vault.getOrCreatePlaceholder(s, 'EMAIL', 'rahul@abc.com'), '[[EMAIL_1]]');
    assert.equal(await vault.getOrCreatePlaceholder(s, 'EMAIL', 'priya@xyz.in'), '[[EMAIL_2]]');
    assert.equal(await vault.getOrCreatePlaceholder(s, 'PAN', 'ABCPE1234F'), '[[PAN_1]]');
  });

  test('the same value always gets the same tag (even written differently)', async () => {
    const s = newSession();
    const first = await vault.getOrCreatePlaceholder(s, 'EMAIL', 'rahul@abc.com');
    const again = await vault.getOrCreatePlaceholder(s, 'EMAIL', 'rahul@abc.com');
    const otherCase = await vault.getOrCreatePlaceholder(s, 'EMAIL', 'Rahul@ABC.com');
    assert.equal(again, first);
    assert.equal(otherCase, first);
  });

  test('reveal gives back the ORIGINAL text, as first written', async () => {
    const s = newSession();
    const tag = await vault.getOrCreatePlaceholder(s, 'AADHAAR', '2345 6789 0124');
    const revealed = await vault.revealPlaceholders(s, [tag]);
    assert.equal(revealed.get(tag), '2345 6789 0124');
  });

  test('unknown tags are simply left out', async () => {
    const s = newSession();
    await vault.getOrCreatePlaceholder(s, 'EMAIL', 'rahul@abc.com');
    const revealed = await vault.revealPlaceholders(s, ['[[EMAIL_1]]', '[[EMAIL_99]]', '[[PAN_1]]']);
    assert.deepEqual([...revealed.keys()], ['[[EMAIL_1]]']);
  });

  test('sessions are isolated: one session cannot reveal another session\'s values', async () => {
    const alice = newSession();
    const bob = newSession();
    assert.equal(await vault.getOrCreatePlaceholder(alice, 'EMAIL', 'alice@abc.com'), '[[EMAIL_1]]');
    assert.equal(await vault.getOrCreatePlaceholder(bob, 'EMAIL', 'bob@abc.com'), '[[EMAIL_1]]');

    assert.equal((await vault.revealPlaceholders(alice, ['[[EMAIL_1]]'])).get('[[EMAIL_1]]'), 'alice@abc.com');
    assert.equal((await vault.revealPlaceholders(bob, ['[[EMAIL_1]]'])).get('[[EMAIL_1]]'), 'bob@abc.com');
  });

  test('ATLAS NEVER SEES THE REAL VALUE: the stored document has only ciphertext', async () => {
    const s = newSession();
    await vault.getOrCreatePlaceholder(s, 'EMAIL', 'secret.person@abc.com');
    // Read the raw document straight from the collection, exactly as Atlas stores it.
    const raw = await mongoose.connection.collection('vault').findOne({ sessionId: s });
    const everythingStored = JSON.stringify(raw) + raw.ciphertext.buffer.toString('utf8');
    assert.ok(!everythingStored.includes('secret.person'), 'plain email found in the database!');
    assert.ok(!everythingStored.toLowerCase().includes('abc.com'), 'plain domain found in the database!');
  });

  test('values expire together with their session (24 h)', async () => {
    const s = newSession();
    await vault.getOrCreatePlaceholder(s, 'EMAIL', 'rahul@abc.com');
    const entry = await VaultEntry.findOne({ sessionId: s });
    const session = await Session.findById(s);
    const hoursLeft = (entry.expiresAt - Date.now()) / 3_600_000;
    assert.ok(hoursLeft > 23.9 && hoursLeft <= 24, `expected ~24 h, got ${hoursLeft}`);
    assert.equal(entry.expiresAt.getTime(), session.expiresAt.getTime());
  });

  test('RACE: 10 requests storing the same value at once all get ONE tag', async () => {
    const s = newSession();
    const tags = await Promise.all(
      Array.from({ length: 10 }, () => vault.getOrCreatePlaceholder(s, 'PHONE', '9876543210')),
    );
    assert.equal(new Set(tags).size, 1, `got different tags: ${[...new Set(tags)]}`);
    assert.equal(await VaultEntry.countDocuments({ sessionId: s }), 1);
  });

  test('RACE: 10 DIFFERENT values at once all get DIFFERENT tags', async () => {
    const s = newSession();
    const tags = await Promise.all(
      Array.from({ length: 10 }, (_, i) => vault.getOrCreatePlaceholder(s, 'EMAIL', `user${i}@abc.com`)),
    );
    assert.equal(new Set(tags).size, 10);
  });

  test('TAMPERING in the database: a changed ciphertext is NOT revealed', async () => {
    const s = newSession();
    const tag = await vault.getOrCreatePlaceholder(s, 'PAN', 'ABCPE1234F');
    // Simulate an attacker editing the stored ciphertext directly in Atlas.
    const entry = await VaultEntry.findOne({ sessionId: s });
    const changed = Buffer.from(entry.ciphertext);
    changed[0] ^= 1;
    await VaultEntry.updateOne({ _id: entry._id }, { ciphertext: changed });

    const revealed = await vault.revealPlaceholders(s, [tag]);
    assert.equal(revealed.has(tag), false);
  });

  test('a vault with a DIFFERENT master key cannot read the values', async () => {
    const s = newSession();
    const tag = await vault.getOrCreatePlaceholder(s, 'EMAIL', 'rahul@abc.com');
    const attackerVault = createVault({ masterKey: randomBytes(32) });
    const revealed = await attackerVault.revealPlaceholders(s, [tag]);
    assert.equal(revealed.size, 0);
  });

  test('forgetSession deletes everything for that session right away', async () => {
    const s = newSession();
    await vault.getOrCreatePlaceholder(s, 'EMAIL', 'rahul@abc.com');
    await vault.getOrCreatePlaceholder(s, 'PAN', 'ABCPE1234F');
    assert.equal(await vault.forgetSession(s), 2);
    assert.equal(await VaultEntry.countDocuments({ sessionId: s }), 0);
    assert.equal(await Session.countDocuments({ _id: s }), 0);
  });

  test('rejects bad input', async () => {
    await assert.rejects(vault.getOrCreatePlaceholder('short', 'EMAIL', 'a@b.co'), /session ID/);
    await assert.rejects(vault.getOrCreatePlaceholder(newSession(), 'NOT_A_TYPE', 'x'), /Unknown entity type/);
    await assert.rejects(vault.getOrCreatePlaceholder(newSession(), 'EMAIL', ''), /non-empty/);
  });
});
