// =============================================================================
// app.js: WHAT the gateway does (all its endpoints)
// =============================================================================
//
// This file builds the Express app but does NOT start it. server.js starts it.
// Keeping them separate means:
//   - the tests can start their own copy on a random port
//   - a hosting service (Render, Phase 10) runs exactly the same app
//
// ENDPOINTS
//   GET    /                     → the browser playground (public/playground.html)
//   GET    /health               is the server up? is the database connected?
//   POST   /detect               what sensitive data is in this text? (types + positions only)
//   POST   /mask                 replace sensitive data with tags like [[EMAIL_1]]
//   POST   /unmask               put the real values back into the AI's reply
//   DELETE /session/:sessionId   delete a session's hidden values right away
//   GET    /api/audit/verify     check that nobody has edited the audit log (Phase 4)
//   GET    /api/audit/public-key the key that checks the audit signatures
//   GET    /api/reports/dpdp     signed DPDP evidence report
//   GET    /api/code/stats       which code repos are registered for leak detection (Phase 5)
//   POST   /v1/chat/completions  OpenAI-compatible AI proxy: mask → AI → unmask (Phase 7)
//   GET    /api/policies         all mask/block/allow policies (Phase 9 dashboard)
//   PUT    /api/policies/:type   change one policy (needs the admin key when one is set)
//   GET    /api/audit/recent     newest audit entries (counts only)
//   GET    /dashboard.html       the admin dashboard
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { dbStatus } from './db.js';
import { detect, summarize } from './detectors/index.js';
import { createMasker } from './masker.js';
import { maskRoute } from './routes/mask.js';
import { unmaskRoute } from './routes/unmask.js';
import { sessionRoute } from './routes/session.js';
import { auditRoute } from './routes/audit.js';
import { chatProxyRoute } from './routes/chat-proxy.js';
import { adminRoute } from './routes/admin.js';
import { requireDatabase, errorHandler } from './http-helpers.js';
import { securityHeaders, redirectToHttps, createRateLimits, requireAdminKey } from './security.js';

const publicFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Builds the gateway app.
 * @param {object} options
 * @param {object} options.vault       the vault from createVault()
 * @param {object} options.auditChain  the audit chain from createAuditChain()
 * @param {object} [options.codeGuard] the private-code checker from createCodeGuard()
 * @param {object} [options.nameFinder] the local AI name finder from createNameFinder()
 * @param {object} [options.llm]        the AI provider client from createLlmClient()
 * @param {string} [options.providerKey] e.g. 'groq' (for the audit log)
 * @param {boolean} [options.isPublic=false] true when hosted online (Phase 10): HTTPS + rate limits
 * @param {string} [options.adminKey]   if set, changing policies needs "Authorization: Bearer <key>"
 * @param {number} [options.trustProxyHops=1] proxies in front of the gateway (Render: 2)
 */
export function createApp({ vault, auditChain, codeGuard, nameFinder, llm, providerKey = 'none', isPublic = false, adminKey, trustProxyHops = 1 }) {
  const app = express();
  const masker = createMasker({ vault, auditChain, codeGuard, nameFinder });

  // Don't announce "X-Powered-By: Express" (tells attackers less).
  app.disable('x-powered-by');

  // When hosted, requests arrive through proxies that handle HTTPS (Render: Cloudflare,
  // then two Render proxies = 3, measured). Each proxy adds the address it received the request
  // from to the X-Forwarded-For header. Trusting exactly that many proxies gives the
  // visitor's REAL address (used by the rate limits); anything a visitor writes into
  // the header themselves sits further left and is ignored.
  app.set('trust proxy', trustProxyHops);

  // ---- Protections (Phase 10, see security.js) ----
  // Security headers on every response, also on the laptop, so a page that would
  // break online (e.g. an inline <script>) already breaks here.
  app.use(securityHeaders(isPublic));
  if (isPublic) {
    app.use(redirectToHttps);
    // Rate limits, checked BEFORE the request body is read.
    const limits = createRateLimits();
    app.use(['/mask', '/detect', '/session'], limits.mask);
    app.use('/unmask', limits.unmask);
    app.use('/v1', limits.aiPerVisitor, limits.aiTotalPerDay);
    app.use('/api', limits.read);
    app.put('/api/policies/:type', limits.admin);
  }
  // Changing a policy needs the admin key (when one is set). Reading them doesn't.
  app.put('/api/policies/:type', requireAdminKey(adminKey));

  // Read JSON request bodies, up to 1 MB.
  app.use(express.json({ limit: '1mb' }));

  // ---- The browser playground: "/" opens public/playground.html ----
  app.get('/', (req, res) => res.redirect('/playground.html'));
  app.use(express.static(publicFolder));

  // ---- GET /health ----
  app.get('/health', (req, res) => {
    const db = dbStatus();
    const isHealthy = db === 'connected';
    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'ok' : 'degraded',
      db,
      uptimeSeconds: Math.round(process.uptime()),
      nameDetection: nameFinder ? nameFinder.status : 'off', // the local AI model (Phase 6)
      ai: llm?.configured ? { provider: llm.providerName, model: llm.model } : null, // the proxy (Phase 7)
      adminKeyRequired: Boolean(adminKey), // the dashboard asks for the key when true (Phase 10)
    });
  });

  // ---- POST /detect (Phase 1): types and positions only, never the values ----
  app.post('/detect', (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string') {
      return res.status(400).json({ error: 'Body must be JSON: { "text": "..." }' });
    }
    const findings = detect(text);
    res.json({
      count: findings.length,
      summary: summarize(findings),
      findings: findings.map(({ type, label, start, end, obfuscated }) => ({ type, label, start, end, obfuscated })),
    });
  });

  // ---- Endpoints that need the database ----
  app.use(['/mask', '/unmask', '/session', '/api', '/v1'], requireDatabase);
  app.use(maskRoute(masker));
  app.use(unmaskRoute(masker));
  app.use(sessionRoute(vault));
  app.use(auditRoute(auditChain));
  app.use(adminRoute());
  if (llm) app.use(chatProxyRoute({ masker, llm, providerKey }));

  // GET /api/code/stats → which repos are protected (counts only, never code)
  app.get('/api/code/stats', async (req, res) => {
    res.json(codeGuard ? await codeGuard.stats() : { repos: [] });
  });

  // ---- Unknown URL ----
  app.use((req, res) => res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` }));

  // ---- Errors (must be last) ----
  app.use(errorHandler);

  return app;
}
