// =============================================================================
// agent/mask-conversation.js: masks a WHOLE coding-agent conversation
// =============================================================================
//
// A coding agent (Cline, Continue, Aider…) sends much more than your message.
// Text hides in several places of each request, and ALL of it must be masked:
//
//   { role: 'system',    content: 'You are a coding agent…' }
//   { role: 'user',      content: 'Fix the refund for rahul@abc.com' }               ← your message
//   { role: 'assistant', tool_calls: [{ function: { arguments: '{"path":"a.js"}' } }] }  ← what the AI asked for
//   { role: 'tool',      content: 'const PAN = "ABCPE1234F"; …' }                     ← A FILE IT READ
//
// SPEED: agents resend the whole conversation at EVERY step. Masking the same old
// text again and again would be slow, so each masked text is remembered (by its
// SHA-256 fingerprint, never the text itself) and only new text is checked.
// =============================================================================

import { createHash } from 'node:crypto';
import { MAX_TEXT_LENGTH } from '../detectors/index.js';

const TAG = /\[\[[A-Z_]+_\d+\]\]/g;
const PIECE_SIZE = 100_000; // longer texts (big files) are masked in pieces of this size
const REMEMBERED_TEXTS = 5_000; // how many masked texts to keep in memory

// sessionId + fingerprint of the original text → the masked text.
const remembered = new Map();

/** SHA-256 fingerprint of a text (so we never keep the raw text as a key). */
const fingerprint = (text) => createHash('sha256').update(text).digest('hex');

/** Splits a very long text into pieces at line breaks, so each piece can be masked. */
function splitIntoPieces(text) {
  if (text.length <= MAX_TEXT_LENGTH) return [text];
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + PIECE_SIZE, text.length);
    const lineBreak = text.lastIndexOf('\n', end);
    if (end < text.length && lineBreak > start) end = lineBreak + 1;
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

/** Thrown when the conversation contains something that must never reach an AI. */
export class BlockedError extends Error {
  constructor(result) {
    super('Blocked by policy');
    this.blockedTypes = result.blockedTypes;
    this.blockedItems = result.blockedItems;
  }
}

/**
 * Creates a masker for the texts of ONE conversation. Used by both coding-agent formats
 * (OpenAI here, Anthropic in anthropic-conversation.js).
 *   const texts = createTextMasker({ masker, sessionId, source });
 *   await texts.mask('mail rahul@abc.com')  → 'mail [[EMAIL_1]]'
 *   texts.tags                              → Set { '[[EMAIL_1]]' }  (every tag seen)
 * Only NEW text is checked (and written to the audit log); repeated text comes from memory.
 */
export function createTextMasker({ masker, sessionId, source }) {
  const tags = new Set();
  let protectedCount = 0;

  /**
   * Masks one text.
   * @param {object} [options]
   * @param {boolean} [options.findNames=true]  false = skip the name-finding AI
   */
  async function mask(text, { findNames = true } = {}) {
    if (typeof text !== 'string' || text === '') return text;
    const key = `${sessionId}:${findNames ? 'n' : '-'}:${fingerprint(text)}`;

    let masked = remembered.get(key);
    if (masked === undefined) {
      masked = '';
      for (const piece of splitIntoPieces(text)) {
        const result = await masker.maskText({ sessionId, text: piece, source, findNames });
        if (result.blocked) throw new BlockedError(result);
        masked += result.maskedText;
        protectedCount += result.items.length;
      }
      remembered.set(key, masked);
      if (remembered.size > REMEMBERED_TEXTS) remembered.delete(remembered.keys().next().value); // forget the oldest
    }

    for (const tag of masked.match(TAG) ?? []) tags.add(tag);
    return masked;
  }

  return {
    mask,
    tags,
    get protectedCount() {
      return protectedCount;
    },
  };
}

/**
 * Masks every piece of text in an OpenAI-style conversation.
 * @param {object} options
 * @param {object} options.masker     from createMasker()
 * @param {string} options.sessionId  same session for the whole conversation = same tags
 * @param {object[]} options.messages the agent's messages (not changed; a masked copy is returned)
 * @param {string} options.source     for the audit log, e.g. "coding-agent:groq"
 * @returns {Promise<{ messages: object[], tags: Set<string>, protectedCount: number }>}
 * @throws {BlockedError} if a "block" policy matches
 */
export async function maskConversation({ masker, sessionId, messages, source }) {
  const texts = createTextMasker({ masker, sessionId, source });
  const maskOne = (text) => texts.mask(text);

  const maskedMessages = [];
  for (const message of messages) {
    const copy = { ...message };

    // 1. The message text: either a string, or a list of parts like { type: 'text', text }.
    if (typeof copy.content === 'string') {
      copy.content = await maskOne(copy.content);
    } else if (Array.isArray(copy.content)) {
      copy.content = await Promise.all(copy.content.map(async (part) => (
        part?.type === 'text' ? { ...part, text: await maskOne(part.text) } : part
      )));
    }

    // 2. Tool calls the AI made earlier (their arguments can contain file contents).
    if (Array.isArray(copy.tool_calls)) {
      copy.tool_calls = await Promise.all(copy.tool_calls.map(async (call) => (
        call?.function
          ? { ...call, function: { ...call.function, arguments: await maskOne(call.function.arguments) } }
          : call
      )));
    }

    maskedMessages.push(copy);
  }

  return { messages: maskedMessages, tags: texts.tags, protectedCount: texts.protectedCount };
}
