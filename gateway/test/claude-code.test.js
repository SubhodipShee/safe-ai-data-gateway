// Tests for Phase 14: Claude Code through the gateway (/agent/anthropic, Anthropic Messages format).
// A FAKE "Anthropic" records everything it receives (body AND headers), so we can prove:
// no real values reach it, Claude Code's login and capabilities pass through unchanged,
// thinking blocks are untouched, and streamed answers come back with the real values.
// Uses Atlas database "safe-ai-gateway-test-claude-code" (the restorer tests need no database).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import { createApp } from '../src/app.js';
import { createVault } from '../src/vault.js';
import { createAuditChain } from '../src/audit/audit-chain.js';
import { restoreAnthropicAnswer, createAnthropicStreamRestorer } from '../src/agent/anthropic-conversation.js';
import { clearPolicyCache } from '../src/policies.js';
import { Policy, seedDefaultPolicies } from '../src/models/Policy.js';
import { connectTestDb, dropTestDb, SKIP_WITHOUT_DB } from './test-db.js';

// Fake data only.
const PAN = 'ABCPE1234F';
const EMAIL = 'rahul@gmail.com';
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

// -----------------------------------------------------------------------------
// Restoring answers (no database)
// -----------------------------------------------------------------------------
describe('restoring Claude\'s answers', () => {
  const values = new Map([['[[PAN_1]]', PAN], ['[[EMAIL_1]]', EMAIL]]);

  test('a complete answer: text blocks and tool inputs get the real values; thinking does not', () => {
    const answer = restoreAnthropicAnswer({
      content: [
        { type: 'thinking', thinking: 'User wants [[PAN_1]]', signature: 'sig' },
        { type: 'text', text: 'Saving [[PAN_1]].' },
        { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.txt', content: 'mail [[EMAIL_1]]' } },
      ],
    }, values);
    assert.equal(answer.content[0].thinking, 'User wants [[PAN_1]]', 'thinking must stay exactly as signed');
    assert.equal(answer.content[1].text, `Saving ${PAN}.`);
    assert.deepEqual(answer.content[2].input, { file_path: 'a.txt', content: `mail ${EMAIL}` });
  });

  test('a streamed answer: tags cut across events are restored; held-back text comes before the block ends', () => {
    const restorer = createAnthropicStreamRestorer(values);
    const out = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PAN is [[PA' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'N_1]] and [[EMA' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'IL_1]]' } },
      { type: 'content_block_stop', index: 0 },
    ].flatMap((event) => restorer.fix(event));

    const text = out.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
    assert.equal(text, `PAN is ${PAN} and ${EMAIL}`);
    assert.equal(out.at(-1).type, 'content_block_stop', 'the block still ends last');
  });
});

// -----------------------------------------------------------------------------
// The whole route, with a fake Anthropic
// -----------------------------------------------------------------------------

const received = []; // { path, headers, body } for every request the fake Anthropic got
let respond = null; //  how the fake Anthropic answers (set per test)

const fakeAnthropic = express();
fakeAnthropic.use(express.json({ limit: '32mb' }));
fakeAnthropic.post(/.*/, (req, res) => {
  received.push({ path: req.originalUrl, headers: req.headers, body: req.body });
  respond(req, res);
});

