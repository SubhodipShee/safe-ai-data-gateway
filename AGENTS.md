# AGENTS.md: guide for AI coding agents (Antigravity, Claude Code, Copilot…) and new developers

Read this before changing anything. It explains what the project is, how the code is organised,
the rules that must never be broken, and step-by-step recipes for the most common changes.
For the full design history see `PLAN.md`; for the product overview see `README.md`.

© 2026 Subhodip Shee. All rights reserved (see `LICENSE`).

---

## 1. What this project is

**Safe AI Gateway** stops sensitive data from reaching AI chatbots. Before a prompt is sent, it
replaces sensitive values with tags; after the AI answers, it puts the real values back.

```
You type:        Refund Rahul Verma, rahul@gmail.com, PAN ABCPE1234F
AI receives:     Refund [[PERSON_1]], [[EMAIL_1]], PAN [[PAN_1]]
AI replies:      Dear [[PERSON_1]], …
You see:         Dear Rahul Verma, …
```

Three parts:
| Part | Folder | What it is |
|---|---|---|
| **Gateway** | `gateway/` | Node.js 24 + Express 5 server. Detects, masks, encrypts, audits. Also serves the web pages |
| **Browser extension** | `extension/` | Chrome/Edge Manifest V3. Masks messages on chatgpt.com, claude.ai, gemini.google.com before sending |
| **Web pages** | `gateway/public/` | Playground (try it), dashboard (stats, policies, audit), demo chat (backup demo for the extension) |
| **VS Code extension** | `vscode-extension/` | For AI coding tools. Underlines sensitive data, protects secret files from AI tools, copy masked / paste restored. Runs fully offline, reusing the gateway's detectors (bundled by esbuild) |

The browser extension and the VS Code extension are **two separate products**. Changing one must never change the other.
The VS Code extension is **private for now**: `vscode-extension/` and its `.vsix` are git-ignored and exist only on the
owner's laptop. Never commit, push or publish them until the owner says so.

Live: https://safe-ai-gateway.onrender.com · Repo: https://github.com/SubhodipShee/safe-ai-data-gateway

---

## 2. How a request flows

```
extension (content.js) ─► background.js ─► POST /mask ─► masker.js
                                                          │
   detectors/index.js  (regex + checksums, after bypass cleaning in normalize.js)
   ai/name-finder.js   (PERSON, local BERT model)
   code/code-guard.js  (PRIVATE_CODE, winnowing fingerprints)
                                                          │
                         resolveOverlaps → policies.js (mask / block / allow)
                                                          │
            block? → 403 { blocked, blockedTypes }        │ mask
                                                          ▼
              vault.js: value → [[TYPE_N]], encrypted with AES-256-GCM, stored in MongoDB
              audit/audit-chain.js: counts only, SHA-256 hash chain + Ed25519-signed head
                                                          │
                                   ◄── { maskedText, items, summary, bypassAttempts }

AI reply ─► POST /unmask ─► masker.unmaskText ─► vault.revealPlaceholders ─► real values back
```

The API proxy (`POST /v1/chat/completions`, OpenAI-compatible) does mask → AI provider → unmask in one call.

---

## 3. Rules that must never be broken

1. **Never store, log or return a raw sensitive value**, except `/unmask` returning it to the session that
   owns it. The database holds only ciphertext, keyed hashes (HMAC) and counts. Logs print types and counts only.
2. **Never put secrets in git.** Secrets live only in `gateway/.env` (git-ignored) and in Render → Environment:
   `MONGODB_URI`, `MASTER_KEY`, `AI_API_KEY`, `ADMIN_KEY`. Never print them in scripts or output.
3. **`MASTER_KEY` must be the same everywhere** (laptop and Render). The vault encryption, the HMAC
   fingerprints, the code fingerprints and the audit signing key are all derived from it.
4. **The audit log is append-only.** Never delete or edit `auditlogs` / `auditheads` documents, not even
   test noise: the chain would report tampering. Old entries expire by TTL after 90 days.
5. **Fail closed.** If the extension can't reach the gateway, it does not send the message.
6. **No inline `<script>` or `onclick=` in HTML.** The Content-Security-Policy (helmet) blocks them.
   Put JavaScript in a separate `.js` file. A test checks this.
7. **Use fake data** in tests, examples and demos (e.g. PAN `ABCPE1234F`, Aadhaar `2345 6789 0124`).
8. **Readable code:** plain-English comments that explain *why*, for beginners. Keep that style.
9. **Commits:** plain messages, no "Co-Authored-By" or AI attribution lines.

---

## 4. Folder map

