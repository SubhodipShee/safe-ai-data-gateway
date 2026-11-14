// =============================================================================
// scripts/check-ai.js: is the AI provider set up correctly?
// =============================================================================
//
// Run it with:   npm run check-ai
//
// It checks your AI_PROVIDER / AI_API_KEY / AI_MODEL settings, lists the models
// your key can use, and sends one tiny test message ("Reply with OK").
// The API key itself is never printed.
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createLlmClient } from '../src/ai/llm-client.js';
import { useDnsServers } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env'), quiet: true });
useDnsServers((process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean));

const settings = {
  provider: (process.env.AI_PROVIDER || 'groq').trim().toLowerCase(),
  apiKey: process.env.AI_API_KEY?.trim() || undefined,
  model: process.env.AI_MODEL?.trim() || undefined,
  baseUrl: process.env.AI_BASE_URL?.trim() || undefined,
};
const llm = createLlmClient(settings);

console.log(`\nProvider : ${llm.providerName}`);
console.log(`API key  : ${settings.apiKey ? `set (${settings.apiKey.length} characters)` : 'NOT SET'}`);
console.log(`Model    : ${llm.model}`);

if (!llm.configured) {
  console.log('\nNot configured. Get a free key (Groq: https://console.groq.com → API Keys)');
  console.log('and put it in gateway/.env as  AI_API_KEY=...\n');
  process.exit(1);
}

try {
  const models = await llm.listModels();
  console.log(`\nModels your key can use (${models.length}):`);
  for (const id of models) console.log(`   ${id === llm.model ? '→' : ' '} ${id}`);
  if (!models.includes(llm.model)) {
    console.log(`\n⚠ The model "${llm.model}" is not in this list. Set AI_MODEL in gateway/.env to one of the above.`);
  }
} catch (error) {
  console.log(`\nCould not list models: ${error.message}`);
}

try {
  const started = Date.now();
  // 300 tokens, not 5: "reasoning" models (like gpt-oss) think before answering,
  // and that thinking uses tokens too.
  const reply = await llm.chat([{ role: 'user', content: 'Reply with exactly one word: OK' }], { maxTokens: 300 });
  console.log(`\n✔ Test message answered in ${Date.now() - started} ms: "${reply.content.trim()}"\n`);
} catch (error) {
  console.log(`\n✘ Test message failed: ${error.message}\n`);
  process.exit(1);
}
