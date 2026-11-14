// =============================================================================
// detectors/index.js: the main entry point for detection
// =============================================================================
//
// The rest of the app only calls  detect(text).  This file:
//   1. makes a CLEAN COPY of the text that undoes bypass tricks (normalize.js),
//   2. runs EVERY detector on the clean copy,
//   3. maps each match back to its position in the ORIGINAL text,
//   4. removes overlapping results (two detectors can match the same text),
//   5. returns one clean list, sorted by position.
//
// Example:
//   detect("Mail rahul@abc.com, PAN ABCPE1234F")
//   → [
//       { type: 'EMAIL', start: 5,  end: 18, value: 'rahul@abc.com' },
//       { type: 'PAN',   start: 24, end: 34, value: 'ABCPE1234F' }
//     ]
//
// A bypass attempt is caught AND flagged:
//   detect("Aadhaar २३४५ ६७८९ ०१२४")
//   → [ { type: 'AADHAAR', start: 8, end: 22, value: '२३४५ ६७८९ ०१२४', obfuscated: true } ]
// =============================================================================

import { normalizeText, mapSpan } from './normalize.js';
import { findEmails } from './email.js';
import { findPhones } from './phone.js';
import { findPans } from './pan.js';
import { findAadhaar } from './aadhaar.js';
import {
  findApiKeys,
  findPrivateKeys,
  findJwts,
  findAssignedSecrets,
  findCredentialUris,
} from './secrets.js';
import { findHighEntropy } from './entropy.js';
import {
  findGstins,
  findUpiIds,
  findIfscs,
  findBankAccounts,
  findVoterIds,
  findPassports,
  findDrivingLicences,
} from './india.js';
import { findAddresses } from './address.js';

/** Every type of sensitive data we can detect. These become tags like [[EMAIL_1]]. */
export const ENTITY_TYPES = [
  'EMAIL', 'PHONE', 'AADHAAR', 'PAN', 'GSTIN', 'UPI_ID', 'IFSC', 'BANK_ACCOUNT',
  'VOTER_ID', 'PASSPORT', 'DRIVING_LICENCE', 'API_KEY', 'PRIVATE_KEY', 'JWT', 'SECRET',
  'ADDRESS',
  'PRIVATE_CODE', // found by code/code-guard.js (needs the database), not by detect()
  'PERSON', //       found by ai/name-finder.js (a local AI model), not by detect()
];

/** The largest text we accept (about 200 KB). Protects the server from huge inputs. */
export const MAX_TEXT_LENGTH = 200_000;

// All the detectors we run. Adding a new detector = add it to this list.
const ALL_DETECTORS = [
  findPrivateKeys,
  findJwts,
  findApiKeys,
  findCredentialUris,
  findAssignedSecrets,
  findEmails,
  findAadhaar,
  findPans,
  findGstins,
  findUpiIds,
  findIfscs,
  findBankAccounts,
  findVoterIds,
  findPassports,
  findDrivingLicences,
  findAddresses,
  findPhones,
  findHighEntropy,
];

// PRIORITY decides the winner when two findings cover EXACTLY the same text.
// Higher number = more specific = wins.
//   e.g. "account 9876543210" matches both BANK_ACCOUNT and PHONE;
//        BANK_ACCOUNT (74) beats PHONE (50), because the keyword "account" proves what it is.
//   SECRET (the entropy guess) is lowest, because it's the least certain.
const PRIORITY = {
  PRIVATE_KEY: 100,
  PRIVATE_CODE: 95,
  JWT: 90,
  API_KEY: 80,
  GSTIN: 78,
  DRIVING_LICENCE: 76,
  BANK_ACCOUNT: 74,
  AADHAAR: 70,
  PASSPORT: 68,
  VOTER_ID: 67,
  PAN: 65,
  IFSC: 64,
  UPI_ID: 62,
  EMAIL: 60,
  PHONE: 50,
  ADDRESS: 45,
  PERSON: 40, // an AI guess, so anything more specific wins
  SECRET: 10,
};

