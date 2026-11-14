// =============================================================================
// pan.js: finds Indian PAN numbers (Permanent Account Number)
// =============================================================================
//
// A PAN always has 10 characters:   A B C P E 1 2 3 4 F
//                                   └─┬─┘ │ │ └──┬──┘ └─ check letter
//                                     │   │ │    └──── 4 digits
//                                     │   │ └───────── first letter of surname/name
//                                     │   └─────────── HOLDER TYPE (see below)
//                                     └─────────────── 3 letters (series)
//
// The 4th letter tells you who owns the PAN:
//   P = Person      C = Company     H = Hindu Undivided Family    F = Firm
//   A = Association of Persons      T = Trust                     B = Body of Individuals
//   L = Local authority             J = Artificial juridical person   G = Government
//
// Checking the 4th letter is what makes us more accurate than a simple pattern:
//   ABCPE1234F  → caught   (P = person, valid)
//   ABCDE1234F  → ignored  (D is not a valid holder type; this is the
//                           example most tutorials use, and it's not a real PAN!)
// =============================================================================

import { findAll } from './util.js';

// How the pattern reads:
//   (?<![A-Za-z0-9])   Not stuck to a letter/digit on the left.
//   [A-Z]{3}           3 letters.
//   [PCHFATBLJG]       The holder-type letter (only these 10 are valid).
//   [A-Z]              1 letter.
//   [0-9]{4}           4 digits.
//   [A-Z]              1 check letter.
//   (?![A-Za-z0-9])    Not stuck to a letter/digit on the right.
//
// The "i" flag makes it work for lowercase too (people often type "abcpe1234f").
const PAN_PATTERN = /(?<![A-Za-z0-9])[A-Z]{3}[PCHFATBLJG][A-Z][0-9]{4}[A-Z](?![A-Za-z0-9])/gi;

/** Returns every PAN number found in the text. */
export function findPans(text) {
  return findAll(text, PAN_PATTERN, 'PAN');
}
