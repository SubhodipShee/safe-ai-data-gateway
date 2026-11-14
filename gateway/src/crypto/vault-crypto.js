// =============================================================================
// crypto/vault-crypto.js: encrypts and decrypts values; makes lookup fingerprints
// =============================================================================
//
// 1. ENCRYPTION: AES-256-GCM
//    Turns  "rahul@abc.com"  into unreadable bytes (the "ciphertext"), and back.
//
//      encryptValue(key, "rahul@abc.com", context)
//        → { ciphertext: <13 random-looking bytes>,
//            iv:         <12 random bytes>,
//            authTag:    <16 bytes> }
//
//    - IV ("initialisation vector"): a fresh random number for EVERY encryption.
//      Encrypting the same email twice gives two DIFFERENT ciphertexts, so
//      an attacker can't tell that two rows hold the same value.
//    - authTag: a tamper seal. If anyone changes even one bit of the ciphertext
//      in the database, decryption FAILS instead of returning wrong data.
//    - context ("additional authenticated data"): we seal the session ID and the
//      placeholder INTO the authTag. If someone copies an encrypted value from
//      one row to another (e.g. to swap [[EMAIL_1]] and [[EMAIL_2]]), decryption fails.
//
// 2. FINGERPRINT: HMAC-SHA256
//    Turns  "rahul@abc.com"  into a fixed fingerprint like "9c1e4f…".
//    - The same value + key ALWAYS gives the same fingerprint, so we can ask the
//      database "have we seen this email before in this session?"
//    - It can't be reversed, and without the key nobody can compute it, so
//      the fingerprint reveals nothing about the email.
// =============================================================================

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; //       12 bytes is the recommended IV size for GCM
const AUTH_TAG_LENGTH_BYTES = 16; // 16 bytes = the full-strength tamper seal

/**
 * Encrypts a piece of text.
 *
 * @param {Buffer} key        32-byte encryption key (from keys.js)
 * @param {string} plaintext  the real value, e.g. "rahul@abc.com"
 * @param {string} context    extra data sealed into the tag, e.g. "sessionId|[[EMAIL_1]]"
 * @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer }}
 */
export function encryptValue(key, plaintext, context) {
  // A brand-new random IV for every encryption. NEVER reuse one with the same key.
  const iv = randomBytes(IV_LENGTH_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));

  // update() encrypts the text; final() finishes off the encryption.
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  // The tamper seal is only available after final().
  const authTag = cipher.getAuthTag();

  return { ciphertext, iv, authTag };
}

/**
 * Decrypts a value encrypted by encryptValue().
 * THROWS an error if the key, context, ciphertext, IV or tag is wrong (tampering detected).
 *
 * @param {Buffer} key
 * @param {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer }} encrypted
 * @param {string} context  must be exactly the same context used when encrypting
 * @returns {string} the original text
 */
export function decryptValue(key, encrypted, context) {
  const decipher = createDecipheriv(ALGORITHM, key, encrypted.iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(encrypted.authTag);

  // final() is where the tamper seal is checked; it throws if anything was changed.
  const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Makes a fingerprint (HMAC-SHA256) of a piece of text.
 * Example: hmacValue(key, "EMAIL:rahul@abc.com") → "9c1e4f…" (64 hex characters)
 */
export function hmacValue(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}
