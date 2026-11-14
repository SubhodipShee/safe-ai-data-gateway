// =============================================================================
// aadhaar.js: finds Aadhaar numbers, using the Verhoeff checksum
// =============================================================================
//
// An Aadhaar number has 12 digits, e.g.  2345 6789 0124
//   - The first digit is never 0 or 1.
//   - The LAST digit is a "check digit", calculated from the other 11
//     using the Verhoeff algorithm.
//
// WHY THE CHECKSUM MATTERS
// Lots of 12-digit numbers are NOT Aadhaar (order IDs, phone numbers with a
// country code, bank references…). Only about 1 in 10 random 12-digit numbers
// passes the checksum, so checking it cuts false alarms by about 90%.
//
//   2345 6789 0124  → caught   (checksum passes)
//   2345 6789 0125  → ignored  (last digit is wrong)
//
// Verhoeff also catches every single-digit typo and every swap of two
// neighbouring digits. That's why UIDAI chose it.
// =============================================================================

import { findAll } from './util.js';

// ---- Verhoeff lookup tables (fixed values from the algorithm; don't change them) ----

// MULTIPLY table: how two digits combine.
const MULTIPLY = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

// PERMUTE table: shuffles each digit depending on its position.
// (This is what catches swapped neighbouring digits.)
const PERMUTE = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

// INVERSE table: used to turn the final result into the check digit.
const INVERSE = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/**
 * Checks whether a string of digits (INCLUDING its last check digit) is valid.
 * Example: verhoeffValidate('2363') → true, verhoeffValidate('2364') → false
 */
export function verhoeffValidate(digits) {
  let check = 0;
  // Verhoeff reads the digits from RIGHT to LEFT.
  const reversed = digits.split('').reverse();

  for (let position = 0; position < reversed.length; position++) {
    const digit = Number(reversed[position]);
    const shuffled = PERMUTE[position % 8][digit];
    check = MULTIPLY[check][shuffled];
  }

  // A valid number always ends with check = 0.
  return check === 0;
}

/**
 * Calculates the check digit to add to the end of a string of digits.
 * Example: verhoeffCheckDigit('236') → '3'   (so '2363' is valid)
 * Used by the tests to build valid sample Aadhaar numbers.
 */
export function verhoeffCheckDigit(digits) {
  let check = 0;
  const reversed = digits.split('').reverse();

  for (let position = 0; position < reversed.length; position++) {
    const digit = Number(reversed[position]);
    // "+ 1" because the check digit itself will take position 0.
    const shuffled = PERMUTE[(position + 1) % 8][digit];
    check = MULTIPLY[check][shuffled];
  }

  return String(INVERSE[check]);
}

// How the pattern reads:
//   (?<![\w-])   Not stuck to a letter, digit or hyphen on the left.
//                (Stops us from matching the end of a UUID like ...-426614174000)
//   [2-9]        First digit is 2–9 (Aadhaar never starts with 0 or 1).
//   \d{3}        3 more digits.
//   ([ -]?)      An optional separator: a space, a hyphen, or nothing.
//   \d{4}        4 digits.
//   \1           The SAME separator again ("\1" repeats whatever ([ -]?) matched),
//                so "2345 6789-0124" (mixed separators) is NOT matched.
//   \d{4}        4 digits.
//   (?![\w-])    Not stuck to a letter, digit or hyphen on the right.
//
// Matches all three common formats:  234567890124   2345 6789 0124   2345-6789-0124
const AADHAAR_PATTERN = /(?<![\w-])[2-9]\d{3}([ -]?)\d{4}\1\d{4}(?![\w-])/g;

/** Returns every valid Aadhaar number found in the text. */
export function findAadhaar(text) {
  return findAll(text, AADHAAR_PATTERN, 'AADHAAR', {
    validate: (value) => {
      const digitsOnly = value.replace(/\D/g, ''); // remove spaces and hyphens
      return verhoeffValidate(digitsOnly);
    },
  });
}
