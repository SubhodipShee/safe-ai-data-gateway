// =============================================================================
// config.js: reads settings from gateway/.env and checks them
// =============================================================================
//
// Every setting the app needs lives in the .env file (never in the code, and
// never in git). This file loads it once, checks that nothing is missing, and
// exports a single `config` object.
//
// If something is wrong, the app STOPS with a clear message instead of
// starting half-broken.
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { DEFAULT_MODEL_CACHE_DIR } from './ai/name-finder.js';

// Find the .env file next to the "src" folder (gateway/.env), no matter which
// folder the app is started from.
const thisFolder = path.dirname(fileURLToPath(import.meta.url));
const envFilePath = path.join(thisFolder, '..', '.env');
dotenv.config({ path: envFilePath, quiet: true });

/** Reads a setting that MUST exist. Stops the app with a helpful message if it's missing. */
function readRequired(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name} in gateway/.env (see .env.example)`);
  }
  return value;
}

// ---- MONGODB_URI: the Atlas connection string ----
const mongoUri = readRequired('MONGODB_URI');
if (mongoUri.includes('<') || mongoUri.includes('PASTE_')) {
  throw new Error(
    'MONGODB_URI in gateway/.env still has a placeholder. Paste your real Atlas connection string.',
  );
}

// ---- MASTER_KEY: the 32-byte key that encrypts the vault (used from Phase 2) ----
// It's stored as base64 text in .env; here we turn it back into raw bytes.
const masterKey = Buffer.from(readRequired('MASTER_KEY'), 'base64');
if (masterKey.length !== 32) {
  throw new Error('MASTER_KEY must be 32 bytes, base64-encoded. Generate one with: npm run gen-key');
}

// ---- DNS_SERVERS (optional) ----
// On this laptop, Windows DNS refuses the special lookup that "mongodb+srv://"
// needs, so we tell Node to use public DNS instead, e.g. "8.8.8.8,1.1.1.1".
const dnsServers = (process.env.DNS_SERVERS || '')
  .split(',')
  .map((server) => server.trim())
  .filter((server) => server !== '');

// ---- HOST: who can connect ----
// 127.0.0.1 = only THIS computer (safest while developing).
// 0.0.0.0   = anyone who can reach this machine (needed on Render, Phase 10).
// On Render (which always sets RENDER=true) the default is 0.0.0.0, so the site
// still works if the HOST setting is ever missing. (That happened once: a deploy
// failed with "no open ports detected", because it listened on 127.0.0.1.)
const host = process.env.HOST?.trim() || (process.env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1');
const LOCAL_ONLY_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const isPublic = !LOCAL_ONLY_HOSTS.includes(host);

// ---- ADMIN_KEY: password for changing policies on the dashboard (Phase 10) ----
// On your laptop it's optional. Online it's REQUIRED: otherwise any visitor could
// switch "private code" from block to allow.
const adminKey = process.env.ADMIN_KEY?.trim() || undefined;
if (isPublic && !adminKey) {
  throw new Error('HOST is public, so ADMIN_KEY is required. Generate one with: npm run gen-key');
}
if (adminKey && adminKey.length < 16) {
  throw new Error('ADMIN_KEY is too short (use at least 16 characters). Generate one with: npm run gen-key');
}

// ---- AGENT_KEY: password for the coding-agent proxy (Phase 12), optional ----
// On your laptop it's optional. Online, /agent stays OFF unless this is set, so nobody
// else can use your server, database or AI quota. Agents send it as their "API key".
const agentKey = process.env.AGENT_KEY?.trim() || undefined;
if (agentKey && agentKey.length < 16) {
  throw new Error('AGENT_KEY is too short (use at least 16 characters). Generate one with: npm run gen-key');
}

// The final settings object. Object.freeze stops any code from changing it by accident.
export const config = Object.freeze({
  // Which port the gateway listens on (http://127.0.0.1:7000). Render sets PORT itself.
  port: Number(process.env.PORT) || 7000,

  host,
  isPublic,
  adminKey,
  agentKey,

  // The header that holds the visitor's real IP address, for the rate limits.
  //   laptop: not set (the connection's own address is used)
  //   Render: true-client-ip (set by Cloudflare, which sits in front of every
  //   Render site; measured to be correct and not fakeable, see security.js)
  clientIpHeader: process.env.CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,

  mongoUri,
  masterKey,
  dnsServers,

  // How long a chat session's hidden values are kept before MongoDB deletes them.
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS) || 24,

  // Phase 6: find people's names with a local AI model. Measured: the whole gateway
  // uses ~290 MB with the model loaded (fits Render's free 512 MB). NAME_DETECTION=off
  // is only an emergency switch.
  nameDetection: (process.env.NAME_DETECTION || 'on').toLowerCase() !== 'off',

  // Where the downloaded AI model is kept (gateway/.models, ignored by git).
  modelCacheDir: DEFAULT_MODEL_CACHE_DIR,

  // Phase 7: the AI provider behind the proxy (see ai/llm-client.js).
  //   AI_PROVIDER = groq (default) | gemini | ollama | custom
  //   AI_API_KEY  = your free key (Groq: console.groq.com → API Keys)
  //   AI_MODEL    = optional; each provider has a sensible default
  //   AI_BASE_URL = only for "custom" (any OpenAI-compatible API)
  ai: {
    provider: (process.env.AI_PROVIDER || 'groq').trim().toLowerCase(),
    apiKey: process.env.AI_API_KEY?.trim() || undefined,
    model: process.env.AI_MODEL?.trim() || undefined,
    baseUrl: process.env.AI_BASE_URL?.trim() || undefined,
  },
});
