// =============================================================================
// tags.js: the rules for tags like [[EMAIL_1]] (no database code here)
// =============================================================================
//
// Shared by the vault (gateway) and the VS Code extension, which masks text
// offline on the developer's own computer. Both must give the same value the
// same tag, so the rules live in ONE place.
// =============================================================================

import { normalizeText } from './detectors/normalize.js';

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
