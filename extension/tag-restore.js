// =============================================================================
// tag-restore.js: puts real values back into tags, even when a tag is SPLIT
// =============================================================================
//
// THE PROBLEM
// Chat sites don't always keep a tag in one piece of text. ChatGPT, for example,
// splits a reply into many small text pieces while it streams and formats it:
//
//     <strong>[[EMAIL</strong>…   or   "[[EMAIL" + "_1]]"   (two text nodes)
//
// Looking for "[[EMAIL_1]]" inside ONE piece finds nothing.
//
// THE SOLUTION
//   1. Join the text of all the pieces into one string, remembering where each starts.
//        pieces:   "Send it to [[EMAIL"  |  "_1]]"  |  " today"
//        joined:   "Send it to [[EMAIL_1]] today"
//   2. Find the tags in the joined string.
//   3. Write the value into the piece where the tag STARTS, and remove the rest of
//      the tag from the following pieces:
//        pieces:   "Send it to rahul@abc.com"  |  ""  |  " today"
//
// Only text changes; no elements are added or removed, so the site's own code isn't disturbed.
// Loaded before content.js (see manifest.json); also tested in gateway/test/extension.test.js.
// =============================================================================

// eslint-disable-next-line no-unused-vars
const SafeAiTagRestore = (() => {
  const TAG_PATTERN = /\[\[[A-Z_]+_\d+\]\]/g;

  /** All tags in the text pieces, including ones split across pieces. */
  function findTags(pieces) {
    const joined = pieces.map((p) => p.nodeValue).join('');
    return [...new Set(joined.match(TAG_PATTERN) ?? [])];
  }

  /**
   * Replaces every tag whose value `lookup(tag)` knows.
   * @param {{ nodeValue: string }[]} pieces  text nodes in page order
   * @param {(tag: string) => string | undefined} lookup
   * @returns {number} how many tags were replaced
   */
  function restore(pieces, lookup) {
    // Where each piece starts in the joined string.
    const starts = [];
    let joined = '';
    for (const piece of pieces) {
      starts.push(joined.length);
      joined += piece.nodeValue;
    }

    /** Index of the piece that contains character position `pos` of the joined string. */
    function pieceAt(pos) {
      let i = starts.length - 1;
      while (i > 0 && (starts[i] > pos || pieces[i].nodeValue.length === 0)) i -= 1;
      return i;
    }

    const matches = [...joined.matchAll(TAG_PATTERN)].filter((m) => lookup(m[0]) !== undefined);

    // Work from the LAST tag to the first, so earlier positions stay correct.
    for (const match of matches.reverse()) {
      const value = lookup(match[0]);
      const tagStart = match.index;
      const tagEnd = match.index + match[0].length; // exclusive
      const first = pieceAt(tagStart);
      const last = pieceAt(tagEnd - 1);

      const firstText = pieces[first].nodeValue;
      const startInFirst = tagStart - starts[first];

      if (first === last) {
        // The whole tag is inside one piece.
        const endInFirst = tagEnd - starts[first];
        pieces[first].nodeValue = firstText.slice(0, startInFirst) + value + firstText.slice(endInFirst);
      } else {
        // The tag spans several pieces: value goes in the first, the rest is removed.
        pieces[first].nodeValue = firstText.slice(0, startInFirst) + value;
        for (let i = first + 1; i < last; i++) pieces[i].nodeValue = '';
        pieces[last].nodeValue = pieces[last].nodeValue.slice(tagEnd - starts[last]);
      }
    }
    return matches.length;
  }

  return { findTags, restore, TAG_PATTERN };
})();
