// =============================================================================
// crypto/signing.js: digital signatures (Ed25519) for the audit log
// =============================================================================
//
// WHAT IS A DIGITAL SIGNATURE?
//   - The PRIVATE key creates a signature for a message. Only the gateway has it.
//   - The PUBLIC key checks a signature. Anyone can have it (even an auditor).
//   - If the message changes by a single character, the signature no longer matches.
//
// So when the gateway signs "the latest audit entry is #42 with hash abc…", an
// attacker with full database access still can't forge a new signature for a
// faked log, because they don't have the private key.
//
// WHERE DOES THE KEY COME FROM?
// We derive it from MASTER_KEY with HKDF (like the vault keys in keys.js), so
// there's nothing extra to set up or store, and the same master key always gives
// the same signing key.
//
// Ed25519 is a modern, fast signature algorithm (used by SSH, Signal, Tor…).
// =============================================================================

import { createHash, createPrivateKey, createPublicKey, hkdfSync, sign, verify } from 'node:crypto';

// An Ed25519 private key is just 32 random bytes (the "seed"). Node wants it
// wrapped in the standard PKCS#8 format, which for Ed25519 is always this fixed
// 16-byte header followed by the 32-byte seed.
const PKCS8_ED25519_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Creates the audit signing key pair from the master key.
 * @param {Buffer} masterKey  the 32-byte MASTER_KEY
 * @returns {{ privateKey: KeyObject, publicKey: KeyObject, publicKeyPem: string, fingerprint: string }}
 */
export function deriveSigningKeys(masterKey) {
  const seed = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'safe-ai-gateway/audit-signing', 32));

  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_HEADER, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  // A short ID for the public key, so a report can say which key signed it.
  const fingerprint = createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);

  return { privateKey, publicKey, publicKeyPem, fingerprint };
}

/** Signs a text message. Returns the signature as base64. */
export function signMessage(privateKey, message) {
  // For Ed25519 the hash algorithm argument must be null (Ed25519 hashes internally).
  return sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

/** True if `signature` (base64) is a valid signature of `message` by this public key. */
export function verifySignature(publicKey, message, signature) {
  try {
    return verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false; // malformed signature
  }
}
