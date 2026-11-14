// =============================================================================
// normalize.js: undoes the tricks people use to sneak data past the detectors
// =============================================================================
//
// An employee who knows there's a filter might try:
//
//   Trick                     Example                         What the detectors see
//   ───────────────────────   ─────────────────────────────   ──────────────────────
//   Devanagari/Bengali digits  २३४५ ६७८९ ०१२४                  2345 6789 0124
//   Invisible characters       2345⁠6789⁠0124 (zero-width)       234567890124
//   Look-alike letters         АВСРЕ1234F (Cyrillic А, В, С…)  ABCPE1234F
//   Full-width characters      ＡＢＣＰＥ１２３４Ｆ              ABCPE1234F
//   Spaced-out digits          9 8 7 6 5 4 3 2 1 0             9876543210
//   Letter O / l for 0 / 1     98765 4321O                     9876543210
//
// HOW IT WORKS
// We build a CLEAN COPY of the text, and for every character in the copy we
// remember which characters of the ORIGINAL it came from (`starts` and `ends`).
//
//   original:  "२३४५"          clean copy: "2345"
//                ││││                       ││││
//                │││└─ positions 3–4  ←─────┘│││
//                ││└── positions 2–3  ←──────┘││  …and so on
//
// The detectors search the clean copy. Then mapSpan() turns a match in the copy
// back into positions in the original, so we mask exactly what the user typed
// and restore it exactly as typed.
// =============================================================================

// \p{…} are "Unicode property" patterns (they need the "u" flag):
//   \p{Cf} = "format" characters: invisible ones like zero-width space (U+200B),
//            zero-width joiner (U+200D), soft hyphen, and text-direction controls.
//   \p{Nd} = a decimal digit in ANY script: 0-9, ०-९ (Devanagari), ০-৯ (Bengali),
//            ௦-௯ (Tamil), ０-９ (full-width), 𝟎-𝟗 (maths bold)…
const INVISIBLE_CHARACTER = /^\p{Cf}$/u;
const ANY_SCRIPT_DIGIT = /^\p{Nd}$/u;
const ASCII_DIGIT = /^[0-9]$/;
const LETTER = /^\p{L}$/u;

// Letters from other alphabets that LOOK identical to Latin letters.
// (Cyrillic and Greek are the ones used in real attacks.)
const LOOK_ALIKES = new Map(Object.entries({
  // Cyrillic capitals
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y',
  І: 'I', Ј: 'J', Ѕ: 'S',
  // Cyrillic small letters
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h',
  // Greek capitals
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T',
  Υ: 'Y', Χ: 'X',
  // Greek small letters
  ο: 'o', ν: 'v', α: 'a',
}));

/**
 * The value (0–9) of a digit from ANY script, e.g. '२' (Devanagari two) → 2.
 *
 * Unicode guarantees that every script's digits are stored as 10 neighbours in
 * order: 0,1,2…9. So we walk back to the first digit of the run (the "zero")
 * and count how far we are from it.
 * (% 10 handles places where several sets of 10 digits sit right next to each other.)
 */
function digitValue(char) {
  const codePoint = char.codePointAt(0);
  let zero = codePoint;
  while (codePoint - zero < 60 && ANY_SCRIPT_DIGIT.test(String.fromCodePoint(zero - 1))) {
    zero -= 1;
  }
  return (codePoint - zero) % 10;
}

/** Cleans ONE character. Returns the replacement text ('' = remove it). */
function cleanCharacter(char) {
  // Plain ASCII (a–z, 0–9, punctuation…) never needs cleaning: the fast path.
  if (char.charCodeAt(0) < 128) return char;

  if (INVISIBLE_CHARACTER.test(char)) return '';
  if (ANY_SCRIPT_DIGIT.test(char)) return String(digitValue(char));

  // NFKC turns "compatibility" forms into plain ones: full-width Ａ → A, ① → 1, ² → 2…
  const simplified = char.normalize('NFKC');

  // Then replace look-alike letters with their Latin twins.
  let result = '';
  for (const c of simplified) {
    result += LOOK_ALIKES.get(c) ?? c;
  }
  return result;
}

// Spaced-out digits: at least 6 SINGLE digits, each separated by 1–3 spaces,
// dots, commas, dashes or underscores, e.g. "9 8 7 6 5 4 3 2 1 0" or "2-3-4-5-6-7".
// Normal groups like "2345 6789 0124" or "+91 98765 43210" don't match (multi-digit groups),
// and new lines are NOT separators (so columns in a table aren't joined together).
const SPACED_OUT_DIGITS = /(?<!\d)\d(?:[ \t.,_-]{1,3}\d(?!\d)){5,}/g;

/**
 * Makes the clean copy of a text.
 *
 * @param {string} text
 * @returns {{ text: string, starts: number[], ends: number[], changed: boolean }}
 *   text    the clean copy
 *   starts  starts[i] = where clean character i begins in the original
 *   ends    ends[i]   = where it ends in the original
 *   changed true if the clean copy differs from the original
 */
export function normalizeText(text) {
  let chars = []; // the clean copy, one UTF-16 unit per entry
  let starts = [];
  let ends = [];

  // ---- Pass 1: clean each character ----
  // `for…of` walks whole characters, so emoji and 𝟎-style digits (2 units each) stay together.
  let position = 0;
  for (const char of text) {
    const start = position;
    const end = position + char.length;
    position = end;

    const cleaned = cleanCharacter(char);
    for (let i = 0; i < cleaned.length; i++) {
      chars.push(cleaned[i]);
      starts.push(start);
      ends.push(end);
    }
  }

  // ---- Pass 2: letter O / o / l / I used as a digit ----
  // Only when it touches a digit and isn't part of a word: "4321O" → "43210", but "HELLO 1" stays.
  for (let i = 0; i < chars.length; i++) {
    const asDigit = { O: '0', o: '0', l: '1', I: '1' }[chars[i]];
    if (!asDigit) continue;
    const before = chars[i - 1] ?? ' ';
    const after = chars[i + 1] ?? ' ';
    const touchesDigit = ASCII_DIGIT.test(before) || ASCII_DIGIT.test(after);
    const insideWord = LETTER.test(before) || LETTER.test(after);
    if (touchesDigit && !insideWord) chars[i] = asDigit;
  }

  // ---- Pass 3: remove the gaps in spaced-out digits ----
  const joined = chars.join('');
  const remove = new Set();
  for (const match of joined.matchAll(SPACED_OUT_DIGITS)) {
    for (let i = match.index; i < match.index + match[0].length; i++) {
      if (!ASCII_DIGIT.test(joined[i])) remove.add(i);
    }
  }
  if (remove.size > 0) {
    const keep = (_, i) => !remove.has(i);
    chars = chars.filter(keep);
    starts = starts.filter(keep);
    ends = ends.filter(keep);
  }

  const clean = chars.join('');
  return { text: clean, starts, ends, changed: clean !== text };
}

/**
 * Turns a position range in the CLEAN copy back into the ORIGINAL text.
 * Example: clean "2345" at 0–4 came from original "२३४५" at 0–4.
 */
export function mapSpan(normalized, start, end) {
  return { start: normalized.starts[start], end: normalized.ends[end - 1] };
}
