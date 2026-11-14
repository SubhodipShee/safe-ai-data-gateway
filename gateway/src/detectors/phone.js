// =============================================================================
// phone.js: finds phone numbers (Indian and international)
// =============================================================================
//
// Catches:   +91 98765 43210     9876543210     080-2345-6789 (landline)
//            +1 650-253-0000     +44 20 7031 3000
// Ignores:   Order #12345        14-11-2026 (a date)     700001 (a PIN code)
//
// Phone numbers are hard to match with a hand-written pattern, because every
// country has different rules. So we use "libphonenumber-js", a free library
// based on Google's own phone number rules.
// =============================================================================

// "/max" loads the FULL rule set, so the library can tell whether a number
// really exists in that country's numbering plan, not just whether it has the right length.
import { findPhoneNumbersInText } from 'libphonenumber-js/max';

/**
 * Returns every valid phone number found in the text.
 *
 * @param {string} text
 * @param {string} defaultCountry  Numbers written without "+country code" are read
 *                                 as this country. 'IN' = India.
 */
export function findPhones(text, defaultCountry = 'IN') {
  // Step 1: let the library find everything that looks like a phone number.
  const candidates = findPhoneNumbersInText(text, defaultCountry);

  const findings = [];
  for (const candidate of candidates) {
    // Step 2: keep only numbers that are actually valid for their country.
    if (!candidate.number.isValid()) {
      continue;
    }

    // Step 3: turn it into our standard "finding" shape (see util.js).
    findings.push({
      type: 'PHONE',
      start: candidate.startsAt,
      end: candidate.endsAt,
      value: text.slice(candidate.startsAt, candidate.endsAt),
    });
  }
  return findings;
}
