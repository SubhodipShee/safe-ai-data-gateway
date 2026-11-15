// =============================================================================
// masker.js: turns real text into safe text, and back again
// =============================================================================
//
// MASKING (before the text goes to the AI):
//
//   "Email rahul@abc.com about PAN ABCPE1234F"
//                    │ 1. detect()  finds the email and the PAN
//                    │    codeGuard finds pasted company source code (Phase 5)
//                    │    nameFinder (local AI) finds people's names (Phase 6)
//                    │ 2. policies  decide: mask / block / allow
//                    │ 3. vault     gives a tag for each value (and stores it encrypted)
//                    │ 4. replace   swaps each value for its tag
//                    │ 5. audit     records WHAT was caught (never the value)
//                    ▼
//   "Email [[EMAIL_1]] about PAN [[PAN_1]]"
//
// UNMASKING (when the AI's reply comes back):
//
//   "Sure, I'll write to [[EMAIL_1]]."   →   "Sure, I'll write to rahul@abc.com."
//
// The AI never sees the real values, but the user sees a normal reply.
// =============================================================================

import { detect, resolveOverlaps, summarize, countObfuscated, ENTITY_TYPES } from './detectors/index.js';
import { getPolicies, actionFor } from './policies.js';

// -----------------------------------------------------------------------------
// Finding tags in the AI's reply
// -----------------------------------------------------------------------------
// AIs sometimes change our tags slightly, so we accept small variations:
//   [[EMAIL_1]]      exactly as we wrote it
//   [EMAIL_1]        single brackets
//   [[ EMAIL_1 ]]    extra spaces
//   [[EMAIL_1]       a bracket missing
//
// How the pattern reads:
//   \[\[?        "[" or "[["
//   \s*          optional spaces
//   (EMAIL|PAN…) one of OUR types (group 1), so random text like [[TODO_1]] is ignored
//   _(\d{1,6})   underscore + the number (group 2)
//   \s*          optional spaces
//   \]\]?        "]" or "]]"
const TAG_PATTERN = new RegExp(`\\[\\[?\\s*(${ENTITY_TYPES.join('|')})_(\\d{1,6})\\s*\\]\\]?`, 'g');

/** The exact tag format we store in the vault, e.g. canonicalTag('EMAIL', '01') → '[[EMAIL_1]]' */
function canonicalTag(type, number) {
  return `[[${type}_${Number(number)}]]`;
}

/**
 * Replaces parts of the text with their tags.
 * `items` must be sorted by position and must not overlap (detect() guarantees both).
 *
 * Example:  text  = "Email rahul@abc.com now"
 *           items = [{ start: 6, end: 19, placeholder: '[[EMAIL_1]]' }]
 *           →       "Email [[EMAIL_1]] now"
 */
function replaceWithTags(text, items) {
  let result = '';
  let position = 0; // how far through the original text we've copied

  for (const item of items) {
    result += text.slice(position, item.start); // copy the normal text before this item
    result += item.placeholder; //                  then the tag instead of the value
    position = item.end; //                         then continue after the value
  }

  result += text.slice(position); // copy whatever is left after the last item
  return result;
}

/**
 * Creates the masker.
 * @param {object} options
 * @param {object} options.vault       the vault from createVault() (see vault.js)
 * @param {object} options.auditChain  the audit chain from createAuditChain() (see audit/audit-chain.js)
 * @param {object} [options.codeGuard] the private-code checker from createCodeGuard() (see code/code-guard.js)
 * @param {object} [options.nameFinder] the local AI name finder from createNameFinder() (see ai/name-finder.js)
 */
