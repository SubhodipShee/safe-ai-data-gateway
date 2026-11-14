// =============================================================================
// address.js: finds Indian postal addresses (rule-based, no AI needed)
// =============================================================================
//
// Catches:
//   Flat 4B, Salt Lake Sector V, Kolkata 700091     (address words + PIN code)
//   12, MG Road, Bengaluru - 560 001                (PIN written with a space)
//   PIN: 700091                                     (a labelled PIN on its own)
//   Address: 221B Baker Street, London              ("Address:" label, no PIN)
// Ignores:
//   Your OTP is 482913                              (6 digits, but no address context)
//   Revenue was 560001 rupees                       (same)
//
// HOW: an Indian PIN code (6 digits, first digit 1–8) is the anchor. We look back
// from the PIN for an "address word" (Flat, Road, Nagar, Sector…). If we find one,
// everything from that word to the PIN is the address. A 6-digit number with NO
// address words nearby is left alone, because it could just as well be an OTP or an amount.
// =============================================================================

import { findAll } from './util.js';

// Words that appear in Indian addresses. \b = whole words only.
const ADDRESS_WORDS =
  /\b(?:flat|house|h\.?\s?no|plot|door|block|sector|phase|floor|tower|wing|apartments?|apt|building|bldg|road|rd|street|st|lane|marg|path|nagar|colony|layout|enclave|vihar|society|complex|residency|village|vill|p\.?o|p\.?s|dist|district|tehsil|taluk|mandal|near|opp|opposite|behind|cross|main)\b/gi;

// PIN code: 6 digits, first digit 1–8, optionally written "700 091".
const PIN_CODE = /(?<![\d-])[1-8]\d{2}\s?\d{3}(?![\d-])/g;

// "PIN", "Pincode", "PIN code", "Postal code" written just before the number.
const PIN_LABEL = /\b(?:pin\s*code|pincode|pin|postal\s*code|zip)\s*[:.-]?\s*$/i;

// How far back from the PIN we look for the start of the address.
const LOOK_BACK_CHARS = 160;

// "Address: <text>" up to the end of the line.
const ADDRESS_LABEL = /\b(?:address|addr|residing at|resides at|lives at)\s*[:-]\s*([^\n]{8,200})/gid;

/** Returns every address found in the text. */
export function findAddresses(text) {
  const findings = [];

  // ---- 1. Addresses that end in a PIN code ----
  for (const pin of text.matchAll(PIN_CODE)) {
    const pinStart = pin.index;
    const pinEnd = pin.index + pin[0].length;

    // The text just before the PIN, but never across a blank line (a new paragraph).
    let windowStart = Math.max(0, pinStart - LOOK_BACK_CHARS);
    const blankLine = text.lastIndexOf('\n\n', pinStart);
    if (blankLine >= windowStart) windowStart = blankLine + 2;
    const before = text.slice(windowStart, pinStart);

    // The EARLIEST address word in that window is where the address starts.
    const firstWord = [...before.matchAll(ADDRESS_WORDS)][0];
    if (firstWord) {
      let start = windowStart + firstWord.index;

      // Street names come BEFORE words like "Road": include up to 3 capitalised words
      // just before it ("MG" in "MG Road", "Salt Lake" in "Salt Lake Sector V"),
      // but stop at lowercase words, so "ship to Flat 4B" doesn't swallow "ship to".
      for (let i = 0; i < 3; i++) {
        const nameWord = text.slice(Math.max(windowStart, start - 30), start).match(/([A-Z0-9][\w.'/-]*\s+)$/);
        if (!nameWord) break;
        start -= nameWord[1].length;
      }

      // Include a house number just before it, e.g. the "12, " in "12, MG Road".
      const houseNumber = text.slice(Math.max(0, start - 12), start).match(/(?:^|[\s,:(])([\w/#-]*\d[\w/#-]*,?\s*)$/);
      if (houseNumber) start -= houseNumber[1].length;
      findings.push({ type: 'ADDRESS', label: 'pin-code', start, end: pinEnd, value: text.slice(start, pinEnd) });
      continue;
    }

    // No address words, but labelled "PIN: 700091" → the PIN alone still reveals the area.
    if (PIN_LABEL.test(text.slice(Math.max(0, pinStart - 20), pinStart))) {
      findings.push({ type: 'ADDRESS', label: 'pin-code', start: pinStart, end: pinEnd, value: pin[0] });
    }
  }

  // ---- 2. "Address: …" labels (works for addresses without a PIN too) ----
  findings.push(...findAll(text, ADDRESS_LABEL, 'ADDRESS', { group: 1, label: 'labelled' }));

  return findings;
}
