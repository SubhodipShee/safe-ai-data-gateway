// Tests for the Phase 10 protections (security.js): security headers, HTTPS redirect,
// rate limits, the admin key, and "public HOST needs an ADMIN_KEY".
// No database needed: everything is checked before the database is used.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createApp } from '../src/app.js';

const ADMIN_KEY = 'test-admin-key-0123456789';
const servers = [];

/** Starts a gateway on a random port and returns a fetch helper for it. */
async function startGateway(options) {
  const app = createApp({ vault: {}, auditChain: {}, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return (pathname, init = {}) => fetch(baseUrl + pathname, { redirect: 'manual', ...init });
}

const detect = (call) => call('/detect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'mail a@abc.com' }),
});

const putPolicy = (call, headers = {}) => call('/api/policies/PHONE', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ action: 'mask' }),
});

after(() => servers.forEach((server) => server.close()));

describe('online (public) mode', () => {
  test('security headers: scripts only from this site, https enforced by the browser', async () => {
    const call = await startGateway({ isPublic: true, adminKey: ADMIN_KEY });
    const response = await call('/playground.html');
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /upgrade-insecure-requests/);
    assert.match(response.headers.get('strict-transport-security'), /max-age=/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  });

  test('plain http visits are redirected to https', async () => {
    const call = await startGateway({ isPublic: true, adminKey: ADMIN_KEY });
    const response = await call('/dashboard.html?x=1', { headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(response.status, 301);
    assert.match(response.headers.get('location'), /^https:\/\/127\.0\.0\.1:\d+\/dashboard\.html\?x=1$/);
  });

  test('rate limit: the 31st mask/detect request in a minute is refused (429)', async () => {
    const call = await startGateway({ isPublic: true, adminKey: ADMIN_KEY });
    for (let i = 0; i < 30; i++) assert.equal((await detect(call)).status, 200);
    const refused = await detect(call);
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error, /Too many/);
  });

  test('Render: limits count the visitor from True-Client-IP, whatever X-Forwarded-For says', async () => {
    const call = await startGateway({ isPublic: true, adminKey: ADMIN_KEY, clientIpHeader: 'true-client-ip' });
    const fromVisitor = (visitorIp, forwardedFor) => call('/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'True-Client-IP': visitorIp, 'X-Forwarded-For': forwardedFor },
      body: JSON.stringify({ text: 'x' }),
    });
    const remaining = (response) => Number(/r=(\d+)/.exec(response.headers.get('ratelimit'))[1]);

    // Chains as measured on the live site: they differ per request (different Cloudflare servers).
    const first = remaining(await fromVisitor('5.5.5.5', '5.5.5.5, 104.22.0.1, 10.29.0.1'));
    const second = remaining(await fromVisitor('5.5.5.5', '9.9.9.9, 5.5.5.5, 172.69.0.2, 10.24.0.1'));
    assert.equal(second, first - 1, 'same visitor → same counter');
    assert.equal(remaining(await fromVisitor('6.6.6.6', '6.6.6.6, 104.22.0.1')), first, 'another visitor → own counter');
  });

  test('changing a policy needs the right admin key', async () => {
    const call = await startGateway({ isPublic: true, adminKey: ADMIN_KEY });
    assert.equal((await putPolicy(call)).status, 401, 'no key');
    assert.equal((await putPolicy(call, { Authorization: 'Bearer wrong-key-wrong-key' })).status, 401, 'wrong key');
    // Right key → gets past the check (then 503, because this test has no database).
    const allowed = await putPolicy(call, { Authorization: `Bearer ${ADMIN_KEY}` });
    assert.notEqual(allowed.status, 401);

    const health = await (await call('/health')).json();
    assert.equal(health.adminKeyRequired, true, 'the dashboard learns that it must ask for the key');
  });

  test('every page loads without inline scripts (they would be blocked)', async () => {
    const call = await startGateway({ isPublic: true, adminKey: ADMIN_KEY });
    for (const page of ['/playground.html', '/dashboard.html', '/chat-demo.html']) {
      const html = await (await call(page)).text();
      assert.doesNotMatch(html, /<script>(?!\s*<\/script>)/, `${page} has an inline <script>`);
      assert.doesNotMatch(html, /\son[a-z]+="/, `${page} has an inline event handler`);
    }
  });
});

describe('laptop (local) mode', () => {
  test('no https redirect, no upgrade-insecure-requests, no rate limit, no admin key', async () => {
    const call = await startGateway({});
    const page = await call('/playground.html', { headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /upgrade-insecure-requests/);
    for (let i = 0; i < 35; i++) assert.equal((await detect(call)).status, 200);
    assert.notEqual((await putPolicy(call)).status, 401);
  });
});

describe('config.js', () => {
  const gatewayFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  /** Loads config.js in a separate Node process with these settings; returns its error text. */
  function loadConfig(env) {
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/config.js')"], {
        cwd: gatewayFolder,
        env: {
          PATH: process.env.PATH,
          MONGODB_URI: 'mongodb+srv://user:pass@example.invalid',
          MASTER_KEY: randomBytes(32).toString('base64'),
          ADMIN_KEY: '',
          ...env,
        },
        stdio: 'pipe',
      });
      return '';
    } catch (error) {
      return error.stderr.toString();
    }
  }

  test('a public HOST without an ADMIN_KEY refuses to start', () => {
    assert.match(loadConfig({ HOST: '0.0.0.0' }), /ADMIN_KEY is required/);
  });

  test('on Render without a HOST setting, it still listens publicly (and so needs the ADMIN_KEY)', () => {
    // HOST: '' = "not set" (and stops the laptop's .env from filling it in).
    assert.match(loadConfig({ RENDER: 'true', HOST: '' }), /ADMIN_KEY is required/, 'public mode chosen automatically');
    assert.equal(loadConfig({ RENDER: 'true', HOST: '', ADMIN_KEY: ADMIN_KEY }), '');
    assert.equal(loadConfig({ HOST: '' }), '', 'on a laptop (no RENDER) it stays local, no key needed');
  });

  test('a public HOST with an ADMIN_KEY starts; a too-short key is refused', () => {
    assert.equal(loadConfig({ HOST: '0.0.0.0', ADMIN_KEY: ADMIN_KEY }), '');
    assert.match(loadConfig({ HOST: '0.0.0.0', ADMIN_KEY: 'short' }), /too short/);
  });
});