```
gateway/
  src/
    tags.js            tag rules shared with the VS Code extension: makePlaceholder, normalizeForLookup (no DB code)
    server.js          starts everything: config → vault, audit chain, code guard, name model, AI client → app → DB
    app.js             builds the Express app: security, routes, error handling (no listening here)
    config.js          reads and validates gateway/.env; exports a frozen `config`
    db.js              MongoDB Atlas connection (DB name: safe-ai-gateway), DNS workaround, error explanations
    security.js        public mode: helmet headers, HTTPS redirect, rate limits, admin key check
    http-helpers.js    badRequest, input checks, requireDatabase, errorHandler (400/413/500)
    masker.js          THE CORE: detect → policies → vault → replace with tags → audit; and unmask
    vault.js           value ↔ [[TYPE_N]] tag; AES-256-GCM encryption; normalizeForLookup (same value = same tag)
    policies.js        mask/block/allow per type (cached 30 s; clearPolicyCache after changes)
    detectors/
      index.js         ENTITY_TYPES, PRIORITY, ALL_DETECTORS, detect(), resolveOverlaps()
      normalize.js     bypass cleaning (Indic digits, invisible chars, homoglyphs, full-width, spaced digits) + position mapping
      util.js          findAll(text, regex, type, { group, validate, label }): the helper every detector uses
      email.js phone.js pan.js aadhaar.js india.js secrets.js entropy.js address.js
    agent/             Phase 12: the coding-agent proxy's helpers
      mask-conversation.js  masks every text in an agent conversation (messages, tool results = files, tool calls); remembers masked texts by SHA-256
      stream-restorer.js    restores tags in a STREAMED answer, even when a tag is cut across chunks; JSON mode for tool-call arguments
    ai/
      name-finder.js   PERSON via local BERT-NER (transformers.js, 1 CPU thread, model in gateway/.models)
      llm-client.js    AI providers for the proxy: groq (default), gemini, ollama, custom
    code/
      fingerprint.js   tokenizer + winnowing (K=12, W=8, HMAC-keyed 48-bit hashes)
      code-guard.js    registerFile / check / stats for PRIVATE_CODE
    crypto/
      keys.js          HKDF per-session keys from MASTER_KEY
      vault-crypto.js  encryptValue / decryptValue (AAD = sessionId|placeholder) / hmacValue
      signing.js       Ed25519 keys and signatures for the audit head and reports
    audit/
      audit-chain.js   append (batched, ordered, retried) and verify() the hash chain
      dpdp-report.js   CATEGORIES, AI_PROVIDERS, buildDpdpReport (signed, counts only)
    models/            Mongoose: Session, VaultEntry (TTL 24 h), AuditLog (TTL 90 d), AuditHead, Policy, CodeFile
    routes/            mask.js unmask.js session.js audit.js admin.js chat-proxy.js agent-proxy.js
  public/              playground.*, dashboard.*, chat-demo.* (plain HTML/CSS/JS, SVG charts, no frameworks)
  scripts/             check-db, check-ai, try-detect, vault-demo, tamper-demo, register-code, download-model, zip-extension
  test/                node:test files, one per area (see section 6)
extension/
  manifest.json        MV3; host_permissions = the live gateway only; content scripts on the AI chat sites
  background.js        GATEWAY_URL (fixed), settings, calls /mask /unmask /health, counters
  content.js           SITES (selectors per chat site), sessions (one per tab), intercept send, write masked text, restore tags
  tag-restore.js       finds and replaces [[TAG_N]] even when split across several text nodes
  popup.*              on/off, show-real-values switch, fail mode, status, counters, author credit
  icons/               icon.svg (source) + 16/32/48/128 PNGs
vscode-extension/
  src/extension.js     connects core/ to VS Code: underlines, status bar, commands, keyboard shortcuts
  src/core/scan.js     findSensitiveData(text) using ../gateway/src/detectors (offline)
  src/core/local-masker.js  copy masked / paste restored; values kept only in memory
  src/core/protect.js  writes "don't read these files" settings for each AI tool (managed block between markers)
  build.mjs            esbuild → dist/extension.js (one file; gateway detectors included)
  test/                core.test.js (logic) + extension-load.test.js (loads the built file with a fake VS Code)
download/              safe-ai-gateway-extension.zip (browser; npm run zip-extension, a test checks it's current)
                       safe-ai-gateway-vscode.vsix (VS Code; npm run package in vscode-extension/). PRIVATE:
                       git-ignored, owner-only for now. Don't commit it or link it publicly until the owner says so
demo/                  fake company repo (acme-payments) + 5-minute interview demo script
render.yaml            Render Blueprint (free plan, Singapore, env vars)
PLAN.md                full design and phase-by-phase build log
```

---

