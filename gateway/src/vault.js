// =============================================================================
// vault.js: stores real values safely and gives back placeholder tags
// =============================================================================
//
// This is the heart of Phase 2. It connects:
//   keys.js          (one set of keys per session)
//   vault-crypto.js  (encryption + fingerprints)
//   the models       (Session + VaultEntry in Atlas)
//
// HOW TO USE IT
//   const vault = createVault({ masterKey, sessionTtlHours: 24 });
//
//   // Hide a value: get a tag back
//   await vault.getOrCreatePlaceholder(sessionId, 'EMAIL', 'rahul@abc.com')  → '[[EMAIL_1]]'
//   await vault.getOrCreatePlaceholder(sessionId, 'EMAIL', 'Rahul@ABC.com')  → '[[EMAIL_1]]'  (same person!)
//   await vault.getOrCreatePlaceholder(sessionId, 'EMAIL', 'priya@xyz.in')   → '[[EMAIL_2]]'
//
//   // Reveal tags: get the real values back
//   await vault.revealPlaceholders(sessionId, ['[[EMAIL_1]]'])  → Map { '[[EMAIL_1]]' => 'rahul@abc.com' }
//
//   // Delete everything for a session (e.g. the user clicks "clear")
//   await vault.forgetSession(sessionId)
//
// Phase 3 (the masker) will use exactly these three functions.
// =============================================================================

import { ENTITY_TYPES } from './detectors/index.js';
import { normalizeText } from './detectors/normalize.js';
import { deriveSessionKeys } from './crypto/keys.js';
import { encryptValue, decryptValue, hmacValue } from './crypto/vault-crypto.js';
import { Session } from './models/Session.js';
import { VaultEntry } from './models/VaultEntry.js';

// A session ID must be 16–64 letters, digits, "_" or "-" (a UUID fits).
// Long random IDs can't be guessed, which matters because the ID unlocks the session's values.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// MongoDB's error code for "this would break a unique index".
const DUPLICATE_KEY_ERROR = 11000;

/** True if the session ID has a safe format. */
export function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);
}

/** Builds a tag, e.g. makePlaceholder('EMAIL', 1) → '[[EMAIL_1]]' */
export function makePlaceholder(type, number) {
  return `[[${type}_${number}]]`;
}

/**
 * Puts a value into a standard form BEFORE fingerprinting, so that small
 * differences in writing still count as the SAME value:
 *
 *   EMAIL    "Rahul@ABC.com"    → "rahul@abc.com"
 *   PAN      "abcpe1234f"       → "ABCPE1234F"
 *   AADHAAR  "2345 6789 0124"   → "234567890124"
 *   AADHAAR  "२३४५ ६७८९ ०१२४"   → "234567890124"   (Devanagari digits: same person, same tag)
 *
 * This keeps the tags consistent: the AI sees the same person as [[EMAIL_1]] every time.
 * (Only the fingerprint uses this form. We always encrypt and restore the ORIGINAL text.)
 */
export function normalizeForLookup(type, value) {
  // First undo bypass tricks (Indic digits, invisible characters, look-alike letters).
  // Without this, "\D" below would delete Devanagari digits completely, and every
  // Devanagari Aadhaar would share the same empty fingerprint.
  const trimmed = normalizeText(value).text.trim();
  switch (type) {
    case 'EMAIL':
    case 'UPI_ID':
      return trimmed.toLowerCase();

    case 'PAN':
    case 'GSTIN':
    case 'IFSC':
    case 'VOTER_ID':
    case 'PASSPORT':
      return trimmed.toUpperCase();

    case 'AADHAAR':
    case 'PHONE':
    case 'BANK_ACCOUNT':
      return trimmed.replace(/\D/g, ''); // keep digits only

    case 'DRIVING_LICENCE':
      return trimmed.replace(/[\s-]/g, '').toUpperCase();

    case 'PERSON':
    case 'ADDRESS':
      // "Rahul  Verma" and "rahul verma" are the same person: ignore case and extra spaces.
      return trimmed.replace(/\s+/g, ' ').toLowerCase();

    default:
      // API keys, passwords, tokens: one different character = a different secret.
      return trimmed;
  }
}

/**
 * The "context" sealed into each encryption (see vault-crypto.js).
 * Ties the encrypted value to its session AND its tag.
 */
function encryptionContext(sessionId, placeholder) {
  return `${sessionId}|${placeholder}`;
}

/**
 * Creates the vault.
 * @param {object} options
 * @param {Buffer} options.masterKey         the 32-byte MASTER_KEY
 * @param {number} [options.sessionTtlHours] how long a session's values are kept (default 24)
 */
