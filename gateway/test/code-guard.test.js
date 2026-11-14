// Tests for Phase 5: private code leak detection (winnowing fingerprints).
// Uses Atlas database "safe-ai-gateway-test-code" (deleted afterwards).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { tokenize, fingerprint, K, W } from '../src/code/fingerprint.js';
import { createCodeGuard } from '../src/code/code-guard.js';
import { createVault } from '../src/vault.js';
import { createMasker } from '../src/masker.js';
import { createAuditChain } from '../src/audit/audit-chain.js';
import { clearPolicyCache } from '../src/policies.js';
import { seedDefaultPolicies } from '../src/models/Policy.js';
import { CodeFile } from '../src/models/CodeFile.js';
import { connectTestDb, dropTestDb, SKIP_WITHOUT_DB } from './test-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_REPO = path.join(here, '..', '..', 'demo', 'acme-payments', 'src');
const REFUND_JS = await fs.readFile(path.join(DEMO_REPO, 'refund-service.js'), 'utf8');
const FRAUD_PY = await fs.readFile(path.join(DEMO_REPO, 'fraud_score.py'), 'utf8');

const key = randomBytes(32);
const hashes = (code) => new Set(fingerprint(key, code).map((f) => f.hash));
const shared = (a, b) => [...hashes(a)].filter((h) => hashes(b).has(h)).length;

// The SAME logic as calculateRefund, but disguised: every name changed, no
// semicolons, different quotes, extra comments and different indentation.
const DISGUISED_REFUND = `
async function getRefundValue(o, p) {
    // compute the refund
    const d = daysSince(o.deliveredAt)
    if (d > (p.maxDays ?? WINDOW)) {
        throw new Error("too late")   /* nope */
    }
    let amt = o.total - o.shippingFee
    if (o.coupon) {
        amt = amt * (1 - o.coupon.discount)
    }
    if (o.paymentMethod === "upi" && o.cashbackApplied) {
        amt -= o.cashbackAmount
    }
    return Math.round(amt * 100) / 100
}`;

// Completely different code that does something else.
const UNRELATED_CODE = `
export function renderInvoice(invoice, template) {
  const rows = invoice.lines.map((line) => template.row(line.description, line.quantity, line.price));
  const subtotal = invoice.lines.reduce((sum, line) => sum + line.quantity * line.price, 0);
  const tax = subtotal * invoice.taxRate;
  return template.page({ rows, subtotal, tax, total: subtotal + tax, dueDate: invoice.dueDate });
}`;

// ---- Fingerprinting (no database) ----

describe('tokenize', () => {
  test('names become V, numbers N, strings S; keywords and operators stay', () => {
    const tokens = tokenize('if (total > 500) { return "big"; }').map((t) => t.token).join(' ');
    assert.equal(tokens, 'if ( V > N ) { return S }');
  });
  test('comments are ignored in every common style', () => {
    const code = 'x = 1 // a\n/* b */ y = 2 # c\n<!-- d -->';
    assert.deepEqual(tokenize(code).map((t) => t.token), ['V', '=', 'N', 'V', '=', 'N']);
  });
  test('JavaScript private fields (#name) are not mistaken for comments', () => {
    assert.ok(tokenize('this.#secret = 1').length >= 3);
  });
});

describe('fingerprint (winnowing)', () => {
  test('renamed + reformatted + re-commented code has the SAME fingerprints', () => {
    const original = REFUND_JS.slice(REFUND_JS.indexOf('let amount'), REFUND_JS.indexOf('export async function processRefund'));
    const disguised = original.replaceAll('amount', 'x').replaceAll('order', 'o').replaceAll(';', '').replaceAll('  ', '\t');
    assert.equal(shared(original, disguised), hashes(original).size);
  });
  test('the disguised refund function shares most fingerprints with the real file', () => {
    const disguised = hashes(DISGUISED_REFUND);
    const overlap = shared(DISGUISED_REFUND, REFUND_JS);
    assert.ok(overlap / disguised.size > 0.6, `only ${overlap}/${disguised.size} shared`);
  });
  test(`GUARANTEE: any shared run of W + K − 1 = ${W + K - 1} tokens shares a fingerprint`, () => {
    // Build random token streams that share exactly one run of W + K − 1 tokens.
    const word = () => ['if', 'return', '(', ')', '+', 'x', '1', '"s"', '{', '}', '.', '*'][Math.floor(Math.random() * 12)];
    for (let trial = 0; trial < 50; trial++) {
      const common = Array.from({ length: W + K - 1 }, word).join(' ');
      const a = `${Array.from({ length: 40 }, word).join(' ')} ; ${common} ; ${Array.from({ length: 40 }, word).join(' ')}`;
      const b = `while ${common} while`;
      assert.ok(shared(a, b) >= 1, `trial ${trial} missed a shared run`);
    }
  });
  test('unrelated code shares (almost) nothing', () => {
    assert.ok(shared(UNRELATED_CODE, REFUND_JS) <= 1);
  });
  test('a different key gives completely different fingerprints', () => {
    const other = new Set(fingerprint(randomBytes(32), REFUND_JS).map((f) => f.hash));
    assert.equal([...hashes(REFUND_JS)].filter((h) => other.has(h)).length, 0);
  });
});

