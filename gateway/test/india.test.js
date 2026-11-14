import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detect, summarize } from '../src/detectors/index.js';
import { gstinCheckChar, isValidGstin } from '../src/detectors/india.js';

/** Values detected as `type` in `text`. */
const found = (text, type) => detect(text).filter((f) => f.type === type).map((f) => f.value);
const types = (text) => detect(text).map((f) => f.type);

describe('GSTIN (mod-36 checksum)', () => {
  test('validates publicly listed GSTINs', () => {
    for (const g of ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4', '07AAGFF2194N1Z1']) {
      assert.equal(isValidGstin(g), true, g);
    }
  });
  test('finds a GSTIN and reports it as GSTIN, not as the PAN inside it', () => {
    assert.deepEqual(types('GSTIN: 27AAPFU0939F1ZV.'), ['GSTIN']);
    assert.deepEqual(found('gst 29aagcb7383j1z4', 'GSTIN'), ['29aagcb7383j1z4']);
  });
  test('rejects a wrong check character', () => {
    assert.deepEqual(detect('27AAPFU0939F1ZW'), []);
  });
  test('rejects an invalid state code even with a correct checksum', () => {
    const body = '00AAPFU0939F1Z';
    assert.deepEqual(detect(body + gstinCheckChar(body)), []);
  });
});

describe('UPI_ID', () => {
  test('finds UPI IDs with known bank/app handles', () => {
    assert.deepEqual(found('pay rahul.verma@okaxis now', 'UPI_ID'), ['rahul.verma@okaxis']);
    assert.deepEqual(found('GPay 9876543210@ybl', 'UPI_ID'), ['9876543210@ybl']);
    assert.deepEqual(found('shop@paytm.', 'UPI_ID'), ['shop@paytm']);
  });
  test('a mobile-number UPI ID is one UPI_ID, not a PHONE', () => {
    assert.deepEqual(types('send to 9876543210@ybl'), ['UPI_ID']);
  });
  test('finds unknown handles only when "UPI" or "VPA" is written before', () => {
    assert.deepEqual(found('UPI: store@newbank', 'UPI_ID'), ['store@newbank']);
    assert.deepEqual(found('ssh root@server', 'UPI_ID'), []);
  });
  test('emails stay EMAIL', () => {
    assert.deepEqual(types('rahul@abc.com'), ['EMAIL']);
  });
});

describe('IFSC', () => {
  test('finds IFSC codes', () => {
    assert.deepEqual(found('IFSC SBIN0001234', 'IFSC'), ['SBIN0001234']);
    assert.deepEqual(found('branch HDFC0ABC123.', 'IFSC'), ['HDFC0ABC123']);
  });
  test('rejects codes whose 5th character is not 0', () => {
    assert.deepEqual(found('SBIN1001234', 'IFSC'), []);
  });
});

describe('BANK_ACCOUNT (needs a keyword before it)', () => {
  test('finds account numbers next to account keywords', () => {
    assert.deepEqual(found('A/c no: 50100123456789', 'BANK_ACCOUNT'), ['50100123456789']);
    assert.deepEqual(found('account number 123456789012', 'BANK_ACCOUNT'), ['123456789012']);
    assert.deepEqual(found('Acct 000123456789', 'BANK_ACCOUNT'), ['000123456789']);
  });
  test('a 10-digit number after "account" is a BANK_ACCOUNT, not a PHONE', () => {
    assert.deepEqual(types('Account 9876543210'), ['BANK_ACCOUNT']);
  });
  test('ignores long numbers without an account keyword', () => {
    assert.deepEqual(detect('invoice ref 50100123456789'), []);
  });
  test('finds account + IFSC together', () => {
    assert.deepEqual(summarize(detect('Account 50100123456789, IFSC HDFC0001234')), { BANK_ACCOUNT: 1, IFSC: 1 });
  });
});

describe('VOTER_ID (needs a keyword)', () => {
  test('finds EPIC numbers after voter/EPIC keywords', () => {
    assert.deepEqual(found('Voter ID: ABC1234567', 'VOTER_ID'), ['ABC1234567']);
    assert.deepEqual(found('EPIC no XYZ7654321', 'VOTER_ID'), ['XYZ7654321']);
  });
  test('ignores the same pattern without a keyword', () => {
    assert.deepEqual(detect('batch ABC1234567'), []);
  });
});

describe('PASSPORT (needs a keyword)', () => {
  test('finds Indian passport numbers after "passport"', () => {
    assert.deepEqual(found('Passport No. K1234567', 'PASSPORT'), ['K1234567']);
  });
  test('rejects letters Q, X, Z and numbers without the keyword', () => {
    assert.deepEqual(found('passport Q1234567', 'PASSPORT'), []);
    assert.deepEqual(detect('model K1234567'), []);
  });
});

describe('DRIVING_LICENCE', () => {
  test('finds licences in common formats', () => {
    assert.deepEqual(found('DL: MH14 20110062821', 'DRIVING_LICENCE'), ['MH14 20110062821']);
    assert.deepEqual(found('licence MH-1420110062821', 'DRIVING_LICENCE'), ['MH-1420110062821']);
    assert.deepEqual(found('WB0620190001234', 'DRIVING_LICENCE'), ['WB0620190001234']);
  });
  test('rejects unknown state codes and impossible years', () => {
    assert.deepEqual(found('ZZ14 20110062821', 'DRIVING_LICENCE'), []);
    assert.deepEqual(found('MH14 18500062821', 'DRIVING_LICENCE'), []);
  });
});

describe('realistic Indian KYC paste', () => {
  test('catches every identifier once', () => {
    const text = [
      'Customer KYC: Rahul Verma, rahul.verma@gmail.com, +91 98765 43210',
      'PAN ABCPE1234F, GSTIN 27AAPFU0939F1ZV, Voter ID ABC1234567, Passport K1234567',
      'DL MH14 20110062821, UPI rahul@okicici',
      'Bank: A/c 50100123456789, IFSC HDFC0001234',
    ].join('\n');
    assert.deepEqual(summarize(detect(text)), {
      EMAIL: 1, PHONE: 1, PAN: 1, GSTIN: 1, VOTER_ID: 1, PASSPORT: 1,
      DRIVING_LICENCE: 1, UPI_ID: 1, BANK_ACCOUNT: 1, IFSC: 1,
    });
  });
});
