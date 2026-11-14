// =============================================================================
// audit/dpdp-report.js: a DPDP evidence report built from the audit log
// =============================================================================
//
// India's Digital Personal Data Protection Act, 2023 (DPDP) makes companies
// responsible for protecting personal data, including when employees paste it
// into AI tools run by other companies (often abroad).
//
// This report answers the questions an auditor would ask:
//   - How much personal data did the gateway STOP from reaching AI tools?
//   - What kind (identity documents, contact details, financial data…)?
//   - Going to WHICH AI provider?
//   - Were there deliberate BYPASS attempts?
//   - Can we PROVE the log wasn't edited?  → the hash chain check
//
// The report never contains any personal data itself, only counts. It's signed
// with the gateway's Ed25519 key, so it can't be edited after it's issued.
//
// NOTE: this is technical evidence to SUPPORT compliance, not legal advice.
// =============================================================================

import { AuditLog } from '../models/AuditLog.js';
import { PROVIDERS } from '../ai/llm-client.js';

// Which DPDP-relevant group each type belongs to.
const CATEGORIES = [
  {
    name: 'Identity documents',
    types: ['AADHAAR', 'PAN', 'PASSPORT', 'VOTER_ID', 'DRIVING_LICENCE'],
    note: 'Personal data under the DPDP Act, 2023. Government identifiers are high-risk if leaked.',
  },
  {
    name: 'Names and addresses',
    types: ['PERSON', 'ADDRESS'],
    note: 'Personal data under the DPDP Act, 2023. Names are found by a local AI model, addresses by PIN-code rules.',
  },
  {
    name: 'Contact details',
    types: ['EMAIL', 'PHONE'],
    note: 'Personal data under the DPDP Act, 2023.',
  },
  {
    name: 'Financial details',
    types: ['BANK_ACCOUNT', 'IFSC', 'UPI_ID'],
    note: 'Personal data when linked to an individual (UPI IDs and account numbers usually are).',
  },
  {
    name: 'Business identifiers',
    types: ['GSTIN'],
    note: 'Usually business data; can be personal data for sole proprietors (the GSTIN contains the PAN).',
  },
  {
    name: 'Private source code',
    types: ['PRIVATE_CODE'],
    note: 'Not personal data, but confidential company information; may also contain embedded personal data or keys.',
  },
  {
    name: 'Credentials and secrets',
    types: ['API_KEY', 'PRIVATE_KEY', 'JWT', 'SECRET'],
    note: 'Not personal data, but a security risk: leaked keys can expose systems that hold personal data.',
  },
];

// Where the text was going → which company runs that AI.
const AI_PROVIDERS = {
  'chatgpt.com': 'OpenAI',
  'chat.openai.com': 'OpenAI',
  'claude.ai': 'Anthropic',
  'gemini.google.com': 'Google',
  'copilot.microsoft.com': 'Microsoft',
  'chat.deepseek.com': 'DeepSeek',
  'www.perplexity.ai': 'Perplexity',
  playground: 'Demo playground (no AI provider)',
};

/**
 * Which AI company a source belongs to.
 *   "chatgpt.com"          → OpenAI                  (browser extension, Phase 8)
 *   "api-proxy:groq"       → Groq                    (the AI proxy, Phase 7)
 *   "playground:groq"      → Groq (via playground)
 */
export function providerForSource(source) {
  if (AI_PROVIDERS[source]) return AI_PROVIDERS[source];
  const [origin, providerKey] = String(source).split(':');
  const provider = PROVIDERS[providerKey];
  if (provider) return origin === 'api-proxy' ? provider.name : `${provider.name} (via ${origin})`;
  return 'Unknown';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Reads "from" and "to" (YYYY-MM-DD) from the request, defaulting to the last 30 days. */
export function parseReportPeriod(fromText, toText) {
  const to = toText ? new Date(`${toText}T23:59:59.999Z`) : new Date();
  const from = fromText ? new Date(`${fromText}T00:00:00.000Z`) : new Date(to.getTime() - 30 * DAY_MS);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new TypeError('from/to must be dates like 2026-11-14');
  }
  if (from > to) throw new TypeError('"from" must be before "to"');
  return { from, to };
}