export function createVault({ masterKey, sessionTtlHours = 24 }) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    throw new Error('createVault needs a 32-byte masterKey');
  }
  const sessionLifetimeMs = sessionTtlHours * 60 * 60 * 1000;

  /**
   * Returns the tag for a value, creating (and encrypting) it if it's new.
   *
   * @param {string} sessionId
   * @param {string} type   one of ENTITY_TYPES, e.g. 'EMAIL'
   * @param {string} value  the real sensitive value
   * @returns {Promise<string>} e.g. '[[EMAIL_1]]'
   */
  async function getOrCreatePlaceholder(sessionId, type, value) {
    // ---- Check the inputs ----
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session ID');
    if (!ENTITY_TYPES.includes(type)) throw new Error(`Unknown entity type: ${type}`);
    if (typeof value !== 'string' || value.length === 0) throw new Error('Value must be a non-empty string');

    const { encryptionKey, hmacKey } = deriveSessionKeys(masterKey, sessionId);

    // ---- Step 1: fingerprint the value ----
    // The type is included, so the same text found as two different types gets two different tags.
    const valueHmac = hmacValue(hmacKey, `${type}:${normalizeForLookup(type, value)}`);

    // ---- Step 2: have we already seen this value in this session? ----
    const existing = await VaultEntry.findOne({ sessionId, valueHmac }, { placeholder: 1 });
    if (existing) {
      return existing.placeholder; // yes: reuse the same tag
    }

    // ---- Step 3: get the next number for this type ----
    // "$inc" adds 1 to the counter INSIDE the database in a single step ("atomic"),
    // so two requests at the same moment can never both get number 2.
    // "upsert" creates the session the first time we see it.
    const session = await Session.findOneAndUpdate(
      { _id: sessionId },
      {
        $inc: { [`counters.${type}`]: 1 },
        $setOnInsert: { expiresAt: new Date(Date.now() + sessionLifetimeMs) },
      },
      { upsert: true, returnDocument: 'after' },
    );
    const placeholder = makePlaceholder(type, session.counters.get(type));

    // ---- Step 4: encrypt the ORIGINAL value ----
    const encrypted = encryptValue(encryptionKey, value, encryptionContext(sessionId, placeholder));

    // ---- Step 5: save it ----
    try {
      await VaultEntry.create({
        sessionId,
        placeholder,
        entityType: type,
        valueHmac,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        expiresAt: session.expiresAt, // the value lives exactly as long as its session
      });
      return placeholder;
    } catch (error) {
      // RACE CONDITION: another request saved the SAME value a moment ago, between
      // our Step 2 and Step 5. The unique index stopped us from creating a duplicate,
      // so we use the tag the other request created instead.
      // (Side effect: one counter number is skipped, e.g. EMAIL_2 jumps to EMAIL_3. Harmless.)
      if (error.code === DUPLICATE_KEY_ERROR) {
        const winner = await VaultEntry.findOne({ sessionId, valueHmac }, { placeholder: 1 });
        if (winner) return winner.placeholder;
      }
      throw error;
    }
  }

  /**
   * Looks up tags and returns their real values.
   * Tags that don't exist, have expired, or fail decryption are left out.
   *
   * @param {string} sessionId
   * @param {string[]} placeholders  e.g. ['[[EMAIL_1]]', '[[PAN_1]]']
   * @returns {Promise<Map<string, string>>} tag → real value
   */
  async function revealPlaceholders(sessionId, placeholders) {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session ID');

    const revealed = new Map();
    const uniquePlaceholders = [...new Set(placeholders)];
    if (uniquePlaceholders.length === 0) return revealed;

    const { encryptionKey } = deriveSessionKeys(masterKey, sessionId);

    // One database query for all the tags. Expired entries are skipped even if
    // MongoDB hasn't deleted them yet (TTL deletion can be up to ~60 s late).
    const entries = await VaultEntry.find({
      sessionId,
      placeholder: { $in: uniquePlaceholders },
      expiresAt: { $gt: new Date() },
    });

    for (const entry of entries) {
      try {
        const value = decryptValue(
          encryptionKey,
          { ciphertext: entry.ciphertext, iv: entry.iv, authTag: entry.authTag },
          encryptionContext(sessionId, entry.placeholder),
        );
        revealed.set(entry.placeholder, value);
      } catch {
        // Decryption failed: the data was changed in the database, or the MASTER_KEY
        // changed. We never return possibly-wrong data; the tag stays as it is.
        console.warn(`[vault] could not decrypt ${entry.placeholder}: tampered data or wrong MASTER_KEY`);
      }
    }
    return revealed;
  }

  /**
   * Deletes a session and ALL its stored values right away (instead of waiting for expiry).
   * @returns {Promise<number>} how many values were deleted
   */
  async function forgetSession(sessionId) {
    if (!isValidSessionId(sessionId)) throw new Error('Invalid session ID');
    const result = await VaultEntry.deleteMany({ sessionId });
    await Session.deleteOne({ _id: sessionId });
    return result.deletedCount;
  }

  return { getOrCreatePlaceholder, revealPlaceholders, forgetSession };
}
