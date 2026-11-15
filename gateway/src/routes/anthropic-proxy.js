// =============================================================================
// routes/anthropic-proxy.js: Claude Code through the gateway (Phase 14)
// =============================================================================
//
//   POST /agent/anthropic/v1/messages               Claude's answers (streaming)
//   POST /agent/anthropic/v1/messages/count_tokens  token counting (optional for Claude Code)
//   GET  /agent/anthropic/v1/models                 model list (passed through)
//   HEAD /agent/anthropic/api/hello                 Claude Code's start-up check
//
// HOW TO USE: start Claude Code with
//   ANTHROPIC_BASE_URL=http://127.0.0.1:7000/agent/anthropic
// Your Claude login keeps working: Claude Code still sends it (Authorization header)
// and the gateway passes it on to Anthropic unchanged. Your plan's limits apply as usual.
//
//   Claude Code ──► 1. mask everything (your messages, files it read, CLAUDE.md…) ──► Anthropic
//   Claude Code ◄── 3. real values back in its answers and file edits ◄── 2. Claude answers with tags
//
// ANTHROPIC'S RULES FOR GATEWAYS (followed here):
//   - forward the anthropic-* headers, Authorization and every body field unchanged
//     (only the TEXT inside changes; thinking blocks are left exactly as they are)
//   - relay the stream event by event (buffering makes Claude Code stall), pings included
//   - pass Anthropic's errors and response headers (rate limits, retry-after) back unchanged
//
// PRIVATE: online this is OFF unless AGENT_KEY is set, and then Claude Code must send it
// in the X-Safe-AI-Key header (ANTHROPIC_CUSTOM_HEADERS). On the laptop no key is needed.
// =============================================================================

import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { requireDatabase } from '../http-helpers.js';
import { requireKey } from '../security.js';
import { BlockedError } from '../agent/mask-conversation.js';
import {
  maskAnthropicRequest,
  restoreAnthropicAnswer,
  createAnthropicStreamRestorer,
} from '../agent/anthropic-conversation.js';

const BASE = '/agent/anthropic';
const MAX_BODY = '32mb';
const SOURCE = 'claude-code:anthropic'; // for the audit log and dashboard

// Headers that belong to ONE connection and must not be copied to the next one.
const CONNECTION_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-connection', 'content-length', 'content-encoding', 'accept-encoding',
]);

/** An error in Anthropic's format, so Claude Code shows the message. */
function anthropicError(res, status, type, message) {
  return res.status(status).json({ type: 'error', error: { type, message } });
}

/** Copies Claude Code's headers for the request to Anthropic (minus connection headers and our key). */
function headersForAnthropic(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!CONNECTION_HEADERS.has(name) && name !== 'x-safe-ai-key') headers[name] = value;
  }
  headers['accept-encoding'] = 'identity'; // plain text back, so the gateway can read the stream
  return headers;
}

/** Copies Anthropic's response headers back to Claude Code (rate limits, retry-after, request-id…). */
function copyResponseHeaders(upstream, res) {
  for (const [name, value] of upstream.headers) {
    if (!CONNECTION_HEADERS.has(name)) res.setHeader(name, value);
  }
}

/** The gateway session for this Claude Code session, so the same value keeps the same tag. */
function sessionFor(req, body) {
  const claudeSession = req.get('x-claude-code-session-id');
  const firstUser = body.messages?.find((m) => m?.role === 'user');
  const seed = claudeSession ? `claude:${claudeSession}` : firstUser ? `claude:${JSON.stringify(firstUser.content)}` : null;
  return seed ? createHash('sha256').update(seed).digest('hex').slice(0, 32) : randomUUID();
}

/**
 * Relays Anthropic's stream to Claude Code, one event at a time, restoring tags.
 * An event looks like:   event: content_block_delta
 *                        data: {"type":"content_block_delta","index":0,"delta":{…}}
 *                        (blank line)
 */