// ---- Registry + detection (Atlas) ----

describe('code guard (MongoDB Atlas)', { skip: SKIP_WITHOUT_DB }, () => {
  const masterKey = randomBytes(32);
  const guard = createCodeGuard({ masterKey });

  before(async () => {
    await connectTestDb('code');
    await CodeFile.init();
    await guard.registerFile('acme-payments', 'src/refund-service.js', REFUND_JS);
    await guard.registerFile('acme-payments', 'src/fraud_score.py', FRAUD_PY);
  });
  after(() => dropTestDb());

  test('an exact copy of a registered file is caught and attributed to it', async () => {
    const [finding] = await guard.check(`Please review:\n${REFUND_JS}`);
    assert.equal(finding.type, 'PRIVATE_CODE');
    assert.equal(finding.label, 'acme-payments/src/refund-service.js');
    assert.ok(finding.similarity > 0.9);
  });

  test('a RENAMED and REFORMATTED copy is caught', async () => {
    const findings = await guard.check(`Can you optimise this?\n${DISGUISED_REFUND}`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].label, 'acme-payments/src/refund-service.js');
  });

  test('the finding covers the code, not the question around it', async () => {
    const text = `Can you optimise this?\n${DISGUISED_REFUND}\nThanks!`;
    const [finding] = await guard.check(text);
    assert.ok(!finding.value.includes('Can you optimise'));
    assert.ok(!finding.value.includes('Thanks!'));
    assert.ok(finding.value.includes('getRefundValue'));
  });

  test('a PARTIAL copy (one function from the middle of a file) is caught', async () => {
    const part = FRAUD_PY.slice(FRAUD_PY.indexOf('def amount_score'), FRAUD_PY.indexOf('def fraud_score'));
    const [finding] = await guard.check(`why is this slow?\n${part}`);
    assert.equal(finding?.label, 'acme-payments/src/fraud_score.py');
  });

  test('Python code with renamed variables is caught', async () => {
    const renamed = FRAUD_PY.replaceAll('score', 'pts').replaceAll('txn', 't').replaceAll('history', 'h');
    const [finding] = await guard.check(renamed);
    assert.equal(finding?.label, 'acme-payments/src/fraud_score.py');
  });

  test('code hidden with invisible characters is still caught (Phase 3.5)', async () => {
    const hidden = DISGUISED_REFUND.replaceAll('=', '​=');
    assert.equal((await guard.check(hidden)).length, 1);
  });

  test('NOT flagged: unrelated code, generic snippets and normal text', async () => {
    assert.deepEqual(await guard.check(UNRELATED_CODE), []);
    assert.deepEqual(await guard.check('for (let i = 0; i < items.length; i++) { total += items[i].price; }'), []);
    assert.deepEqual(await guard.check('Please summarise the refund policy for our customers in simple words.'), []);
  });

  test('a gateway with a DIFFERENT master key finds nothing (fingerprints are keyed)', async () => {
    const otherGuard = createCodeGuard({ masterKey: randomBytes(32) });
    assert.deepEqual(await otherGuard.check(REFUND_JS), []);
  });

  test('NO SOURCE CODE is stored in the database: only numbers', async () => {
    const stored = JSON.stringify(await mongoose.connection.collection('codefiles').find().toArray());
    for (const word of ['calculateRefund', 'shippingFee', 'velocity_score', 'Refund window closed', 'return']) {
      assert.ok(!stored.includes(word), `found "${word}" in the database`);
    }
  });

  test('registering the same file again is skipped as "unchanged"', async () => {
    assert.equal((await guard.registerFile('acme-payments', 'src/refund-service.js', REFUND_JS)).status, 'unchanged');
  });

  test('stats show the protected repo', async () => {
    const { repos } = await guard.stats();
    assert.deepEqual(repos.map((r) => [r.repo, r.files]), [['acme-payments', 2]]);
  });

  test('MASKER: pasted private code is BLOCKED by default and logged', async () => {
    await seedDefaultPolicies();
    clearPolicyCache();
    const masker = createMasker({
      vault: createVault({ masterKey }),
      auditChain: createAuditChain({ masterKey }),
      codeGuard: guard,
    });
    const result = await masker.maskText({
      sessionId: randomUUID(),
      text: `My email is dev@acme.in, optimise this:\n${DISGUISED_REFUND}`,
      source: 'chatgpt.com',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.blockedTypes.PRIVATE_CODE, 1);
    assert.deepEqual(result.blockedItems.find((i) => i.type === 'PRIVATE_CODE').label, 'acme-payments/src/refund-service.js');
  });

  test('unregistering a repo stops the protection', async () => {
    await guard.unregisterRepo('acme-payments');
    assert.deepEqual(await guard.check(REFUND_JS), []);
  });
});