export function createMasker({ vault, auditChain, codeGuard, nameFinder }) {
  /**
   * Writes one audit entry per type, e.g. { entityType: 'EMAIL', count: 2, obfuscatedCount: 1, action: 'masked' }.
   * Only TYPES and COUNTS are recorded, never the sensitive values.
   * Entries go through the hash chain, so they can't be edited later without it being detected.
   */
  async function writeAuditLog(sessionId, source, findings, action) {
    const countsPerType = summarize(findings); // e.g. { EMAIL: 2, PAN: 1 }
    const entries = Object.entries(countsPerType).map(([entityType, count]) => ({
      sessionId,
      source,
      entityType,
      count,
      obfuscatedCount: countObfuscated(findings.filter((f) => f.type === entityType)),
      action,
    }));
    if (entries.length > 0) {
      await auditChain.append(entries);
    }
  }

  /**
   * Masks sensitive data in a piece of text.
   *
   * @param {object} input
   * @param {string} input.sessionId  the chat session
   * @param {string} input.text       what the user wants to send to the AI
   * @param {string} [input.source]   where it came from, e.g. "chatgpt.com" (for the audit log)
   * @param {boolean} [input.audit=true]  false = don't log (used for chat HISTORY that was
   *                                    already logged when it was first sent; see chat-proxy.js)
   * @param {boolean} [input.findNames=true]  false = skip the name-finding AI (used for Claude Code's
   *                                    own instructions, where it would wrongly mask "Claude"; Phase 14)
   * @returns {Promise<object>} one of:
   *   { blocked: false, maskedText: "…[[EMAIL_1]]…", items: [{ type, label, placeholder, obfuscated }],
   *     summary, bypassAttempts }
   *   { blocked: true,  blockedTypes: { PRIVATE_KEY: 1 }, bypassAttempts }
   *   (bypassAttempts = how many values were disguised, e.g. Devanagari digits)
   */
  async function maskText({ sessionId, text, source, audit = true, findNames = true }) {
    // ---- Step 1: find everything sensitive ----
    // Personal data and secrets (fast, in memory)…
    const dataFindings = detect(text);
    // …plus the company's private source code (needs the database)…
    const codeFindings = codeGuard ? await codeGuard.check(text) : [];
    // …plus people's names (local AI model, Phase 6).
    const nameFindings = nameFinder && findNames ? await nameFinder.find(text) : [];
    // When findings overlap (e.g. a key INSIDE pasted code, or "rahul" inside an email
    // address), the longer one wins.
    const findings = resolveOverlaps([...dataFindings, ...codeFindings, ...nameFindings]);

    // ---- Step 2: check the policies ----
    const policies = await getPolicies();

    // If ANY finding is "block", stop here and send nothing.
    const blockedFindings = findings.filter((f) => actionFor(policies, f.type) === 'block');
    if (blockedFindings.length > 0) {
      if (audit) await writeAuditLog(sessionId, source, blockedFindings, 'blocked');
      return {
        blocked: true,
        blockedTypes: summarize(blockedFindings),
        // Type + label only (e.g. which registered file the code came from), never the value.
        blockedItems: blockedFindings.map(({ type, label }) => ({ type, label })),
        bypassAttempts: countObfuscated(blockedFindings),
      };
    }

    // "allow" findings are simply left in the text; only "mask" findings get tags.
    const findingsToMask = findings.filter((f) => actionFor(policies, f.type) === 'mask');

    // ---- Step 3: get a tag for each value from the vault ----
    // Within ONE type we go in order, so the FIRST email in the text becomes [[EMAIL_1]].
    // DIFFERENT types don't affect each other's numbers, so they run in parallel
    // (emails, PANs and phones are looked up at the same time, which is much faster on Atlas).
    // `tagsInThisText` avoids asking the vault twice when a value is repeated in the same text.
    const tagsInThisText = new Map();
    const findingsByType = Map.groupBy(findingsToMask, (finding) => finding.type);

    await Promise.all(
      [...findingsByType.values()].map(async (findingsOfOneType) => {
        for (const finding of findingsOfOneType) {
          const key = `${finding.type}:${finding.value}`;
          if (!tagsInThisText.has(key)) {
            tagsInThisText.set(key, await vault.getOrCreatePlaceholder(sessionId, finding.type, finding.value));
          }
        }
      }),
    );

    // Back in text order, each finding with its tag.
    const items = findingsToMask.map((finding) => ({
      ...finding,
      placeholder: tagsInThisText.get(`${finding.type}:${finding.value}`),
    }));

    // ---- Step 4: swap the values for their tags ----
    const maskedText = replaceWithTags(text, items);

    // ---- Step 5: record what was caught ----
    if (audit) await writeAuditLog(sessionId, source, items, 'masked');

    // The response never includes the real values, only types and tags.
    return {
      blocked: false,
      maskedText,
      items: items.map(({ type, label, placeholder, obfuscated }) => ({
        type,
        label,
        placeholder,
        obfuscated: Boolean(obfuscated),
      })),
      summary: summarize(items),
      bypassAttempts: countObfuscated(items),
    };
  }

  /**
   * Puts the real values back into the AI's reply.
   *
   * @param {object} input
   * @param {string} input.sessionId
   * @param {string} input.text  the AI's reply, containing tags like [[EMAIL_1]]
   * @returns {Promise<{ text: string, restored: number, unknown: string[] }>}
   *   restored = how many tags were replaced
   *   unknown  = tags we couldn't restore (wrong session, expired, or made up by the AI)
   */
  async function unmaskText({ sessionId, text }) {
    // ---- Step 1: find all tags in the reply ----
    const matches = [...text.matchAll(TAG_PATTERN)];
    if (matches.length === 0) {
      return { text, restored: 0, unknown: [] };
    }

    // ---- Step 2: ask the vault for the real values (one database query) ----
    const tags = matches.map((match) => canonicalTag(match[1], match[2]));
    const realValues = await vault.revealPlaceholders(sessionId, tags);

    // ---- Step 3: replace each tag with its real value ----
    let restored = 0;
    const unknown = new Set();

    const restoredText = text.replace(TAG_PATTERN, (wholeMatch, type, number) => {
      const tag = canonicalTag(type, number);
      const realValue = realValues.get(tag);

      if (realValue === undefined) {
        unknown.add(tag);
        return wholeMatch; // leave it exactly as the AI wrote it
      }
      restored += 1;
      return realValue;
    });

    return { text: restoredText, restored, unknown: [...unknown] };
  }

  return { maskText, unmaskText };
}