/** Sends Anthropic-style stream events. */
function sendEvents(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

/** Reads a stream back into its events. */
async function readEvents(response) {
  const raw = await response.text();
  return raw.split('\n\n').filter((e) => e.includes('data:')).map((e) => JSON.parse(e.split('\n').find((l) => l.startsWith('data:')).slice(5)));
}

/** A typical Claude Code request: instructions, a task, a tool call and a FILE it read, plus thinking. */
const claudeRequest = (extra = {}) => ({
  model: 'claude-sonnet-x',
  max_tokens: 1000,
  stream: false,
  system: [{ type: 'text', text: 'You are Claude Code, Anthropic\'s CLI. Office phone +91 98765 43210.', cache_control: { type: 'ephemeral' } }],
  messages: [
    { role: 'user', content: `Fix the refund mail for Rahul Verma (${EMAIL})` },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'I should read config.js', signature: 'SIGNATURE-123' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'config.js' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: `const PAN = "${PAN}";\nconst KEY = "${AWS_KEY}";` }] },
    ] },
  ],
  ...extra,
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('Claude Code proxy (fake Anthropic + Atlas)', { skip: SKIP_WITHOUT_DB }, () => {
  let fakeServer;
  const servers = [];
  let baseUrl;
  let anthropicUrl;
  let vault;
  let auditChain;
  const sessionId = randomUUID();

  before(async () => {
    await connectTestDb('claude-code');
    await seedDefaultPolicies();
    clearPolicyCache();
    fakeServer = await listen(fakeAnthropic);
    anthropicUrl = `http://127.0.0.1:${fakeServer.address().port}`;
    const masterKey = randomBytes(32);
    vault = createVault({ masterKey });
    auditChain = createAuditChain({ masterKey });
    const server = await listen(createApp({ vault, auditChain, anthropicUrl }));
    servers.push(server);
    baseUrl = `http://127.0.0.1:${server.address().port}/agent/anthropic`;
  });

  after(async () => {
    fakeServer?.close();
    servers.forEach((s) => s.close());
    await dropTestDb();
  });

  /** Calls the gateway exactly like Claude Code does. */
  function claudeCall(path, body, { url = baseUrl, headers = {} } = {}) {
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer my-claude-login-token',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14',
        'x-claude-code-session-id': sessionId,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  test('Anthropic never sees the message, the FILE or the key; login and capabilities pass through', async () => {
    respond = (req, res) => res.json({ type: 'message', content: [{ type: 'text', text: 'Updated [[PAN_1]] for [[EMAIL_1]].' }] });
    const response = await claudeCall('/v1/messages?beta=true', claudeRequest());
    assert.equal(response.status, 200);

    const { path, headers, body } = received.at(-1);
    const sent = JSON.stringify(body);
    // (Names are covered by names.test.js; this test gateway runs without the name AI.)
    for (const secret of [PAN, EMAIL, AWS_KEY, '98765 43210']) assert.ok(!sent.includes(secret), `Anthropic received ${secret}`);

    // Unchanged: the path with ?beta=true, the login, the capabilities, the structure.
    assert.equal(path, '/v1/messages?beta=true');
    assert.equal(headers.authorization, 'Bearer my-claude-login-token');
    assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20,interleaved-thinking-2025-05-14');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' }, 'cache_control must stay');
    assert.deepEqual(body.messages[1].content[0], { type: 'thinking', thinking: 'I should read config.js', signature: 'SIGNATURE-123' });
    assert.match(body.system[0].text, /You are Claude Code/, '"Claude" in the instructions is not mistaken for a name');

    assert.equal((await response.json()).content[0].text, `Updated ${PAN} for ${EMAIL}.`);
  });

  test('streaming: events relayed in order, tags restored in text AND in tool input, pings kept', async () => {
    respond = (req, res) => sendEvents(res, [
      { type: 'message_start', message: { id: 'm1', content: [] } },
      { type: 'ping' },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Writing [[PA' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'N_1]] now' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'w1', name: 'Write', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"content":"[[EMA' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'IL_1]]"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]);
    const response = await claudeCall('/v1/messages?beta=true', claudeRequest({ stream: true }));
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.equal(response.headers.get('anthropic-ratelimit-unified-status'), 'allowed', 'rate-limit headers pass back');

    const events = await readEvents(response);
    assert.deepEqual(events.map((e) => e.type).filter((t, i, all) => t !== all[i - 1]), [
      'message_start', 'ping', 'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
    ]);
    const text = events.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
    const json = events.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join('');
    assert.equal(text, `Writing ${PAN} now`);
    assert.deepEqual(JSON.parse(json), { content: EMAIL });
  });

  test('Anthropic errors come back unchanged (status, body and retry-after)', async () => {
    respond = (req, res) => res.status(429).set('retry-after', '12').json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    const response = await claudeCall('/v1/messages', claudeRequest());
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '12');
    assert.deepEqual(await response.json(), { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
  });

  test('the same Claude Code session keeps the same tags across requests', async () => {
    respond = (req, res) => res.json({ type: 'message', content: [{ type: 'text', text: 'ok' }] });
    await claudeCall('/v1/messages', { ...claudeRequest(), messages: [{ role: 'user', content: `again ${EMAIL}` }] });
    assert.equal(received.at(-1).body.messages[0].content, 'again [[EMAIL_1]]');
  });

  test('token counting is masked too; the start-up check answers', async () => {
    respond = (req, res) => res.json({ input_tokens: 42 });
    const response = await claudeCall('/v1/messages/count_tokens', claudeRequest());
    assert.deepEqual(await response.json(), { input_tokens: 42 });
    assert.ok(!JSON.stringify(received.at(-1).body).includes(PAN));
    assert.equal((await fetch(`${baseUrl}/api/hello`, { method: 'HEAD' })).status, 200);
  });

  test('a "block" policy stops the request before it reaches Anthropic', async () => {
    await Policy.updateOne({ _id: 'API_KEY' }, { action: 'block' });
    clearPolicyCache();
    const before = received.length;
    const response = await claudeCall('/v1/messages', { ...claudeRequest(), messages: [{ role: 'user', content: `deploy with ${AWS_KEY} (block test)` }] });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error.message, /blocked/);
    assert.equal(received.length, before, 'nothing reached Anthropic');
    await Policy.updateOne({ _id: 'API_KEY' }, { action: 'mask' });
    clearPolicyCache();
  });

  test('online: OFF without AGENT_KEY; with it, X-Safe-AI-Key is required (the login stays separate)', async () => {
    const offServer = await listen(createApp({ vault, auditChain, anthropicUrl, isPublic: true, adminKey: 'admin-key-0123456789' }));
    const onServer = await listen(createApp({ vault, auditChain, anthropicUrl, isPublic: true, adminKey: 'admin-key-0123456789', agentKey: 'agent-key-0123456789' }));
    servers.push(offServer, onServer);
    const off = `http://127.0.0.1:${offServer.address().port}/agent/anthropic`;
    const on = `http://127.0.0.1:${onServer.address().port}/agent/anthropic`;
    respond = (req, res) => res.json({ type: 'message', content: [] });

    assert.equal((await claudeCall('/v1/messages', claudeRequest(), { url: off })).status, 403);
    assert.equal((await claudeCall('/v1/messages', claudeRequest(), { url: on })).status, 401);
    const ok = await claudeCall('/v1/messages', claudeRequest(), { url: on, headers: { 'X-Safe-AI-Key': 'agent-key-0123456789' } });
    assert.equal(ok.status, 200);
    assert.equal(received.at(-1).headers['x-safe-ai-key'], undefined, 'our key is never sent to Anthropic');
  });
});
