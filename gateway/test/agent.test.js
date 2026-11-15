// Tests for Phase 12: the coding-agent proxy (POST /agent/v1/chat/completions).
// A FAKE AI provider records everything it receives, so we can prove that file
// contents and messages never reach it unmasked, with and without streaming.
// Uses Atlas database "safe-ai-gateway-test-agent" (the stream-restorer tests need no database).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/app.js';
import { createVault } from '../src/vault.js';
import { createAuditChain } from '../src/audit/audit-chain.js';
import { createLlmClient } from '../src/ai/llm-client.js';
import { createStreamRestorer } from '../src/agent/stream-restorer.js';
import { maskConversation } from '../src/agent/mask-conversation.js';
import { maskAnthropicRequest } from '../src/agent/anthropic-conversation.js';
import { createActivityLog, latestUserText } from '../src/agent/activity.js';
import { clearPolicyCache } from '../src/policies.js';
import { Policy, seedDefaultPolicies } from '../src/models/Policy.js';
import { connectTestDb, dropTestDb, SKIP_WITHOUT_DB } from './test-db.js';

// Fake data only.
const PAN = 'ABCPE1234F';
const EMAIL = 'rahul@gmail.com';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

// -----------------------------------------------------------------------------
// The stream restorer on its own (no database)
// -----------------------------------------------------------------------------
describe('stream-restorer.js: tags cut into pieces', () => {
  const values = new Map([['[[EMAIL_1]]', EMAIL], ['[[PAN_1]]', PAN], ['[[SECRET_1]]', 'pa"ss\\word']]);

  /** Feeds the pieces one by one and joins everything that comes out. */
  function streamThrough(pieces, options) {
    const restorer = createStreamRestorer(values, options);
    return pieces.map((piece) => restorer.push(piece)).join('') + restorer.flush();
  }

  test('a tag cut in the middle is still restored', () => {
    assert.equal(streamThrough(['Send to [[EM', 'AIL_1]] now']), `Send to ${EMAIL} now`);
    assert.equal(streamThrough(['[', '[', 'PAN', '_', '1', ']', ']']), PAN);
  });

  test('normal text, markdown links and unknown tags pass through unchanged', () => {
    assert.equal(streamThrough(['Use [the docs](https://x.y) and [[PHONE_9]]', '.']), 'Use [the docs](https://x.y) and [[PHONE_9]].');
    assert.equal(streamThrough(['array[0] = 1']), 'array[0] = 1');
  });

  test('text held back is never lost, even if the stream ends mid-tag', () => {
    assert.equal(streamThrough(['Hello [[EMA']), 'Hello [[EMA');
  });

  test('JSON mode: values are escaped, so tool-call arguments stay valid JSON', () => {
    const json = streamThrough(['{"text": "[[SEC', 'RET_1]]"}'], { json: true });
    assert.deepEqual(JSON.parse(json), { text: 'pa"ss\\word' });
  });
});

// -----------------------------------------------------------------------------
// The whole proxy, with a fake AI provider
// -----------------------------------------------------------------------------

const received = []; // every request body the "AI" got
let replyWith = null; // what the fake AI should answer (set per test)

const fakeProvider = express();
fakeProvider.use(express.json({ limit: '20mb' }));
fakeProvider.post('/v1/chat/completions', (req, res) => {
  received.push(req.body);
  replyWith(req, res);
});

/** Everything the AI received in request i, as one string (to search for leaks). */
const everythingSent = (i) => JSON.stringify(received[i]);

/** Sends one fake "server-sent events" stream: each piece becomes one chunk. */
function sendStream(res, pieces, toolPieces = []) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const content of pieces) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
  for (const args of toolPieces) {
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.end('data: [DONE]\n\n');
}

/** Reads a streamed answer back into the text and tool-call arguments the agent would see. */
async function readStream(response) {
  const raw = await response.text();
  let text = '';
  let toolArgs = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const delta = JSON.parse(line.slice(6)).choices[0].delta;
    text += delta.content ?? '';
    for (const call of delta.tool_calls ?? []) toolArgs += call.function?.arguments ?? '';
  }
  return { raw, text, toolArgs };
}

