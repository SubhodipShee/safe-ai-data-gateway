// =============================================================================
// agent/stream-restorer.js: puts real values back into an answer that arrives in PIECES
// =============================================================================
//
// With streaming, the AI's answer arrives a few characters at a time. A tag can
// be cut in the middle:
//
//   piece 1: "Send it to [[EM"
//   piece 2: "AIL_1]] today"
//
// Restoring each piece on its own would miss that tag. So the restorer HOLDS BACK
// the end of a piece when it might be the start of a tag, and only lets it out
// once the tag is complete:
//
//   push("Send it to [[EM")   → "Send it to "               ("[[EM" is held back)
//   push("AIL_1]] today")     → "rahul@abc.com today"
//   flush()                   → ""                          (anything still held back)
//
// JSON MODE: when the AI writes tool-call arguments (JSON text such as
// {"path": "a.txt", "content": "[[EMAIL_1]]"}), the real value is inserted
// JSON-escaped, so a value containing " or \ can't break the JSON.
// =============================================================================

import { ENTITY_TYPES } from '../detectors/index.js';
import { makePlaceholder } from '../tags.js';

// The same tolerant pattern as the masker: [[EMAIL_1]], [EMAIL_1], [[ EMAIL_1 ]]
const TAG_PATTERN = new RegExp(`\\[\\[?\\s*(${ENTITY_TYPES.join('|')})_(\\d{1,6})\\s*\\]\\]?`, 'g');

// The longest text that could still turn into a tag, e.g. "[[ DRIVING_LICENCE_123456 ]]".
const LONGEST_TAG = 40;

/**
 * Returns where the "maybe the start of a tag" part begins at the end of `text`,
 * or text.length if nothing needs to be held back.
 *   "Hello [[EMA"   → 6   (hold back "[[EMA")
 *   "Hello [[PAN_1]" → 6  (the AI may still send the second "]")
 *   "Hello world"   → 11  (nothing to hold back)
 */
function holdBackFrom(text) {
  // 1. Where could a tag start? At the last "[" (or at "[[" if there are two).
  let start = text.lastIndexOf('[');
  if (start === -1) return text.length; //                  no "[" at all: nothing to hold
  if (start > 0 && text[start - 1] === '[') start -= 1; //  include the first "[" of "[["

  // 2. Too long ago to still be a tag? Then let it all out.
  const tail = text.slice(start);
  if (tail.length > LONGEST_TAG) return text.length;

  // 3. Hold it back only if it really looks like an unfinished tag.
  const unfinished = /^\[\[?\s*[A-Z_]*(_\d*)?\s*$/.test(tail); // "[[EMAIL_", "[[PAN_1"
  const singleClose = /^\[\[\s*[A-Z_]+_\d+\s*\]$/.test(tail); //  "[[PAN_1]" (only one "]" so far)
  return unfinished || singleClose ? start : text.length;
}

/**
 * Creates a restorer for ONE stream of text (one answer, or one tool call's arguments).
 * @param {Map<string, string>} values  tag → real value, e.g. '[[EMAIL_1]]' → 'rahul@abc.com'
 * @param {{ json?: boolean }} [options] json: true = insert values JSON-escaped
 */
export function createStreamRestorer(values, { json = false } = {}) {
  let held = ''; // text we're holding back because it might be the start of a tag

  /** Replaces every COMPLETE tag in the text with its real value (unknown tags stay). */
  function restore(text) {
    return text.replace(TAG_PATTERN, (match, type, number) => {
      const value = values.get(makePlaceholder(type, Number(number)));
      if (value === undefined) return match;
      return json ? JSON.stringify(value).slice(1, -1) : value; // slice: drop the surrounding quotes
    });
  }

  return {
    /** Adds the next piece; returns the text that is safe to send on now. */
    push(piece) {
      const text = held + (piece ?? '');
      const cut = holdBackFrom(text);
      held = text.slice(cut);
      return restore(text.slice(0, cut));
    },

    /** The stream has ended: returns whatever was still held back. */
    flush() {
      const rest = restore(held);
      held = '';
      return rest;
    },
  };
}
