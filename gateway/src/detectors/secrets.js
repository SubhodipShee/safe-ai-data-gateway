// =============================================================================
// secrets.js: finds passwords, API keys, private keys and tokens
// =============================================================================
//
// This file has 5 detectors:
//
//   1. findApiKeys          API keys from known companies   → type API_KEY
//                           e.g. AKIAIOSFODNN7EXAMPLE (AWS), sk-proj-… (OpenAI)
//   2. findPrivateKeys      PEM private key blocks          → type PRIVATE_KEY
//                           e.g. -----BEGIN RSA PRIVATE KEY----- …
//   3. findJwts             Login tokens (JSON Web Tokens)  → type JWT
//                           e.g. eyJhbGciOi….eyJzdWIi….SflKxw…
//   4. findAssignedSecrets  Values next to a sensitive name → type SECRET
//                           e.g. DB_PASSWORD=Sup3rS3cret!   (only "Sup3rS3cret!" is masked)
//   5. findCredentialUris   Database URLs with a password   → type SECRET
//                           e.g. mongodb+srv://admin:pass@cluster0.mongodb.net/shop
// =============================================================================

import { findAll } from './util.js';

// -----------------------------------------------------------------------------
// 1. API KEYS FROM KNOWN COMPANIES
// -----------------------------------------------------------------------------
// Most companies give their keys a recognisable PREFIX, so we can spot them reliably.
// These patterns are based on public secret-scanning rules (e.g. the "gitleaks" project).
//
// Common pieces used below:
//   (?<!\w)      "not stuck to a letter/digit/underscore on the left"
//   (?![\w-])    "not followed by more key characters on the right"
//   \w           any letter, digit or underscore
//   {20,}        "20 or more of these"

const API_KEY_PATTERNS = [
  // AWS:       AKIA or ASIA + 16 capital letters/digits.  e.g. AKIAIOSFODNN7EXAMPLE
  { label: 'AWS', pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g },

  // GitHub:    ghp_ / gho_ / ghu_ / ghs_ / ghr_ + 36+ characters, or github_pat_…
  { label: 'GitHub', pattern: /(?<!\w)(?:gh[pousr]_[A-Za-z0-9]{36,251}|github_pat_\w{22,255})(?!\w)/g },

  // Anthropic: sk-ant-…  (checked BEFORE OpenAI, because both start with "sk-")
  { label: 'Anthropic', pattern: /(?<![\w-])sk-ant-[\w-]{20,}/g },

  // OpenAI:    sk-… or sk-proj-… (but not sk-ant-, which is Anthropic)
  { label: 'OpenAI', pattern: /(?<![\w-])sk-(?!ant-)(?:proj-|svcacct-|admin-)?[\w-]{20,}/g },

  // Stripe:    sk_live_… / sk_test_… / rk_live_… (secret and restricted keys)
  { label: 'Stripe', pattern: /(?<!\w)(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },

  // Razorpay:  rzp_live_… / rzp_test_…  (popular Indian payment gateway)
  { label: 'Razorpay', pattern: /(?<!\w)rzp_(?:live|test)_[A-Za-z0-9]{14,}/g },

  // Google:    AIza + exactly 35 characters
  { label: 'Google', pattern: /(?<![\w-])AIza[\w-]{35}(?![\w-])/g },

  // Slack:     xoxb- / xoxp- / xoxa- … tokens
  { label: 'Slack', pattern: /(?<![\w-])xox[abposr]-[A-Za-z0-9-]{10,}/g },

  // Groq:      gsk_…
  { label: 'Groq', pattern: /(?<!\w)gsk_[A-Za-z0-9]{20,}/g },

  // SendGrid:  SG.<22 chars>.<43 chars>
  { label: 'SendGrid', pattern: /(?<![\w.])SG\.[\w-]{22}\.[\w-]{43}(?![\w-])/g },
];

/** Returns every known-format API key in the text, labelled with the company name. */
export function findApiKeys(text) {
  const findings = [];
  for (const { label, pattern } of API_KEY_PATTERNS) {
    findings.push(...findAll(text, pattern, 'API_KEY', { label }));
  }
  return findings;
}

// -----------------------------------------------------------------------------
// 2. PRIVATE KEYS (PEM format)
// -----------------------------------------------------------------------------
// Private keys look like this:
//     -----BEGIN RSA PRIVATE KEY-----
//     MIIEvQIBADANBgkqhkiG9w0BAQEFAASC...
//     -----END RSA PRIVATE KEY-----
// The word before "PRIVATE KEY" can be RSA, EC, OPENSSH, ENCRYPTED, or nothing.

// Full block from BEGIN to the matching END.
//   ((?:[A-Z0-9]+ )*)   captures the key type, e.g. "RSA "
//   [\s\S]*?            the key body (any characters, including new lines; as little as possible)
//   \1                  the END line must use the SAME key type as the BEGIN line
const PRIVATE_KEY_FULL_PATTERN =
  /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;

// A key that was pasted only partly (the END line is missing).
// We match the BEGIN line plus all the base64 lines that follow it.
const PRIVATE_KEY_PARTIAL_PATTERN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:\s*[A-Za-z0-9+/=]+)*/g;