## 5. HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | status, db, nameDetection, ai, adminKeyRequired |
| POST | `/detect` | types and positions only (no DB) |
| POST | `/mask` | `{ sessionId, text, source? }` → masked text; 403 if a policy blocks |
| POST | `/unmask` | `{ sessionId, text }` → real values restored |
| DELETE | `/session/:sessionId` | forget a session's values now |
| POST | `/v1/chat/completions` | OpenAI-compatible proxy for the playground/apps (no streaming, text only) |
| POST | `/agent/v1/chat/completions` | Proxy for AI CODING AGENTS: tools, tool results (files) and streaming; up to 20 MB. Online it's OFF unless `AGENT_KEY` is set (then `Authorization: Bearer <AGENT_KEY>`) |
| GET | `/agent/v1/models` | the model list some agents ask for |
| GET | `/api/audit/verify` | re-check the hash chain |
| GET | `/api/audit/public-key` | Ed25519 public key |
| GET | `/api/reports/dpdp?from&to` | signed DPDP evidence report (counts only) |
| GET | `/api/audit/recent?limit` | newest audit entries (counts only) |
| GET / PUT | `/api/policies`, `/api/policies/:type` | read / change a policy (PUT needs `Authorization: Bearer <ADMIN_KEY>` when set) |
| GET | `/api/code/stats` | registered code repos (counts only) |

`sessionId` must match `/^[A-Za-z0-9_-]{16,64}$/`. Max text length: 200,000 characters.

---

## 6. Run, test, deploy (Windows `cmd`)

```
cd /d "D:\Projects\SAFE AI DATA GATEWAY\gateway"
npm install
npm run dev            (http://127.0.0.1:7000, restarts on save)
npm test               (all tests; must stay 100% passing)
node --test test/detectors.test.js     (one file)
```

- **Tests** use `node:test`. Tests that need MongoDB use their own database per file
  (`safe-ai-gateway-test-<name>`, see `test/test-db.js`) and skip themselves without a DB.
- **Settings** (`gateway/.env`, see `.env.example`): `MONGODB_URI`, `MASTER_KEY` (32 bytes base64, `npm run gen-key`),
  `HOST`, `PORT`, `ADMIN_KEY`, `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `NAME_DETECTION`, `SESSION_TTL_HOURS`,
  `DNS_SERVERS` (only for laptops whose DNS refuses SRV lookups), `CLIENT_IP_HEADER` (Render: `true-client-ip`),
  `AGENT_KEY` (key for `/agent`; online the coding-agent proxy is off without it).
- **Public mode:** any `HOST` other than 127.0.0.1/localhost turns on the HTTPS redirect, rate limits, and requires `ADMIN_KEY`.
  On Render (`RENDER=true`, set by Render itself) `HOST` defaults to `0.0.0.0`; without that, a deploy fails with
  "Port scan timeout… no open ports detected" because the server would only listen on 127.0.0.1.
- **Deploy:** push to `main` on GitHub. Render rebuilds automatically (about 2 minutes); see `render.yaml`.
  Check https://safe-ai-gateway.onrender.com/health afterwards. The free plan sleeps after 15 minutes idle.

---

## 7. Recipes for common changes

### A. Add a new kind of sensitive data (e.g. `CREDIT_CARD`)
1. `gateway/src/detectors/index.js`: add `'CREDIT_CARD'` to `ENTITY_TYPES` and a number to `PRIORITY`.
2. Create `gateway/src/detectors/credit-card.js` with `findCreditCards(text)` using
   `findAll(text, REGEX_WITH_G_FLAG, 'CREDIT_CARD', { validate })` (e.g. a Luhn checksum in `validate`).
   Use lookarounds such as `(?<![\w-])…(?![\w-])` so it doesn't match inside longer tokens.
3. Import it in `detectors/index.js` and add it to `ALL_DETECTORS`.
4. `gateway/src/vault.js` → `normalizeForLookup`: add a `case` so differently-written copies of the same
   value get the same tag (e.g. digits only).
5. `gateway/src/audit/dpdp-report.js` → `CATEGORIES`: put the type in a category (e.g. Financial details).
6. Tests in `gateway/test/` (e.g. `india.test.js` or a new file): real matches, near-misses that must NOT
   match, and a bypass example (Devanagari digits).
7. Nothing else is needed: tags, unmasking, policies (default `mask`) and the dashboard pick up `ENTITY_TYPES` automatically.

### B. Support a new AI chat website in the extension
1. `extension/content.js` → `SITES`: add `{ name, hosts, source, editor, sendButton, conversationId }`
   (CSS selectors for the message box and the send button).
2. `extension/manifest.json` → `content_scripts.matches`: add the site's URL pattern. Bump `version`.
3. `gateway/src/audit/dpdp-report.js` → `AI_PROVIDERS`: map the `source` to a provider name.
4. Rebuild the zip: `npm run zip-extension` (from `gateway/`), then commit it.
5. Test by hand on the real site: the toast "N items protected", and tags restored in the reply.

### C. Change anything in `extension/`
Always: bump `version` in `manifest.json`, run `npm run zip-extension`, run `npm test`
(the `extension-zip` test fails if the zip is stale), commit the zip with the change.
The gateway address is fixed in `background.js` (`GATEWAY_URL`) and `manifest.json` (`host_permissions`).

### D. Add an AI provider for the proxy
`gateway/src/ai/llm-client.js` → `PROVIDERS`: add `{ name, baseUrl, defaultModel }` for any
OpenAI-compatible API. Select it with `AI_PROVIDER` in `.env`. Check with `npm run check-ai`.
No code needed for a one-off: `AI_PROVIDER=custom` plus `AI_BASE_URL` works with any OpenAI-compatible API.
For the dashboard's "by AI provider" table, also map the source in `audit/dpdp-report.js` → `AI_PROVIDERS`.

### E. Add an endpoint
Create a router in `gateway/src/routes/`, mount it in `app.js` (after `requireDatabase` if it uses MongoDB),
validate input with the helpers in `http-helpers.js`, never return raw values, add tests in `test/api.test.js`.
If it's under `/api` or changes data, think about rate limits and the admin key (`security.js`).

### G. Change the VS Code extension
```
cd /d "D:\Projects\SAFE AI DATA GATEWAY\vscode-extension"
npm install            (first time: esbuild + vsce, both free)
npm test               (builds dist/ and runs its tests)
npm run package        (writes ../download/safe-ai-gateway-vscode.vsix)
```
Bump `version` in `vscode-extension/package.json`. The `.vsix` is private for now (git-ignored): don't commit it. Keep everything offline:
the VS Code extension must never upload file contents. Code shared with the gateway must not import
database code (that's why the tag rules live in `gateway/src/tags.js`). Gateway tests: `npm test` in `gateway/`.

### H. The coding-agent proxy (`/agent`, Phase 12)
- Use it from an agent's "OpenAI-compatible" provider: Base URL `http://127.0.0.1:7000/agent/v1`, any API key on the laptop.
- Keep the gateway on the laptop for coding agents (fast, private). On Render it stays off unless `AGENT_KEY` is set.
- Every text in the conversation is masked (`agent/mask-conversation.js`); new formats (Anthropic Messages for Claude Code,
  OpenAI Responses for Codex) should reuse it and `agent/stream-restorer.js`, as new routes next to `agent-proxy.js`.
