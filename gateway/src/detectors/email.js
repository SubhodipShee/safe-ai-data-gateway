// =============================================================================
// email.js: finds email addresses
// =============================================================================
//
// Catches:   rahul@abc.com
//            priya.sharma+hr@mail.company.co.in
// Ignores:   @rahul            (a mention, no name before @)
//            user@localhost    (no ".com"/".in" style ending)
// =============================================================================

import { findAll } from './util.js';

// How the pattern reads, piece by piece:
//
//   (?<![\w.%+-])            Must NOT be stuck to another email character on the left.
//                            (Stops us from starting in the middle of something.)
//   [A-Za-z0-9]              The name starts with a letter or digit…
//   [A-Za-z0-9._%+-]{0,63}   …followed by up to 63 letters, digits or . _ % + -
//   @                        The @ sign.
//   (?:[A-Za-z0-9]           One or more domain parts like "mail." or "company."
//     (?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+
//   [A-Za-z]{2,24}           The ending, e.g. "com", "in", "org" (2–24 letters).
//   (?![A-Za-z0-9-])         Must NOT continue with more letters on the right.
//
const EMAIL_PATTERN =
  /(?<![\w.%+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;

/** Returns every email address found in the text. */
export function findEmails(text) {
  return findAll(text, EMAIL_PATTERN, 'EMAIL');
}