/** A typical coding-agent conversation: a task, a tool call, and a FILE the agent read. */
const conversation = () => [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: `Fix the refund email for ${EMAIL}` },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"config.js"}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: `const customer = { pan: "${PAN}" };\nconst awsKey = "${AWS_KEY}";` },
];

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('activity.js: what the VS Code pop-up shows (Phase 16; no database)', () => {
  const INSTALL = '11111111-2222-3333-4444-555555555555';

  test('keeps events per install, newest 10, for 30 minutes; ignores "nothing hidden" and bad IDs', () => {
    let clock = 1_000_000;
    const activity = createActivityLog({ now: () => clock });
    activity.record(INSTALL, { tool: 'Claude Code', found: {}, aiSaw: null });
    activity.record('bad id', { tool: 'Claude Code', found: { PAN: 1 }, aiSaw: null });
    assert.deepEqual(activity.since(INSTALL, 0), []);

    for (let i = 0; i < 12; i++) {
      clock += 1000;
      activity.record(INSTALL, { tool: 'Copilot', found: { EMAIL: 1 }, aiSaw: `mail [[EMAIL_${i}]]` });
    }
    assert.equal(activity.since(INSTALL, 0).length, 10, 'only the newest 10');
    assert.equal(activity.since(INSTALL, clock - 1000).length, 1, '"since" returns only newer ones');
    clock += 31 * 60_000;
    assert.deepEqual(activity.since(INSTALL, 0), [], 'forgotten after 30 minutes');
  });

  test('latestUserText: the typed text with a tag (both formats); null when the data was in a file', () => {
    assert.equal(latestUserText([{ role: 'user', content: 'PAN [[PAN_1]]' }]), 'PAN [[PAN_1]]');
    assert.equal(latestUserText([{ role: 'user', content: [
      { type: 'text', text: '<system-reminder>[[UPI_ID_1]]</system-reminder>' },
      { type: 'text', text: 'PAN [[PAN_1]]' },
    ] }]), 'PAN [[PAN_1]]');
    assert.equal(latestUserText([{ role: 'user', content: [{ type: 'tool_result', content: '[[PAN_1]]' }] }]), null);
    assert.equal(latestUserText([{ role: 'user', content: 'no tags here' }]), null);

    const long = `${'x'.repeat(500)} PAN [[PAN_1]] ${'y'.repeat(500)}`;
    assert.match(latestUserText([{ role: 'user', content: long }]), /^….*\[\[PAN_1\]\].*…$/, 'a long message: the part around the tag');
  });
});

describe('names on or off for coding tools (Phase 15; no database)', () => {
  /** A fake masker that only records whether the name-finding AI was asked for. */
  function recordingMasker() {
    const calls = [];
    return { calls, maskText: async ({ text, findNames }) => { calls.push(findNames); return { maskedText: text, items: [] }; } };
  }

  test('findNames: false reaches every text of an OpenAI-style conversation (online setting)', async () => {
    const masker = recordingMasker();
    await maskConversation({ masker, sessionId: 'names-off-openai-1', messages: conversation(), source: 'test', findNames: false });
    assert.ok(masker.calls.length >= 3);
    assert.ok(masker.calls.every((asked) => asked === false), JSON.stringify(masker.calls));
  });

  test('Claude Code format: off online; on the laptop names are found except in Claude Code\'s own instructions', async () => {
    const body = { system: 'You are Claude Code.', messages: [{ role: 'user', content: 'Mail Rahul Verma about the refund' }] };
    const online = recordingMasker();
    await maskAnthropicRequest({ masker: online, sessionId: 'names-off-claude-1', source: 'test', body, findNames: false });
    assert.deepEqual(online.calls, [false, false]);

    const laptop = recordingMasker();
    await maskAnthropicRequest({ masker: laptop, sessionId: 'names-on-claude-1', source: 'test', body });
    assert.deepEqual(laptop.calls, [false, true], 'instructions: no names ("Claude" is not a person); the message: names');
  });
});