/**
 * Finds all sensitive data in a piece of text.
 * @param {string} text
 * @returns {object[]} findings sorted by position (see util.js for the shape)
 */
export function detect(text) {
  // Nothing to scan.
  if (typeof text !== 'string' || text.length === 0) {
    return [];
  }

  // Refuse very large inputs instead of slowing the server down.
  if (text.length > MAX_TEXT_LENGTH) {
    throw new RangeError(`Text too long (${text.length} chars, max ${MAX_TEXT_LENGTH})`);
  }

  // Step 1: make the clean copy (Devanagari digits → 0-9, invisible characters removed…).
  const clean = normalizeText(text);

  // Step 2: run every detector on the CLEAN copy.
  const cleanFindings = [];
  for (const detector of ALL_DETECTORS) {
    cleanFindings.push(...detector(clean.text));
  }

  // Step 3: map each finding back to the ORIGINAL text.
  const findings = cleanFindings.map((finding) => mapBackToOriginal(finding, text, clean));

  // Step 4: remove overlaps.
  return resolveOverlaps(findings);
}

/**
 * Converts a finding from clean-copy positions to original-text positions.
 * The value becomes exactly what the user typed (that's what gets encrypted and restored).
 * If the original looks different from the clean version, it was a bypass attempt:
 * we mark it `obfuscated: true` so it can be counted in the audit log.
 */
function mapBackToOriginal(finding, originalText, clean) {
  if (!clean.changed) {
    return finding; // nothing was cleaned, so the positions are already right
  }
  const { start, end } = mapSpan(clean, finding.start, finding.end);
  const originalValue = originalText.slice(start, end);
  const mapped = { ...finding, start, end, value: originalValue };
  if (originalValue !== finding.value) {
    mapped.obfuscated = true;
  }
  return mapped;
}

/**
 * When two findings overlap, keep only one.
 *
 * RULE 1: the LONGER finding wins.
 *   This is the "fail safe" choice: we'd rather mask too much than leave part
 *   of a secret visible. Example: a phone-like number INSIDE a database URL →
 *   the whole URL (longer) wins.
 *
 * RULE 2: if both are the same length, the higher PRIORITY wins.
 *
 * @param {object[]} findings  may overlap
 * @returns {object[]}         no overlaps, sorted by position
 */
export function resolveOverlaps(findings) {
  // Sort so the findings we prefer come FIRST.
  const bestFirst = [...findings].sort(compareBestFirst);

  // Go through them in that order. Keep a finding only if it doesn't touch one we already kept.
  const kept = [];
  for (const finding of bestFirst) {
    const overlapsKept = kept.some((k) => overlaps(finding, k));
    if (!overlapsKept) {
      kept.push(finding);
    }
  }

  // Put them back in the order they appear in the text.
  return kept.sort((a, b) => a.start - b.start);
}

/** Sorting rule for resolveOverlaps: longer first, then higher priority, then earlier. */
function compareBestFirst(a, b) {
  const lengthA = a.end - a.start;
  const lengthB = b.end - b.start;
  if (lengthA !== lengthB) return lengthB - lengthA; // longer first

  const priorityA = PRIORITY[a.type];
  const priorityB = PRIORITY[b.type];
  if (priorityA !== priorityB) return priorityB - priorityA; // higher priority first

  return a.start - b.start; // earlier in the text first
}

/** True if two findings share at least one character. */
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** How many findings were bypass attempts (see mapBackToOriginal). */
export function countObfuscated(findings) {
  return findings.filter((finding) => finding.obfuscated).length;
}

/**
 * Counts findings per type.
 * Example: summarize(findings) → { EMAIL: 2, PAN: 1 }
 */
export function summarize(findings) {
  const counts = {};
  for (const finding of findings) {
    counts[finding.type] = (counts[finding.type] || 0) + 1;
  }
  return counts;
}
