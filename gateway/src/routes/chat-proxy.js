// =============================================================================
// routes/chat-proxy.js: POST /v1/chat/completions (the AI proxy)
// =============================================================================
//
// This endpoint speaks the SAME format as OpenAI's API. So a developer whose code
// calls ChatGPT only changes one line, the base URL, to send everything through
// the gateway:
//
//   before:  https://api.openai.com/v1/chat/completions
//   after:   http://<gateway>/v1/chat/completions
//
// WHAT HAPPENS TO EACH REQUEST
//
//   your app ──► 1. MASK every message ──► 2. AI provider ──► 3. UNMASK the reply ──► your app
//                "Email rahul@abc.com"      sees only            "Done, wrote to
//                → "Email [[EMAIL_1]]"      [[EMAIL_1]]          rahul@abc.com"
//
//   If a message contains something BLOCKED (e.g. a private key or company code),
//   step 2 never happens: the AI provider receives nothing at all.
//
// OPTIONAL HEADERS
//   X-Session-Id: <uuid>        keep the same tags across a whole conversation
//   X-Gateway-Source: <name>    where the request comes from (for the audit log)
//
// Streaming ("stream": true) isn't supported yet.
// =============================================================================

import { randomUUID } from 'node:crypto';
import express from 'express';
import { isValidSessionId } from '../vault.js';
import { AiProviderError } from '../ai/llm-client.js';

const MAX_MESSAGES = 50;

// Added in front of the conversation when it contains tags. Some models otherwise
// "tidy up" or drop tags like [[EMAIL_1]], and a dropped tag can't be restored.
const KEEP_TAGS_INSTRUCTION =
  'Some values in this conversation are replaced by placeholders like [[EMAIL_1]] or [[PERSON_2]]. ' +
  'Treat each placeholder as the real value, and when you refer to it, copy the placeholder EXACTLY ' +
  '(same brackets, letters and number). Never invent new placeholders.';
const HAS_TAG = /\[\[[A-Z_]+_\d+\]\]/;
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

/** Sends an error in OpenAI's format, so existing OpenAI client libraries understand it. */
function openAiError(res, status, message, type, extra = {}) {
  return res.status(status).json({ error: { message, type, ...extra } });
}

/**
 * Gets the text of a message. OpenAI allows either a string or a list of parts
 * like [{ type: 'text', text: '…' }]. Images etc. aren't supported (they can't be masked).
 * Returns null if the message can't be handled.
 */
function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content) && message.content.every((part) => part?.type === 'text' && typeof part.text === 'string')) {
    return message.content.map((part) => part.text).join('\n');
  }
  return null;
}

/**
 * @param {object} options
 * @param {object} options.masker  from createMasker()
 * @param {object} options.llm     from createLlmClient()
 * @param {string} options.providerKey  e.g. 'groq' (recorded in the audit log source)
 */
export function chatProxyRoute({ masker, llm, providerKey }) {
  const router = express.Router();

  router.post('/v1/chat/completions', async (req, res) => {
    const body = req.body ?? {};

    // ---- Check the request ----
    if (body.stream === true) {
      return openAiError(res, 400, 'Streaming is not supported yet. Send "stream": false.', 'invalid_request_error');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
      return openAiError(res, 400, `"messages" must be a list of 1–${MAX_MESSAGES} messages.`, 'invalid_request_error');
    }
    const messages = [];
    for (const message of body.messages) {
      const text = messageText(message);
      if (!ALLOWED_ROLES.has(message?.role) || text === null) {
        return openAiError(res, 400, 'Each message needs a role (system/user/assistant) and text content.', 'invalid_request_error');
      }
      messages.push({ role: message.role, content: text });
    }

    const requestedSession = req.get('X-Session-Id');
    if (requestedSession !== undefined && !isValidSessionId(requestedSession)) {
      return openAiError(res, 400, 'X-Session-Id must be 16–64 letters, digits, "_" or "-".', 'invalid_request_error');
    }
    const sessionId = requestedSession ?? randomUUID();
    const origin = (req.get('X-Gateway-Source') || 'api-proxy').replace(/[^\w.-]/g, '').slice(0, 50) || 'api-proxy';
    const source = `${origin}:${providerKey}`; // e.g. "api-proxy:groq"

    if (!llm.configured) {
      return openAiError(res, 503, 'No AI provider is configured on the gateway (AI_API_KEY is empty).', 'gateway_error');
    }

    // ---- Step 1: mask EVERY message (one session, so the same value = the same tag) ----
    // Only the NEWEST message is written to the audit log: the earlier ones are the
    // conversation history, which was already logged when it was first sent.
    const maskedMessages = [];
    const protectedCounts = {};
    let bypassAttempts = 0;

    for (let i = 0; i < messages.length; i++) {
      const isNewest = i === messages.length - 1;
      const result = await masker.maskText({ sessionId, text: messages[i].content, source, audit: isNewest });

      if (result.blocked) {
        // Nothing is sent to the AI provider at all.
        return openAiError(res, 403, 'Blocked by policy: the conversation contains data that must never be sent to an AI.', 'policy_violation', {
          code: 'blocked',
          blocked_types: result.blockedTypes,
          blocked_items: result.blockedItems,
        });
      }

      maskedMessages.push({ role: messages[i].role, content: result.maskedText });
      if (isNewest) {
        for (const [type, count] of Object.entries(result.summary)) protectedCounts[type] = count;
        bypassAttempts = result.bypassAttempts;
      }
    }

    // ---- Step 2: ask the AI (it only ever sees the masked messages) ----
    // If anything was replaced by a tag, first tell the AI to keep the tags intact.
    const anyTags = maskedMessages.some((m) => HAS_TAG.test(m.content));
    const messagesForAi = anyTags ? [{ role: 'system', content: KEEP_TAGS_INSTRUCTION }, ...maskedMessages] : maskedMessages;

    let reply;
    try {
      reply = await llm.chat(messagesForAi, {
        temperature: typeof body.temperature === 'number' ? Math.min(Math.max(body.temperature, 0), 2) : undefined,
        maxTokens: Number.isInteger(body.max_tokens) ? Math.min(body.max_tokens, 4096) : undefined,
      });
    } catch (error) {
      if (!(error instanceof AiProviderError)) throw error;
      if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
      return openAiError(res, error.status, error.message, 'provider_error');
    }

    // ---- Step 3: put the real values back into the reply ----
    const restored = await masker.unmaskText({ sessionId, text: reply.content });

    res.set('X-Session-Id', sessionId);
    res.json({
      // The normal OpenAI response shape…
      id: `chatcmpl-gw-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: reply.model,
      choices: [{ index: 0, message: { role: 'assistant', content: restored.text }, finish_reason: reply.finishReason ?? 'stop' }],
      usage: reply.usage,
      // …plus what the gateway did (no sensitive values in here, only tags and counts).
      gateway: {
        sessionId,
        provider: llm.providerName,
        aiSawLastMessage: maskedMessages.at(-1).content,
        aiReplyWithTags: reply.content,
        protected: protectedCounts,
        bypassAttempts,
        restoredTags: restored.restored,
        unknownTags: restored.unknown,
      },
    });
  });

  return router;
}
