// Tests for crypto/keys.js and crypto/vault-crypto.js.
// These don't need the database, so they run anywhere.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deriveSessionKeys } from '../src/crypto/keys.js';
import { encryptValue, decryptValue, hmacValue } from '../src/crypto/vault-crypto.js';

const masterKey = randomBytes(32);

describe('deriveSessionKeys (HKDF)', () => {
  test('gives 32-byte keys', () => {
    const { encryptionKey, hmacKey } = deriveSessionKeys(masterKey, 'session-aaaaaaaaaaaa');
    assert.equal(encryptionKey.length, 32);
    assert.equal(hmacKey.length, 32);
  });

  test('same master key + same session → same keys (so we never need to store them)', () => {
    const first = deriveSessionKeys(masterKey, 'session-aaaaaaaaaaaa');
    const second = deriveSessionKeys(masterKey, 'session-aaaaaaaaaaaa');
    assert.deepEqual(first, second);
  });

  test('different sessions → completely different keys', () => {
    const a = deriveSessionKeys(masterKey, 'session-aaaaaaaaaaaa');
    const b = deriveSessionKeys(masterKey, 'session-bbbbbbbbbbbb');
    assert.notDeepEqual(a.encryptionKey, b.encryptionKey);
    assert.notDeepEqual(a.hmacKey, b.hmacKey);
  });

  test('the encryption key and the lookup key are different', () => {
    const { encryptionKey, hmacKey } = deriveSessionKeys(masterKey, 'session-aaaaaaaaaaaa');
    assert.notDeepEqual(encryptionKey, hmacKey);
  });

  test('different master key → different keys', () => {
    const a = deriveSessionKeys(masterKey, 'session-aaaaaaaaaaaa');
    const b = deriveSessionKeys(randomBytes(32), 'session-aaaaaaaaaaaa');
    assert.notDeepEqual(a.encryptionKey, b.encryptionKey);
  });
});

describe('encryptValue / decryptValue (AES-256-GCM)', () => {
  const key = randomBytes(32);
  const context = 'session-1|[[EMAIL_1]]';

  test('decrypting gives back the original text', () => {
    const encrypted = encryptValue(key, 'rahul@abc.com', context);
    assert.equal(decryptValue(key, encrypted, context), 'rahul@abc.com');
  });

  test('works with Hindi, Bengali and emoji text', () => {
    const text = 'राहुल वर्मा · রাহুল · 🔐';
    assert.equal(decryptValue(key, encryptValue(key, text, context), context), text);
  });

  test('the ciphertext does not contain the original text', () => {
    const encrypted = encryptValue(key, 'rahul@abc.com', context);
    assert.ok(!encrypted.ciphertext.toString('utf8').includes('rahul'));
  });

  test('IV is 12 bytes and the tamper seal is 16 bytes', () => {
    const encrypted = encryptValue(key, 'x', context);
    assert.equal(encrypted.iv.length, 12);
    assert.equal(encrypted.authTag.length, 16);
  });

  test('encrypting the same text twice gives different results (random IV)', () => {
    const a = encryptValue(key, 'rahul@abc.com', context);
    const b = encryptValue(key, 'rahul@abc.com', context);
    assert.notDeepEqual(a.iv, b.iv);
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
  });

  test('TAMPERING: changing one bit of the ciphertext makes decryption fail', () => {
    const encrypted = encryptValue(key, 'rahul@abc.com', context);
    encrypted.ciphertext[0] ^= 1; // flip one bit
    assert.throws(() => decryptValue(key, encrypted, context));
  });

  test('TAMPERING: a changed tamper seal makes decryption fail', () => {
    const encrypted = encryptValue(key, 'rahul@abc.com', context);
    encrypted.authTag[0] ^= 1;
    assert.throws(() => decryptValue(key, encrypted, context));
  });

  test('SWAPPING: a value moved to a different tag or session fails to decrypt', () => {
    const encrypted = encryptValue(key, 'rahul@abc.com', 'session-1|[[EMAIL_1]]');
    assert.throws(() => decryptValue(key, encrypted, 'session-1|[[EMAIL_2]]'));
    assert.throws(() => decryptValue(key, encrypted, 'session-2|[[EMAIL_1]]'));
  });

  test('the wrong key fails to decrypt', () => {
    const encrypted = encryptValue(key, 'rahul@abc.com', context);
    assert.throws(() => decryptValue(randomBytes(32), encrypted, context));
  });
});

describe('hmacValue (fingerprints)', () => {
  const key = randomBytes(32);

  test('same text + same key → same fingerprint', () => {
    assert.equal(hmacValue(key, 'EMAIL:rahul@abc.com'), hmacValue(key, 'EMAIL:rahul@abc.com'));
  });

  test('is 64 hex characters and does not contain the text', () => {
    const fingerprint = hmacValue(key, 'EMAIL:rahul@abc.com');
    assert.match(fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(!fingerprint.includes('rahul'));
  });

  test('a different key gives a different fingerprint (useless without the key)', () => {
    assert.notEqual(hmacValue(key, 'EMAIL:rahul@abc.com'), hmacValue(randomBytes(32), 'EMAIL:rahul@abc.com'));
  });
});
