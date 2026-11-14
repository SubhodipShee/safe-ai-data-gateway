// =============================================================================
// crypto/keys.js: makes a separate set of keys for every chat session
// =============================================================================
//
// THE PROBLEM
// We have ONE master key (MASTER_KEY in .env). If we encrypted every value in
// every conversation with that same key, then one leaked key would expose
// everything.
//
// THE SOLUTION: HKDF ("HMAC-based Key Derivation Function")
// HKDF takes the master key plus some extra input and produces a NEW key.
// Same inputs always give the same key; different inputs give unrelated keys.
//
//   master key + "session A" + "encryption" → key 1   (encrypts session A's values)
//   master key + "session A" + "lookup"     → key 2   (HMAC for session A, see vault-crypto.js)
//   master key + "session B" + "encryption" → key 3   (completely different from key 1)
//
// Benefits:
//   - Every session gets its own keys, but we never have to STORE them:
//     we can recreate them any time from the master key + session ID.
//   - Knowing one session's key reveals nothing about another session's key.
//   - The encryption key and the lookup key are different, so each is used for one job only.
// =============================================================================

import { hkdfSync } from 'node:crypto';

const KEY_LENGTH_BYTES = 32; // 32 bytes = 256 bits, the key size AES-256 needs

// "info" labels make sure the two keys are different, even though they come
// from the same master key and session.
const ENCRYPTION_LABEL = 'safe-ai-gateway/vault-encryption';
const LOOKUP_LABEL = 'safe-ai-gateway/vault-lookup';

/**
 * Creates the two keys for one chat session.
 *
 * @param {Buffer} masterKey  the 32-byte master key from .env
 * @param {string} sessionId  the chat session's ID
 * @returns {{ encryptionKey: Buffer, hmacKey: Buffer }}
 */
export function deriveSessionKeys(masterKey, sessionId) {
  // The session ID is used as the "salt": the input that makes each session's keys unique.
  const salt = Buffer.from(sessionId, 'utf8');

  // hkdfSync(hash, masterKey, salt, label, length) returns an ArrayBuffer;
  // Buffer.from() turns it into a normal Node.js Buffer.
  const encryptionKey = Buffer.from(hkdfSync('sha256', masterKey, salt, ENCRYPTION_LABEL, KEY_LENGTH_BYTES));
  const hmacKey = Buffer.from(hkdfSync('sha256', masterKey, salt, LOOKUP_LABEL, KEY_LENGTH_BYTES));

  return { encryptionKey, hmacKey };
}
