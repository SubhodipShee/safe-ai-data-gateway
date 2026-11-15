// =============================================================================
// routes/agent-proxy.js: the AI proxy for CODING AGENTS (Phase 12)
// =============================================================================
//
//   POST /agent/v1/chat/completions   OpenAI format, with tools and streaming
//   GET  /agent/v1/models             the model list some agents ask for
//
// Coding agents (Cline, Continue, Aider…) let you choose an "OpenAI-compatible"
// AI with your own address. Point them at the gateway:
//
//   Base URL:  http://127.0.0.1:7000/agent/v1
//   API key:   anything on your laptop (AGENT_KEY when the gateway is online)
//
// Then EVERYTHING the agent sends goes through the masker first, including the
// files it reads. The AI only sees tags; the agent gets the real values back.
//
//   agent ──► 1. mask the whole conversation ──► 2. AI provider ──► 3. restore ──► agent
//             (your message, file contents,        sees only         (also inside the
//              earlier tool calls)                  [[PAN_1]]…        tool calls it writes)
//
// This is separate from /v1/chat/completions (used by the playground), which stays as it is.
//
// PRIVATE BY DESIGN: online (public mode) this endpoint is OFF unless AGENT_KEY is set,
// and then it only works with that key. So nobody else can use your server or AI quota.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { isValidSessionId } from '../vault.js';
import { AiProviderError } from '../ai/llm-client.js';
import { requireDatabase } from '../http-helpers.js';
import { requireBearerKey } from '../security.js';
import { maskConversation, BlockedError } from '../agent/mask-conversation.js';
import { createStreamRestorer } from '../agent/stream-restorer.js';

const MAX_MESSAGES = 2000; // agents send long conversations
const MAX_BODY = '20mb'; //   …and big files

// The same reminder the playground proxy uses, so the AI copies tags exactly.
const KEEP_TAGS_INSTRUCTION =
  'Some values in this conversation are replaced by placeholders like [[EMAIL_1]] or [[API_KEY_2]]. ' +
  'Treat each placeholder as the real value, and when you refer to it (also in code and tool calls), ' +
  'copy the placeholder EXACTLY. Never invent new placeholders.';

/** Sends an error in OpenAI's format, so the agent shows a clear message. */
function openAiError(res, status, message, type, extra = {}) {
  return res.status(status).json({ error: { message, type, ...extra } });
}

/**
 * Picks the session for this conversation, so the same value gets the same tag at every step.
 * Agents don't send a conversation ID, but they always resend the FIRST user message,
 * so its fingerprint identifies the conversation. (Only the fingerprint is used, never the text.)
 */
function sessionFor(req, messages) {
  const requested = req.get('X-Session-Id');
  if (requested && isValidSessionId(requested)) return requested;
  const firstUser = messages.find((m) => m?.role === 'user');
  if (!firstUser) return randomUUID();
  return createHash('sha256').update(`agent:${JSON.stringify(firstUser.content)}`).digest('hex').slice(0, 32);
}

