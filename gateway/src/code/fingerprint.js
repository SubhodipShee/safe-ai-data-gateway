// =============================================================================
// code/fingerprint.js: turns source code into "fingerprints" (winnowing)
// =============================================================================
//
// GOAL: recognise the company's private code even after someone has
//   - renamed the variables and functions,
//   - changed the spacing, line breaks or indentation,
//   - deleted or added comments,
//   - copied only PART of a file.
//
// HOW (3 steps, the same idea as the MOSS plagiarism detector):
//
// STEP 1: NORMALISE into tokens ("words" of code)
//   function refund(order) { return order.total; } // pay back
//   → function V ( V ) { return V . V }
//   Comments, semicolons and commas are dropped; every name becomes "V",
//   numbers "N", strings "S". Keywords (function, return, if…) are kept,
//   because they ARE the structure.
//
// STEP 2: K-GRAMS: every run of K tokens in a row, each turned into a number (hash).
//   tokens:  t1 t2 t3 t4 t5 t6 …
//   k-grams: [t1…tK] [t2…tK+1] [t3…tK+2] …   → h1, h2, h3, …
//
// STEP 3: WINNOWING: keep only SOME of the hashes, chosen consistently.
//   Slide a window of W hashes along; in each window keep the SMALLEST one.
//     hashes:  77 12 54 91 33 12 80 45 …
//     window:  [77 12 54 91]        → keep 12
//                 [12 54 91 33]     → still 12 (same one, not added again)
//                    [54 91 33 12]  → keep the second 12
//   Because the choice depends only on the hashes themselves, the SAME code
//   always keeps the SAME fingerprints, wherever it appears. And it's guaranteed:
//   any copied run of at least W + K − 1 tokens shares at least one fingerprint.
//
// PRIVACY: the hashes are KEYED (HMAC with a key from MASTER_KEY), so the
// database only holds numbers that are meaningless without the key. No code is stored.
// =============================================================================

import { createHmac } from 'node:crypto';

/** K: tokens per k-gram. Bigger = fewer accidental matches on generic code. */
export const K = 12;
/** W: window size. Any copied run of W + K − 1 = 19 tokens (about 2–3 lines) is guaranteed to be caught. */
export const W = 8;

// RESERVED keywords from common languages (JS/TS, Python, Java, C#, Go, C/C++).
// These are KEPT as-is; every other name becomes "V".
// Only words that can NEVER be variable names belong here. Words like "order",
// "map" or "type" are left out on purpose: they're common variable names, and
// keeping them would let someone dodge detection just by renaming them.
const KEYWORDS = new Set(`
  abstract and as assert async await boolean break byte case catch char class const continue
  def default defer del delete do double elif else enum except export extends false final finally float
  for from func function goto if implements import in instanceof int interface is lambda let long
  new nil none not null of or package pass private protected public raise return
  short static struct super switch this throw throws true try typeof var void while with yield
`.split(/\s+/).filter(Boolean));

// Tokens that are only FORMATTING, not structure: JavaScript works with or without
// semicolons, and trailing commas come and go with code formatters. Ignored.
const FORMATTING_ONLY = new Set([';', ',']);

// One pattern that recognises every kind of token. The order matters: comments
// first (so their content is skipped), then strings, names, numbers, operators.
const TOKEN_PATTERN = new RegExp(
  [
    String.raw`(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/|#(?=[\s!])[^\n]*|<!--[\s\S]*?-->)`, // // …  /* … */  # …  <!-- … -->
    String.raw`(?<string>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\.|[^\x60\\])*\x60)`, // "…"  '…'  \`…\`
    String.raw`(?<name>[A-Za-z_$][\w$]*)`, //                              names and keywords
    String.raw`(?<number>\d[\w.]*)`, //                                    numbers
    String.raw`(?<operator>===|!==|==|!=|<=|>=|=>|->|&&|\|\||\+\+|--|::|[-+*/%<>=!&|^~?:;,.(){}\[\]@])`,
  ].join('|'),
  'g',
);

/**
 * STEP 1: splits code into normalised tokens, remembering where each came from.
 * @returns {{ token: string, start: number, end: number }[]}
 *
 * Example: tokenize('let total = price * 2; // tax')
 *   → let V = V * N ;     (with start/end positions in the original text)
 */
export function tokenize(code) {
  const tokens = [];
  for (const match of code.matchAll(TOKEN_PATTERN)) {
    const { comment, string, name, number } = match.groups;
    if (comment !== undefined) continue; // comments are ignored completely

    let token;
    if (string !== undefined) token = 'S';
    else if (number !== undefined) token = 'N';
    else if (name !== undefined) token = KEYWORDS.has(name.toLowerCase()) ? name.toLowerCase() : 'V';
    else if (FORMATTING_ONLY.has(match[0])) continue; // ; and , are ignored
    else token = match[0]; // operator / punctuation, kept as-is

    tokens.push({ token, start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** A 48-bit keyed hash of a k-gram (48 bits fits safely in a JavaScript number). */
function hashKgram(key, text) {
  return createHmac('sha256', key).update(text, 'utf8').digest().readUIntBE(0, 6);
}

/**
 * STEPS 2 + 3: the fingerprints of a piece of code.
 * @param {Buffer} key   the fingerprint key (from MASTER_KEY)
 * @param {string} code
 * @returns {{ hash: number, start: number, end: number }[]}
 *   each fingerprint and the part of the text it came from
 */
export function fingerprint(key, code) {
  const tokens = tokenize(code);
  if (tokens.length < K) return [];

  // ---- Step 2: hash every k-gram ----
  const kgrams = [];
  for (let i = 0; i + K <= tokens.length; i++) {
    const text = tokens.slice(i, i + K).map((t) => t.token).join(' ');
    kgrams.push({ hash: hashKgram(key, text), start: tokens[i].start, end: tokens[i + K - 1].end });
  }

  // ---- Step 3: winnowing: the smallest hash in every window of W ----
  if (kgrams.length <= W) {
    // Shorter than one window: just keep the single smallest.
    return [kgrams.reduce((min, k) => (k.hash < min.hash ? k : min))];
  }

  const selected = [];
  let lastPicked = -1;
  for (let windowStart = 0; windowStart + W <= kgrams.length; windowStart++) {
    // The RIGHTMOST smallest hash in the window ("<=" picks the later one on ties).
    let smallest = windowStart;
    for (let i = windowStart + 1; i < windowStart + W; i++) {
      if (kgrams[i].hash <= kgrams[smallest].hash) smallest = i;
    }
    // Only record it once, even though it stays the smallest for several windows.
    if (smallest !== lastPicked) {
      selected.push(kgrams[smallest]);
      lastPicked = smallest;
    }
  }
  return selected;
}
