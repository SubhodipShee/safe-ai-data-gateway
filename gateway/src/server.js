// =============================================================================
// server.js: STARTS the gateway (run this file)
// =============================================================================
//
// Run it with:   npm run dev     (restarts automatically when you save a file)
// Then open:     http://127.0.0.1:7000      → the playground in your browser
//
// What happens when it starts:
//   1. config.js reads and checks gateway/.env
//   2. the vault is created with your MASTER_KEY
//   3. the app (app.js) starts listening on HOST:PORT
//   4. it connects to MongoDB Atlas and makes sure the default policies exist
// =============================================================================

import { config } from './config.js';
import { connectDb, disconnectDb, explainDbError } from './db.js';
import { createVault } from './vault.js';
import { createAuditChain } from './audit/audit-chain.js';
import { createCodeGuard } from './code/code-guard.js';
import { createNameFinder } from './ai/name-finder.js';
import { createLlmClient } from './ai/llm-client.js';
import { createApp } from './app.js';
import { seedDefaultPolicies } from './models/Policy.js';

// ---- Steps 1–2: settings + vault + tamper-proof audit chain ----
const vault = createVault({
  masterKey: config.masterKey,
  sessionTtlHours: config.sessionTtlHours,
});
const auditChain = createAuditChain({ masterKey: config.masterKey });
const codeGuard = createCodeGuard({ masterKey: config.masterKey });
const nameFinder = createNameFinder({ cacheDir: config.modelCacheDir, enabled: config.nameDetection });

// Start loading the AI model in the background now, so the first request doesn't wait.
// (The first time ever, this downloads ~110 MB.)
nameFinder.load().then(() => console.log(`[ai] name detection: ${nameFinder.status}`));

// The AI provider behind /v1/chat/completions (Phase 7). It only ever receives masked text.
const llm = createLlmClient(config.ai);
console.log(llm.configured
  ? `[ai] proxy → ${llm.providerName} (model: ${llm.model})`
  : '[ai] proxy disabled: add a free AI_API_KEY to gateway/.env to enable /v1/chat/completions');

// ---- Step 3: start listening ----
const app = createApp({
  vault, auditChain, codeGuard, nameFinder, llm,
  providerKey: config.ai.provider,
  isPublic: config.isPublic, // online: HTTPS redirect + rate limits (security.js)
  adminKey: config.adminKey, // needed to change policies when set
  clientIpHeader: config.clientIpHeader, // Render: 'true-client-ip' (the visitor's real IP for rate limits)
  agentKey: config.agentKey, // coding-agent proxy key (online: /agent is off without it)
});
const server = app.listen(config.port, config.host, () => {
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host;
  // The REAL address and port, so a hosting log shows exactly what was opened.
  console.log(`[gateway] listening on ${config.host}:${config.port}`);
  console.log(`[gateway] playground: http://${shownHost}:${config.port}/`);
  console.log(config.isPublic
    ? '[gateway] public mode: HTTPS redirect, rate limits and admin key are ON'
    : `[gateway] local mode (only this computer can connect); admin key ${config.adminKey ? 'ON' : 'off'}`);
});

// ---- Step 4: connect to Atlas ----
// If this fails, the server KEEPS RUNNING so /health can report the problem.
try {
  await connectDb(config.mongoUri, { dnsServers: config.dnsServers });
  await seedDefaultPolicies(); // every type gets a policy (default "mask"); admin changes are kept
  console.log('[db] policies ready');
} catch (error) {
  console.error(`[db] could not connect: ${explainDbError(error)}`);
}

// ---- Clean shutdown (Ctrl+C, or a stop signal from a hosting service) ----
async function shutdown() {
  server.close();
  await disconnectDb();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