/** Adds the "keep the tags exactly" reminder to the system message (or as a new one). */
function withKeepTagsInstruction(messages) {
  const [first, ...rest] = messages;
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${first.content}\n\n${KEEP_TAGS_INSTRUCTION}` }, ...rest];
  }
  return [{ role: 'system', content: KEEP_TAGS_INSTRUCTION }, ...messages];
}

// -----------------------------------------------------------------------------
// Restoring the AI's answer
// -----------------------------------------------------------------------------

/** Restores a complete (not streamed) answer: the text and any tool calls. */
function restoreFullAnswer(answer, values) {
  const restoreText = (text, json) => {
    if (typeof text !== 'string') return text;
    const restorer = createStreamRestorer(values, { json });
    return restorer.push(text) + restorer.flush();
  };
  for (const choice of answer.choices ?? []) {
    const message = choice.message ?? {};
    message.content = restoreText(message.content, false);
    for (const call of message.tool_calls ?? []) {
      if (call.function) call.function.arguments = restoreText(call.function.arguments, true);
    }
  }
  return answer;
}

/**
 * Keeps one restorer per piece of a streamed answer: the text of each choice, and the
 * arguments of each tool call (JSON mode). Each streamed "chunk" is fixed up in place.
 */
function createChunkRestorer(values) {
  const restorers = new Map(); // "0:text" or "0:tool:1" → restorer

  function restorerFor(key, json) {
    if (!restorers.has(key)) restorers.set(key, createStreamRestorer(values, { json }));
    return restorers.get(key);
  }

  return {
    /** Restores the tags in one chunk. At the end of a choice, lets out anything held back. */
    fix(chunk) {
      for (const choice of chunk.choices ?? []) {
        const delta = (choice.delta ??= {});
        const textRestorer = restorerFor(`${choice.index}:text`, false);
        if (typeof delta.content === 'string') delta.content = textRestorer.push(delta.content);

        for (const call of delta.tool_calls ?? []) {
          if (typeof call.function?.arguments === 'string') {
            call.function.arguments = restorerFor(`${choice.index}:tool:${call.index}`, true).push(call.function.arguments);
          }
        }

        if (choice.finish_reason) {
          // This choice is finished: nothing more will come, so let out what's held back.
          const restText = textRestorer.flush();
          if (restText) delta.content = (delta.content ?? '') + restText;
          for (const [key, restorer] of restorers) {
            const [index, kind, toolIndex] = key.split(':');
            if (Number(index) !== choice.index || kind !== 'tool') continue;
            const rest = restorer.flush();
            if (rest) (delta.tool_calls ??= []).push({ index: Number(toolIndex), function: { arguments: rest } });
          }
        }
      }
      return chunk;
    },
  };
}

/**
 * Passes a streamed answer on to the agent, restoring tags as it goes.
 * The stream is "server-sent events": lines like  data: {...json chunk...}  and finally  data: [DONE]
 */
async function relayStream(upstream, res, values) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const chunks = createChunkRestorer(values);
  const reader = upstream.body.getReader();
  res.on('close', () => reader.cancel().catch(() => {})); // the agent stopped: stop reading too

  const decoder = new TextDecoder();
  let unfinishedLine = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = (unfinishedLine + decoder.decode(value, { stream: true })).split('\n');
    unfinishedLine = lines.pop(); // the last line may be cut off: keep it for the next round

    for (const line of lines) {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') {
        res.write(`${line}\n`); // blank lines, comments and [DONE] pass through unchanged
        continue;
      }
      try {
        const chunk = JSON.parse(line.slice(5));
        res.write(`data: ${JSON.stringify(chunks.fix(chunk))}\n`);
      } catch {
        res.write(`${line}\n`); // not JSON: pass it on as it is
      }
    }
  }
  if (unfinishedLine) res.write(unfinishedLine);
  res.end();
}

// -----------------------------------------------------------------------------
// The route
// -----------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.masker       from createMasker()
 * @param {object} options.vault        from createVault() (to look up the tags' real values)
 * @param {object} options.llm          from createLlmClient()
 * @param {string} options.providerKey  e.g. 'groq' (for the audit log)
 * @param {boolean} options.isPublic    online? Then AGENT_KEY is required
 * @param {string} [options.agentKey]   the AGENT_KEY setting
 */
export function agentProxyRoute({ masker, vault, llm, providerKey, isPublic, agentKey }) {
  const router = express.Router();

  // Online without an AGENT_KEY: switched off completely.
  router.use('/agent', (req, res, next) => {
    if (isPublic && !agentKey) {
      return openAiError(res, 403, 'The coding-agent proxy is turned off on this server.', 'permission_error');
    }
    next();
  });
  router.use('/agent', requireBearerKey(agentKey, { error: { message: 'Wrong or missing API key (use your AGENT_KEY).', type: 'authentication_error' } }));
  router.use('/agent', express.json({ limit: MAX_BODY }), requireDatabase);

  // ---- GET /agent/v1/models: some agents check which models exist ----
  router.get('/agent/v1/models', (req, res) => {
    res.json({ object: 'list', data: [{ id: llm.model, object: 'model', owned_by: llm.providerName }] });
  });

  // ---- POST /agent/v1/chat/completions ----
  router.post('/agent/v1/chat/completions', async (req, res) => {
    const body = req.body ?? {};
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
      return openAiError(res, 400, `"messages" must be a list of 1–${MAX_MESSAGES} messages.`, 'invalid_request_error');
    }
    if (!llm.configured) {
      return openAiError(res, 503, 'No AI provider is configured on the gateway (AI_API_KEY is empty).', 'gateway_error');
    }

    const sessionId = sessionFor(req, body.messages);
    const origin = (req.get('X-Gateway-Source') || 'coding-agent').replace(/[^\w.-]/g, '').slice(0, 50) || 'coding-agent';
    const source = `${origin}:${providerKey}`;

    // ---- Step 1: mask the whole conversation ----
    let masked;
    try {
      masked = await maskConversation({ masker, sessionId, messages: body.messages, source });
    } catch (error) {
      if (!(error instanceof BlockedError)) throw error;
      return openAiError(res, 403, 'Blocked by policy: the conversation contains data that must never be sent to an AI.', 'policy_violation', {
        code: 'blocked',
        blocked_types: error.blockedTypes,
        blocked_items: error.blockedItems,
      });
    }
    const messages = masked.tags.size > 0 ? withKeepTagsInstruction(masked.messages) : masked.messages;

    // The AI can only refer to tags it has seen, so look up just those, once.
    const values = await vault.revealPlaceholders(sessionId, [...masked.tags]);

    // ---- Step 2: send it to the AI ----
    let upstream;
    try {
      upstream = await llm.forward({ ...body, messages });
    } catch (error) {
      if (!(error instanceof AiProviderError)) throw error;
      if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
      return openAiError(res, error.status, error.message, 'provider_error');
    }

    // ---- Step 3: restore the real values in the answer ----
    res.set('X-Session-Id', sessionId);
    if (body.stream !== true) return res.json(restoreFullAnswer(await upstream.json(), values));
    try {
      await relayStream(upstream, res, values);
    } catch (error) {
      // The connection to the AI broke halfway. The answer has already started, so
      // we can't send an error page any more: just end it cleanly.
      console.warn(`[agent] stream ended early: ${error.message}`);
      res.end();
    }
  });

  return router;
}
