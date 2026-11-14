// =============================================================================
// util.js: a helper that every detector uses
// =============================================================================
//
// WHAT IS A "FINDING"?
// When a detector spots something sensitive, it reports it as a "finding" object:
//
//   {
//     type:  'EMAIL',           // what kind of data it is
//     label: 'AWS',             // (optional) extra detail, e.g. which company's API key
//     start: 5,                 // position where it starts in the text
//     end:   18,                // position where it ends
//     value: 'rahul@abc.com'    // the actual sensitive text
//   }
//
// Example: in the text  "Mail rahul@abc.com now"
//                        0123456789...
//   the email starts at position 5 and ends at position 18,
//   so  text.slice(5, 18)  gives back  "rahul@abc.com".
//
// Later (Phase 3) the masker uses start/end to replace the value with [[EMAIL_1]].
// =============================================================================

/**
 * Searches the text with a regular expression and returns every match as a finding.
 *
 * @param {string} text   The text to search.
 * @param {RegExp} regex  The pattern to look for. Must have the "g" (global) flag
 *                        so it finds ALL matches, not just the first one.
 * @param {string} type   The type to put on each finding, e.g. 'EMAIL'.
 * @param {object} [options]
 * @param {number} [options.group]     Report only one part of the match (a "capture group").
 *                                     Example: in "PASSWORD=abc123" we only want "abc123",
 *                                     not the word PASSWORD. The regex then needs the "d" flag.
 * @param {Function} [options.validate] An extra check. If it returns false, the match is thrown away.
 *                                     Example: Aadhaar uses this to run the checksum.
 * @param {string} [options.label]     Extra detail to attach, e.g. 'AWS'.
 * @returns {object[]} A list of findings.
 */
export function findAll(text, regex, type, options = {}) {
  const { group = 0, validate, label } = options;
  const findings = [];

  // matchAll() goes through the text and gives us every match one by one.
  for (const match of text.matchAll(regex)) {
    let start;
    let end;

    if (group === 0) {
      // Use the whole match.
      start = match.index;
      end = match.index + match[0].length;
    } else {
      // Use only one capture group. match.indices (from the "d" flag)
      // tells us where that group starts and ends.
      start = match.indices[group][0];
      end = match.indices[group][1];
    }

    const value = text.slice(start, end);

    // Run the extra check, if there is one. Skip this match if it fails.
    if (validate && !validate(value)) {
      continue;
    }

    const finding = { type, start, end, value };
    if (label) {
      finding.label = label;
    }
    findings.push(finding);
  }

  return findings;
}