describe('coding-agent proxy (fake provider + Atlas)', { skip: SKIP_WITHOUT_DB }, () => {
  let fakeServer;
  const servers = [];
  let baseUrl;
  let llm;
  let vault;
  let auditChain;

  before(async () => {
    await connectTestDb('agent');
    await seedDefaultPolicies();
    clearPolicyCache();
    fakeServer = await listen(fakeProvider);
    const masterKey = randomBytes(32);
    vault = createVault({ masterKey });
    auditChain = createAuditChain({ masterKey });
    llm = createLlmClient({ provider: 'custom', baseUrl: `http://127.0.0.1:${fakeServer.address().port}/v1`, apiKey: 'test-key', model: 'fake-model' });
    const server = await listen(createApp({ vault, auditChain, llm, providerKey: 'groq' }));
    servers.push(server);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    fakeServer?.close();
    servers.forEach((s) => s.close());
    await dropTestDb();
  });

  /** Calls the proxy like a coding agent would. */
  function agentCall(body, { url = baseUrl, key = 'anything' } = {}) {
    return fetch(`${url}/agent/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'fake-model', ...body }),
    });
  }

  test('the AI never sees the message, the FILE contents or the key; the answer is restored', async () => {
    replyWith = (req, res) => res.json({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Use [[PAN_1]] and mail [[EMAIL_1]].' } }],
    });
    const response = await agentCall({ messages: conversation() });
    assert.equal(response.status, 200);

    const sent = everythingSent(received.length - 1);
    for (const secret of [PAN, EMAIL, AWS_KEY]) assert.ok(!sent.includes(secret), `the AI received ${secret}`);
    assert.match(sent, /\[\[PAN_1\]\]/);
    assert.match(sent, /\[\[API_KEY_1\]\]/);

    const answer = await response.json();
    assert.equal(answer.choices[0].message.content, `Use ${PAN} and mail ${EMAIL}.`);
  });

  test('tool calls the AI writes get the real values back, as valid JSON', async () => {
    replyWith = (req, res) => res.json({
      choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.js","text":"pan = [[PAN_1]]"}' } }],
      } }],
    });
    const answer = await (await agentCall({ messages: conversation() })).json();
    const args = JSON.parse(answer.choices[0].message.tool_calls[0].function.arguments);
    assert.equal(args.text, `pan = ${PAN}`);
  });

  test('streaming: tags cut across chunks are restored in text AND tool calls', async () => {
    replyWith = (req, res) => sendStream(res, ['Writing to [[EMA', 'IL_1]] ', 'now.'], ['{"text":"[[PA', 'N_1]]"}']);
    const response = await agentCall({ messages: conversation(), stream: true });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const { raw, text, toolArgs } = await readStream(response);
    assert.equal(text, `Writing to ${EMAIL} now.`);
    assert.deepEqual(JSON.parse(toolArgs), { text: PAN });
    assert.match(raw, /data: \[DONE\]/);
  });

  test('every step of the same conversation uses the same tags', async () => {
    replyWith = (req, res) => res.json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] });
    const first = conversation();
    await agentCall({ messages: first });
    await agentCall({ messages: [...first, { role: 'assistant', content: 'ok' }, { role: 'user', content: `And CC ${EMAIL} again` }] });
    const lastSent = received.at(-1).messages.at(-1).content;
    assert.equal(lastSent, 'And CC [[EMAIL_1]] again');
  });

  test('a "block" policy stops the request before it reaches the AI', async () => {
    await Policy.updateOne({ _id: 'API_KEY' }, { action: 'block' });
    clearPolicyCache();
    const before = received.length;
    const response = await agentCall({ messages: [{ role: 'user', content: `use ${AWS_KEY} please, blocked test` }] });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.type, 'policy_violation');
    assert.equal(received.length, before, 'nothing was sent to the AI');
    await Policy.updateOne({ _id: 'API_KEY' }, { action: 'mask' });
    clearPolicyCache();
  });

  test('online: OFF without an AGENT_KEY; with one, only that key works', async () => {
    const offServer = await listen(createApp({ vault, auditChain, llm, providerKey: 'groq', isPublic: true, adminKey: 'admin-key-0123456789' }));
    const onServer = await listen(createApp({ vault, auditChain, llm, providerKey: 'groq', isPublic: true, adminKey: 'admin-key-0123456789', agentKey: 'agent-key-0123456789' }));
    servers.push(offServer, onServer);
    const off = `http://127.0.0.1:${offServer.address().port}`;
    const on = `http://127.0.0.1:${onServer.address().port}`;
    replyWith = (req, res) => res.json({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] });

    assert.equal((await agentCall({ messages: conversation() }, { url: off })).status, 403);
    assert.equal((await agentCall({ messages: conversation() }, { url: on, key: 'wrong-key-0123456789' })).status, 401);
    assert.equal((await agentCall({ messages: conversation() }, { url: on, key: 'agent-key-0123456789' })).status, 200);
  });

  test('the playground proxy (/v1/chat/completions) is unchanged: still no streaming', async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.equal(response.status, 400);
  });
});
