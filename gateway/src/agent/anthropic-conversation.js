// =============================================================================
// agent/anthropic-conversation.js: masks and restores Claude Code's requests (Phase 14)
// =============================================================================
//
// Claude Code speaks Anthropic's "Messages" format. Text hides in these places,
// and every one is masked:
//
//   system:   "…instructions, your CLAUDE.md, environment info…"   (string or text blocks)
//   messages: [{ role, content: "…" }]                             (string), or blocks:
//     { type: 'text',        text: '…' }                           what you typed
//     { type: 'tool_use',    input: { file_path: '…', content: '…' } }   tools Claude used
//     { type: 'tool_result', content: '…' or [{ type: 'text', text }] }  A FILE IT READ
//
// LEFT EXACTLY AS THEY ARE (Anthropic's compatibility rules):
//   - "thinking" blocks: they carry a signature; changing one breaks the request.
//     (They only ever contain tags anyway: the AI never saw a real value.)
//   - every other field: cache_control, tools, model, metadata… (only text values change)
//
// Restoring the answer is the reverse: text blocks and tool inputs get the real
// values back; thinking stays as the AI wrote it.
// =============================================================================

import { createTextMasker } from './mask-conversation.js';
import { createStreamRestorer } from './stream-restorer.js';

// ---------------------------------------------------------------------------
// Masking the request
// ---------------------------------------------------------------------------

/** Masks every string inside a tool's input (any depth): { path: 'a', text: 'PAN …' } */
async function maskValues(value, maskText) {
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return Promise.all(value.map((item) => maskValues(item, maskText)));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = await maskValues(item, maskText);
    return copy;
  }
  return value; // numbers, true/false, null
}

/** Masks one content block. Only the text inside changes; all other fields stay. */
async function maskBlock(block, maskText) {
  switch (block?.type) {
    case 'text':
      return { ...block, text: await maskText(block.text) };
    case 'tool_use':
      return { ...block, input: await maskValues(block.input, maskText) };
    case 'tool_result':
      if (typeof block.content === 'string') return { ...block, content: await maskText(block.content) };
      if (Array.isArray(block.content)) {
        return { ...block, content: await Promise.all(block.content.map((inner) => maskBlock(inner, maskText))) };
      }
      return block;
    default:
      return block; // thinking, images, documents…: unchanged
  }
}

/** Masks a string or a list of blocks. */
async function maskContent(content, maskText) {
  if (typeof content === 'string') return maskText(content);
  if (Array.isArray(content)) return Promise.all(content.map((block) => maskBlock(block, maskText)));
  return content;
}

/**
 * Masks a whole Claude Code request body. Returns a masked COPY (the original isn't changed).
 * @param {object} options
 * @param {object} options.masker     from createMasker()
 * @param {string} options.sessionId  one session per Claude Code session = the same tags all along
 * @param {string} options.source     for the audit log, e.g. "claude-code:anthropic"
 * @param {object} options.body       the request body Claude Code sent
 * @param {boolean} [options.findNames=true]  false = don't look for people's names (online)
 * @returns {Promise<{ body: object, tags: Set<string>, found: object }>}
 *          found = what was hidden in new text, by type, e.g. { PAN: 1 }
 * @throws {BlockedError} if a "block" policy matches (see mask-conversation.js)
 */
export async function maskAnthropicRequest({ masker, sessionId, source, body, findNames = true }) {
  const texts = createTextMasker({ masker, sessionId, source, findNames });

  // Claude Code's own instructions: all detectors EXCEPT the name-finding AI,
  // which would mistake "Claude" for a person's name.
  const maskInstructions = (text) => texts.mask(text, { findNames: false });
  const maskText = (text) => texts.mask(text);

  const masked = { ...body };
  if (body.system !== undefined) masked.system = await maskContent(body.system, maskInstructions);
  if (Array.isArray(body.messages)) {
    masked.messages = [];
    for (const message of body.messages) {
      // role "system" entries in the middle of a conversation are reminders from Claude Code.
      const maskThis = message?.role === 'system' ? maskInstructions : maskText;
      masked.messages.push({ ...message, content: await maskContent(message?.content, maskThis) });
    }
  }
  return { body: masked, tags: texts.tags, found: texts.found };
}

// ---------------------------------------------------------------------------
// Restoring the answer
// ---------------------------------------------------------------------------

/** Puts real values back into every string of a tool input (any depth). */
function restoreValues(value, restoreText) {
  if (typeof value === 'string') return restoreText(value);
  if (Array.isArray(value)) return value.map((item) => restoreValues(item, restoreText));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreValues(item, restoreText)]));
  }
  return value;
}

/** Restores a complete (not streamed) answer: text blocks and tool inputs. */
export function restoreAnthropicAnswer(answer, values) {
  const restoreText = (text) => {
    const restorer = createStreamRestorer(values);
    return restorer.push(text) + restorer.flush();
  };
  for (const block of answer.content ?? []) {
    if (block.type === 'text') block.text = restoreText(block.text);
    if (block.type === 'tool_use') block.input = restoreValues(block.input, restoreText);
  }
  return answer;
}

/**
 * Restores a STREAMED answer, one event at a time. Anthropic streams events like:
 *   content_block_start  { index: 0, content_block: { type: 'text' } }
 *   content_block_delta  { index: 0, delta: { type: 'text_delta', text: 'Hello [[EM' } }
 *   content_block_delta  { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path' } }
 *   content_block_stop   { index: 0 }
 * Each content block gets its own restorer (JSON mode for tool inputs). Thinking is left alone.
 *
 * fix(event) returns the list of events to send on: usually just the event itself, but
 * before a content_block_stop it may first add one delta with text that was held back.
 */
export function createAnthropicStreamRestorer(values) {
  const restorers = new Map(); // block index → { restorer, kind: 'text' | 'json' }

  return {
    fix(event) {
      if (event.type === 'content_block_start') {
        const type = event.content_block?.type;
        if (type === 'text') restorers.set(event.index, { restorer: createStreamRestorer(values), kind: 'text' });
        if (type === 'tool_use') restorers.set(event.index, { restorer: createStreamRestorer(values, { json: true }), kind: 'json' });
        // A text block can start with some text already in it.
        const entry = restorers.get(event.index);
        if (entry && type === 'text' && event.content_block.text) event.content_block.text = entry.restorer.push(event.content_block.text);
        return [event];
      }

      if (event.type === 'content_block_delta') {
        const entry = restorers.get(event.index);
        if (entry?.kind === 'text' && event.delta?.type === 'text_delta') event.delta.text = entry.restorer.push(event.delta.text);
        if (entry?.kind === 'json' && event.delta?.type === 'input_json_delta') event.delta.partial_json = entry.restorer.push(event.delta.partial_json);
        return [event];
      }

      if (event.type === 'content_block_stop') {
        const entry = restorers.get(event.index);
        restorers.delete(event.index);
        const rest = entry?.restorer.flush();
        if (!rest) return [event];
        // Send the held-back text as one more delta, just before the block ends.
        const delta = entry.kind === 'text'
          ? { type: 'text_delta', text: rest }
          : { type: 'input_json_delta', partial_json: rest };
        return [{ type: 'content_block_delta', index: event.index, delta }, event];
      }

      return [event]; // message_start, message_delta, message_stop, ping, thinking…: unchanged
    },
  };
}