- Tests: `test/agent.test.js` (fake AI provider: proves files and messages never reach it unmasked, with and without streaming).

### F. Change a web page
Edit `gateway/public/*.html|css|js`. No inline scripts (CSP). Colours are CSS variables with light and dark
values. The dashboard's chart palette was checked for colour-blind safety; reuse its variables.

---

## 8. Gotchas (learned the hard way)

- **Positions after cleaning:** detectors run on the *cleaned* text; `normalize.js` maps positions back to
  the original. Never slice the original text with clean-text positions.
- **Overlaps:** when two findings overlap, the longer wins, then the higher `PRIORITY`. Check `resolveOverlaps`.
- **The name model can be wrong:** it once read "Aadhaar" as a person. `NOT_NAME_WORDS` in `name-finder.js`
  filters ID words; extend it rather than lowering `MIN_CONFIDENCE`.
- **Rate limits on Render** identify visitors by Cloudflare's `True-Client-IP` header (`CLIENT_IP_HEADER`),
  because the `X-Forwarded-For` chain changes length. Don't switch back to counting proxy hops.
- **ChatGPT's editor** is ProseMirror: text is written with a paste event, then `execCommand('insertText')`,
  and re-read to confirm before sending. Sites change their HTML; selectors in `SITES` may need updating.
- **One session per browser tab** in the extension (chat IDs in the URL change while a chat is created).
- **Line endings:** the repo uses LF (`.gitattributes`). The zip builder normalises them, so the zip is identical everywhere.
- **The AI model** (~110 MB) is downloaded to `gateway/.models` (git-ignored) on first start or by
  `npm run download-model`; Render does this during the build.
- **Windows DNS:** if Atlas gives `querySrv ECONNREFUSED`, set `DNS_SERVERS=8.8.8.8,1.1.1.1` in `.env`.

---

## 9. Known limitations and ideas

- Names are found in Latin script only (not names written in Devanagari).
- File uploads in the chat sites aren't checked, only typed/pasted text.
- The API proxy doesn't support streaming responses yet.
- Rolling the audit log back to an older signed head needs an external anchor (e.g. publishing the daily head hash).
- Very common boilerplate in a registered repo can match the same boilerplate elsewhere.