/**
 * Builds the report.
 * @param {object} options
 * @param {Date} options.from
 * @param {Date} options.to
 * @param {object} options.auditChain  from createAuditChain() (verifies the log + signs the report)
 */
export async function buildDpdpReport({ from, to, auditChain }) {
  // ---- One database query: total per (type, action, source) ----
  // An "aggregation pipeline" runs the counting INSIDE MongoDB:
  //   $match  keep only entries in the date range
  //   $group  add up the counts for each (type, action, source) combination
  const rows = await AuditLog.aggregate([
    { $match: { ts: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { type: '$entityType', action: '$action', source: '$source' },
        items: { $sum: '$count' },
        bypassAttempts: { $sum: { $ifNull: ['$obfuscatedCount', 0] } },
      },
    },
  ]);

  // ---- A second query: totals per day (for a chart) ----
  const dailyRows = await AuditLog.aggregate([
    { $match: { ts: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, action: '$action' },
        items: { $sum: '$count' },
      },
    },
    { $sort: { '_id.day': 1 } },
  ]);

  // ---- Totals ----
  const totals = { itemsMasked: 0, itemsBlocked: 0, bypassAttempts: 0 };
  for (const row of rows) {
    if (row._id.action === 'masked') totals.itemsMasked += row.items;
    else totals.itemsBlocked += row.items;
    totals.bypassAttempts += row.bypassAttempts;
  }

  // ---- Per category (identity documents, contact details…) ----
  const byCategory = CATEGORIES.map((category) => {
    const types = {};
    let masked = 0;
    let blocked = 0;
    for (const row of rows.filter((r) => category.types.includes(r._id.type))) {
      types[row._id.type] ??= { masked: 0, blocked: 0 };
      types[row._id.type][row._id.action] += row.items;
      if (row._id.action === 'masked') masked += row.items;
      else blocked += row.items;
    }
    return { category: category.name, note: category.note, masked, blocked, types };
  }).filter((category) => category.masked + category.blocked > 0);

  // ---- Per destination (which AI provider the data was going to) ----
  const destinations = new Map();
  for (const row of rows) {
    const source = row._id.source || 'unknown';
    if (!destinations.has(source)) {
      destinations.set(source, { source, aiProvider: providerForSource(source), masked: 0, blocked: 0 });
    }
    destinations.get(source)[row._id.action] += row.items;
  }

  // ---- Per day ----
  const daily = new Map();
  for (const row of dailyRows) {
    if (!daily.has(row._id.day)) daily.set(row._id.day, { date: row._id.day, masked: 0, blocked: 0 });
    daily.get(row._id.day)[row._id.action] += row.items;
  }

  // ---- Is the audit log itself trustworthy? ----
  const chain = await auditChain.verify({ maxProblems: 5 });

  const report = {
    title: 'DPDP evidence report: personal data stopped from reaching AI tools',
    period: { from: from.toISOString(), to: to.toISOString() },
    generatedAt: new Date().toISOString(),
    totals,
    byCategory,
    byDestination: [...destinations.values()].sort((a, b) => b.masked + b.blocked - (a.masked + a.blocked)),
    daily: [...daily.values()],
    auditLogIntegrity: {
      valid: chain.valid,
      entriesChecked: chain.entriesChecked,
      problems: chain.problems,
      notes: chain.notes,
    },
    guarantees: [
      'No personal data values are stored in the audit log or in this report, only types and counts.',
      'Masked values are kept only in an encrypted vault (AES-256-GCM, per-session keys) and deleted after 24 hours.',
      'The audit log is hash-chained and its head is signed (Ed25519), so any edit or deletion is detectable.',
    ],
    disclaimer: 'Technical evidence to support DPDP Act, 2023 compliance. Not legal advice.',
  };

  // ---- Sign the report so it can't be edited after it's issued ----
  report.signature = {
    algorithm: 'Ed25519',
    keyFingerprint: auditChain.keyFingerprint,
    value: auditChain.sign(JSON.stringify(report)),
  };
  return report;
}
