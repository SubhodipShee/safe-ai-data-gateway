// Tests for Phase 6: names (local AI model) and addresses (PIN-code rules).
// The name tests need the downloaded model in gateway/.models (or internet to
// download it); without it they are skipped. Masker tests also need Atlas.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { detect } from '../src/detectors/index.js';
import { findAddresses } from '../src/detectors/address.js';
import { createNameFinder } from '../src/ai/name-finder.js';
import { createVault, normalizeForLookup } from '../src/vault.js';
import { createMasker } from '../src/masker.js';
import { createAuditChain } from '../src/audit/audit-chain.js';
import { clearPolicyCache } from '../src/policies.js';
import { seedDefaultPolicies } from '../src/models/Policy.js';
import { connectTestDb, dropTestDb, hasDatabase } from './test-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const nameFinder = createNameFinder({ cacheDir: path.join(here, '..', '.models') });
await nameFinder.load();
const modelReady = nameFinder.status === 'ready';
const SKIP_WITHOUT_MODEL = modelReady ? false : 'AI model not available (no cache and no internet)';

const addresses = (text) => findAddresses(text).map((f) => f.value);
const names = async (text) => (await nameFinder.find(text)).map((f) => f.value);

// ---- Addresses (rules, always run) ----

describe('ADDRESS (PIN-code rules)', () => {
  test('a full address ending in a PIN code', () => {
    assert.deepEqual(addresses('Ship to Flat 4B, Salt Lake Sector V, Kolkata 700091 by Monday'),
      ['Flat 4B, Salt Lake Sector V, Kolkata 700091']);
  });
  test('street name and house number BEFORE the address word ("12, MG Road")', () => {
    assert.deepEqual(addresses('12, MG Road, Bengaluru - 560 001'), ['12, MG Road, Bengaluru - 560 001']);
    assert.deepEqual(addresses('Deliver to 45 Park Street, Kolkata 700016'), ['45 Park Street, Kolkata 700016']);
  });
  test('Hyderabad-style house numbers and office addresses', () => {
    assert.deepEqual(addresses('lives in H.No 5-2-187, Gandhi Nagar, Hyderabad 500080.'),
      ['H.No 5-2-187, Gandhi Nagar, Hyderabad 500080']);
    assert.deepEqual(addresses('Office: 3rd Floor, Tower B, DLF Cyber City, Gurugram 122002'),
      ['3rd Floor, Tower B, DLF Cyber City, Gurugram 122002']);
  });
  test('a labelled PIN on its own', () => {
    assert.deepEqual(addresses('PIN: 700091'), ['700091']);
  });
  test('"Address:" label without a PIN', () => {
    assert.deepEqual(addresses('Address: 221B Baker Street, London'), ['221B Baker Street, London']);
  });
  test('NOT an address: OTPs, amounts and other 6-digit numbers', () => {
    assert.deepEqual(addresses('Your OTP is 482913'), []);
    assert.deepEqual(addresses('Revenue was 560001 rupees this quarter'), []);
    assert.deepEqual(addresses('Order 700091 shipped'), []);
  });
  test('detect() returns addresses as type ADDRESS', () => {
    assert.deepEqual(detect('Ship to Flat 4B, Salt Lake Sector V, Kolkata 700091').map((f) => f.type), ['ADDRESS']);
  });
  test('the vault treats differently-spaced names/addresses as the same value', () => {
    assert.equal(normalizeForLookup('PERSON', '  Rahul   VERMA '), normalizeForLookup('PERSON', 'rahul verma'));
  });
});

// ---- Names (local AI model) ----

describe('PERSON (local AI model)', { skip: SKIP_WITHOUT_MODEL }, () => {
  test('finds full names', async () => {
    assert.deepEqual(await names('Draft a refund email for our customer Rahul Verma today.'), ['Rahul Verma']);
  });
  test('finds names from different Indian regions', async () => {
    const found = await names('Please call Subrata Banerjee and Ananya Iyer. Also cc Mohammed Irfan and Dr. Kavita Reddy.');
    assert.deepEqual(found, ['Subrata Banerjee', 'Ananya Iyer', 'Mohammed Irfan', 'Kavita Reddy']);
  });
  test('finds the same name every time it appears', async () => {
    assert.deepEqual(await names('Rahul said the invoice for Rahul is ready.'), ['Rahul', 'Rahul']);
  });
  test('positions point exactly at the name in the ORIGINAL text', async () => {
    const text = 'Hello, Priya Shah here.';
    const [finding] = await nameFinder.find(text);
    assert.equal(text.slice(finding.start, finding.end), 'Priya Shah');
    assert.ok(finding.confidence >= 0.85);
  });
  test('NOT names: places, companies, normal sentences and code', async () => {
    assert.deepEqual(await names('Summarise our Q3 meeting: revenue grew 12% and we hired 4 engineers in Kolkata.'), []);
    assert.deepEqual(await names('ACME Payments and Infosys signed a contract in Bengaluru.'), []);
    assert.deepEqual(await names('const user = getUserById(id); if (!user) throw new Error("not found");'), []);
  });
  test('NOT names: ID words like "Aadhaar" before a number (found on the live site)', async () => {
    assert.deepEqual(await names('Refund Rahul Verma, rahul@gmail.com, PAN ABCPE1234F, Aadhaar 2345 6789 0124'), ['Rahul Verma']);
  });
  test('long texts are split into chunks and names are found in every chunk', async () => {
    const filler = 'The quarterly numbers look fine and nothing else needs review. '.repeat(40);
    const found = await names(`Rahul Verma wrote this. ${filler} Signed, Priya Shah.`);
    assert.deepEqual(found, ['Rahul Verma', 'Priya Shah']);
  });
});

describe('masker with names (AI model + Atlas)', { skip: !modelReady ? SKIP_WITHOUT_MODEL : !hasDatabase && 'no MONGODB_URI' }, () => {
  const masterKey = randomBytes(32);
  let masker;

  before(async () => {
    await connectTestDb('names');
    await seedDefaultPolicies();
    clearPolicyCache();
    masker = createMasker({ vault: createVault({ masterKey }), auditChain: createAuditChain({ masterKey }), nameFinder });
  });
  after(() => dropTestDb());

  test('names and addresses are masked and restored', async () => {
    const sessionId = randomUUID();
    const text = 'Write to Rahul Verma at Flat 4B, Salt Lake Sector V, Kolkata 700091. Rahul prefers email.';
    const masked = await masker.maskText({ sessionId, text });
    assert.equal(masked.maskedText, 'Write to [[PERSON_1]] at [[ADDRESS_1]]. [[PERSON_2]] prefers email.');

    const restored = await masker.unmaskText({ sessionId, text: masked.maskedText });
    assert.equal(restored.text, text);
  });

  test('a name inside an email address stays one EMAIL (longer finding wins)', async () => {
    const masked = await masker.maskText({ sessionId: randomUUID(), text: 'Contact Priya Shah via priya.shah@acme.in' });
    assert.equal(masked.maskedText, 'Contact [[PERSON_1]] via [[EMAIL_1]]');
  });
});