async function relayStream(upstream, res, values) {
  res.status(upstream.status);
  copyResponseHeaders(upstream, res);
  res.flushHeaders();

  const restorer = createAnthropicStreamRestorer(values);
  const reader = upstream.body.getReader();
  res.on('close', () => reader.cancel().catch(() => {}));
  const decoder = new TextDecoder();
  let buffer = '';

  /** Handles one complete event (its lines without the blank line). */
  function relayEvent(eventText) {
    const dataLine = eventText.split('\n').find((line) => line.startsWith('data:'));
    let event;
    try {
      event = dataLine ? JSON.parse(dataLine.slice(5)) : null;
    } catch {
      event = null;
    }
    if (!event?.type) return res.write(`${eventText}\n\n`); // not something we understand: pass it on
    for (const fixed of restorer.fix(event)) {
      res.write(`event: ${fixed.type}\ndata: ${JSON.stringify(fixed)}\n\n`);
    }
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    // Events end with a blank line. Relay every complete one; keep the rest for later.
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      relayEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  if (buffer.trim()) relayEvent(buffer.trim());
  res.end();
}

/**
 * @param {object} options
 * @param {object} options.masker      from createMasker()
 * @param {object} options.vault       from createVault()
 * @param {boolean} options.isPublic   online? Then AGENT_KEY is required
 * @param {string} [options.agentKey]  the AGENT_KEY setting
 * @param {string} [options.upstreamUrl] Anthropic's API (changeable for tests)
 * @param {boolean} [options.findNames=true]  look for people's names? (online: off, see config.js)
 */
export function anthropicProxyRoute({ masker, vault, isPublic, agentKey, upstreamUrl = 'https://api.anthropic.com', findNames = true }) {
  const router = express.Router();

  // ---- Who may use it ----
  router.use(BASE, (req, res, next) => {
    if (isPublic && !agentKey) return anthropicError(res, 403, 'permission_error', 'The Claude Code proxy is turned off on this server.');
    next();
  });
  router.use(BASE, requireKey(agentKey, (req) => req.get('x-safe-ai-key'), {
    type: 'error',
    error: { type: 'authentication_error', message: 'Safe AI gateway: missing or wrong X-Safe-AI-Key (your AGENT_KEY).' },
  }));

  // ---- Claude Code's start-up check: just say "here" ----
  router.head(`${BASE}/api/hello`, (req, res) => res.sendStatus(200));

  router.use(BASE, express.json({ limit: MAX_BODY }), requireDatabase);

  /**
   * Masks the request, sends it to Anthropic, and returns { upstream, values } or answers
   * Claude Code directly (blocked by policy / Anthropic unreachable) and returns null.
   */
  async function maskAndSend(req, res, path) {
    const sessionId = sessionFor(req, req.body ?? {});
    let masked;
    try {
      masked = await maskAnthropicRequest({ masker, sessionId, source: SOURCE, body: req.body ?? {}, findNames });
    } catch (error) {
      if (!(error instanceof BlockedError)) throw error;
      const types = Object.keys(error.blockedTypes ?? {}).join(', ');
      anthropicError(res, 403, 'permission_error', `Safe AI gateway blocked this request: it contains data that must never be sent to an AI (${types}).`);
      return null;
    }

    let upstream;
    try {
      upstream = await fetch(`${upstreamUrl}${path}`, {
        method: 'POST',
        headers: headersForAnthropic(req),
        body: JSON.stringify(masked.body),
      });
    } catch {
      anthropicError(res, 502, 'api_error', 'Safe AI gateway could not reach Anthropic.');
      return null;
    }

    // Anthropic said no (rate limit, bad request…): pass its answer back UNCHANGED.
    if (!upstream.ok) {
      res.status(upstream.status);
      copyResponseHeaders(upstream, res);
      res.send(Buffer.from(await upstream.arrayBuffer()));
      return null;
    }
    // The AI can only refer to tags it has seen, so look up just those, once.
    const values = await vault.revealPlaceholders(sessionId, [...masked.tags]);
    return { upstream, values };
  }

  // ---- POST /v1/messages: Claude's answers ----
  router.post(`${BASE}/v1/messages`, async (req, res) => {
    const sent = await maskAndSend(req, res, `/v1/messages${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
    if (!sent) return;
    const { upstream, values } = sent;

    if (req.body?.stream !== true) {
      copyResponseHeaders(upstream, res);
      return res.status(upstream.status).json(restoreAnthropicAnswer(await upstream.json(), values));
    }
    try {
      await relayStream(upstream, res, values);
    } catch (error) {
      console.warn(`[claude-code] stream ended early: ${error.message}`);
      res.end();
    }
  });

  // ---- POST /v1/messages/count_tokens: count the MASKED request (it's what Claude really gets) ----
  router.post(`${BASE}/v1/messages/count_tokens`, async (req, res) => {
    const sent = await maskAndSend(req, res, '/v1/messages/count_tokens');
    if (!sent) return;
    copyResponseHeaders(sent.upstream, res);
    res.status(sent.upstream.status).send(Buffer.from(await sent.upstream.arrayBuffer()));
  });

  // ---- GET /v1/models: nothing to mask, pass it through ----
  router.get(`${BASE}/v1/models`, async (req, res) => {
    try {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const upstream = await fetch(`${upstreamUrl}/v1/models${query}`, { headers: headersForAnthropic(req) });
      res.status(upstream.status);
      copyResponseHeaders(upstream, res);
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      anthropicError(res, 502, 'api_error', 'Safe AI gateway could not reach Anthropic.');
    }
  });

  return router;
}