/** Returns every private key block (full or cut off) in the text. */
export function findPrivateKeys(text) {
  // Both patterns usually match the same key. That's fine: index.js keeps the longer one.
  return [
    ...findAll(text, PRIVATE_KEY_FULL_PATTERN, 'PRIVATE_KEY'),
    ...findAll(text, PRIVATE_KEY_PARTIAL_PATTERN, 'PRIVATE_KEY'),
  ];
}

// -----------------------------------------------------------------------------
// 3. JWT (JSON Web Token): login/session tokens
// -----------------------------------------------------------------------------
// A JWT has 3 parts separated by dots:   HEADER . PAYLOAD . SIGNATURE
// The header and payload are JSON encoded in base64, and JSON always starts with
// '{"', which in base64 always becomes "eyJ". That's why every JWT starts with eyJ.
const JWT_PATTERN = /(?<![\w-])eyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]{10,}(?![\w-])/g;

/**
 * Extra check: decode the header and make sure it's real JSON with an "alg" field.
 * Example header: {"alg":"HS256","typ":"JWT"}
 */
function hasRealJwtHeader(token) {
  try {
    const headerPart = token.split('.')[0];
    const headerJson = Buffer.from(headerPart, 'base64url').toString('utf8');
    const header = JSON.parse(headerJson);
    return header !== null && typeof header === 'object' && 'alg' in header;
  } catch {
    return false; // not valid base64 or not valid JSON, so not a JWT
  }
}

/** Returns every JWT in the text. */
export function findJwts(text) {
  return findAll(text, JWT_PATTERN, 'JWT', { validate: hasRealJwtHeader });
}

// -----------------------------------------------------------------------------
// 4. SECRETS ASSIGNED TO A SENSITIVE NAME
// -----------------------------------------------------------------------------
// Catches things like:
//     DB_PASSWORD=Sup3rS3cret!
//     "apiKey": "abcd1234efgh"
//     client_secret: 'q1w2e3r4t5'
// We mask ONLY the value. The name (DB_PASSWORD) stays visible, so the AI still
// understands the code.
//
// How the pattern reads:
//   \b\w*?                 any prefix, e.g. "DB_" in DB_PASSWORD
//   (?:password|…|token)   one of the sensitive words
//   ["']?                  an optional closing quote (for JSON like "apiKey":)
//   \s*[:=]\s*             a colon or equals sign, with optional spaces
//   ["'`]?                 an optional opening quote around the value
//   ([^\s"'`,;]{6,})       THE VALUE: 6+ characters that aren't spaces, quotes, commas or semicolons
//
// Flags: g = find all, i = ignore upper/lower case, d = give positions of the value group.
const ASSIGNED_SECRET_PATTERN =
  /\b\w*?(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token)["']?\s*[:=]\s*["'`]?([^\s"'`,;]{6,})/gid;

// Catches "Authorization: Bearer <token>", as pasted from curl commands and logs.
// Only the token itself (group 1) is masked.
const BEARER_TOKEN_PATTERN = /\bBearer\s+([\w.~+/-]{16,}=*)/gd;

// Some values only POINT to a secret instead of being one. These are safe to leave:
//     apiKey = process.env.API_KEY      token: ${TOKEN}      password: ********
const NOT_A_REAL_SECRET =
  /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|getenv|env\(|config\.|settings\.|secrets\.|\$\{|\$[A-Z_]|<|\{\{|\[\[|null|undefined|none|true|false|\*+$|x+$|\.\.\.)/i;

/** Returns secret values assigned to sensitive names, plus Bearer tokens. */
export function findAssignedSecrets(text) {
  const assigned = findAll(text, ASSIGNED_SECRET_PATTERN, 'SECRET', {
    group: 1, // only the value, not the name
    label: 'assigned',
    validate: (value) => !NOT_A_REAL_SECRET.test(value),
  });

  const bearerTokens = findAll(text, BEARER_TOKEN_PATTERN, 'SECRET', {
    group: 1,
    label: 'bearer-token',
  });

  return [...assigned, ...bearerTokens];
}

// -----------------------------------------------------------------------------
// 5. DATABASE CONNECTION STRINGS WITH A PASSWORD
// -----------------------------------------------------------------------------
// e.g.  mongodb+srv://admin:Pa55w0rd@cluster0.mongodb.net/shop
//       postgres://app:hunter2@db.internal:5432/main
//
// We mask the WHOLE URL, because the username, password and server address
// are only dangerous together, and only useful together.
//
// How the pattern reads:
//   (?:mongodb(?:\+srv)?|postgres…)   the database type
//   :\/\/                            "://"
//   [^\s:@/]+                        username
//   :[^\s@/]+                        ":" + password   (a URL WITHOUT a password won't match)
//   @[^\s"'`<>]+                     "@" + server address and the rest of the URL
const CREDENTIAL_URI_PATTERN =
  /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqps?|mssql|sqlserver):\/\/[^\s:@/]+:[^\s@/]+@[^\s"'`<>]+/gi;

/** Returns every database URL that contains a password. */
export function findCredentialUris(text) {
  return findAll(text, CREDENTIAL_URI_PATTERN, 'SECRET', { label: 'connection-string' });
}
