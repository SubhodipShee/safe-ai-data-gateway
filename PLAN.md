# Safe AI Data Gateway: Build Plan

> "Your team can use AI safely, and I can show it blocking leaks live."

Employees paste customer data, keys and private code into AI chatbots. This gateway and browser extension
hides **emails, phone numbers, Aadhaar/PAN numbers and API keys** before the text leaves the company,
then puts the real values back into the AI's reply.

**Budget: ₹0.** Every tool below is free or open source.

---

## 1. System architecture

```
 ┌───────────────── Employee's laptop ─────────────────┐
 │  ChatGPT / Claude / Gemini page                      │
 │     │  ▲                                             │
 │     │  │ (4) reply shown with real values            │
 │  ┌──▼──┴───────────────┐                             │
 │  │ Browser extension   │ (1) catches text on Send    │
 │  │ (Chrome MV3)        │     or on paste             │
 │  └──┬──▲───────────────┘                             │
 └─────┼──┼─────────────────────────────────────────────┘
       │  │ HTTP
 ┌─────▼──┴──────────────────────────────────────────────┐
 │  GATEWAY (Node.js + Express)                          │
 │  (2) Detector ─► Masker ─► Vault (AES-256-GCM)        │
 │  (3) Unmasker: [[EMAIL_1]] ─► real value              │
 │  + /v1/chat/completions proxy (for developers)        │
 │  + /dashboard (blocked-leak stats)                    │
 │                                                       │
 │  MASTER KEY lives HERE only (.env), never in the DB   │
 └───────────┬──────────────────────────┬────────────────┘
             │ ciphertext only          │ masked text only
             ▼                          ▼
   ┌───────────────────┐       ┌────────────────────┐
   │ MongoDB Atlas M0  │       │ AI provider        │
   │ (free cloud DB)   │       │ (Gemini/Groq free) │
   └───────────────────┘       └────────────────────┘
```

**Key security idea:** neither Atlas nor the AI provider ever sees a real value.
Atlas stores only encrypted data, and the key to decrypt it stays inside the gateway.

Two ways to use it:
- **Browser extension.** For staff using the AI chatbot websites. This is the main demo.
- **API proxy.** Developers change their AI base URL to point at the gateway and get the same protection.

---

## 2. Tech stack (all free)

| Layer | Tool | Notes |
|---|---|---|
| Runtime | Node.js 22 LTS | |
| Server | Express | |
| Crypto | `node:crypto` (built in) | AES-256-GCM, HMAC-SHA256, HKDF |
| **Database** | **MongoDB Atlas M0 (free forever)** | 512 MB storage, shared cluster, no card needed |
| DB driver | Mongoose | Schemas, validation, indexes |
| DB GUI | MongoDB Compass or the Atlas web UI | Shows interviewers that the vault holds only encrypted data |
| Phone parsing | `libphonenumber-js` | |
| Config | `dotenv` | Loads `.env` |
| Extension | Chrome Manifest V3, plain JS | Load unpacked (skip the Web Store's $5 fee) |
| Dashboard | Plain HTML + Chart.js | Served by the gateway |
| Tests | `node:test` (built in) | |
| AI backend | Gemini API free tier / Groq free tier / Ollama (offline) | |
| Secret patterns | Based on gitleaks rules (MIT) | |
| Code + CI | GitHub + GitHub Actions | |
| Hosting (optional) | Render free tier | Sleeps when idle; fine for a demo |

---

## 3. MongoDB Atlas setup (one time, about 10 min)

1. Sign up at mongodb.com/cloud/atlas. No card is needed for M0.
2. **Create a cluster:** choose **M0 Free**, provider AWS, and the region closest to you (Mumbai if it's offered).
3. **Database Access:** create a user, e.g. `gateway_app`, with a long random password and the role *Read and write to any database*.
4. **Network Access:** add **your current IP**.
   - If you deploy on Render later, you'll need `0.0.0.0/0`, because Render's free tier has no fixed IP.
     That's acceptable here because the DB holds only ciphertext and the password is strong.
5. **Connect, then Drivers:** copy the connection string into `.env`:
   ```
   MONGODB_URI=mongodb+srv://gateway_app:<password>@cluster0.xxxxx.mongodb.net/safe-ai-gateway?retryWrites=true&w=majority
   ```
6. **Never commit `.env`.** It goes in `.gitignore`, and the repo only has `.env.example` with blank values.

**M0 limits to know:**
- 512 MB storage. That's plenty, since each vault entry is about 300 bytes and TTL keeps deleting old ones.
- Max 500 connections. Mongoose uses one shared pool, so this is fine.
- No automatic backups. That's fine too, because vault data is short-lived by design.
- The TTL cleaner runs about **every 60 seconds**, so expired data disappears within a minute, not instantly.
- Clusters with no activity for a long time can be **paused** by Atlas. Resume it from the Atlas UI before a demo.

---

## 4. Placeholder tag format

```
Original: "Email rahul@abc.com, PAN ABCPE1234F, key sk-proj-a8F..."
Masked:   "Email [[EMAIL_1]], PAN [[PAN_1]], key [[API_KEY_1]]"
```

- Double brackets: AI models copy them through unchanged, and they rarely appear in normal text.
- Numbered **per conversation**: the same email always becomes `[[EMAIL_1]]`.
- Flexible restore: `[EMAIL_1]` and `[[ EMAIL_1 ]]` are also matched.

Types: `EMAIL`, `PHONE`, `AADHAAR`, `PAN`, `GSTIN`, `UPI_ID`, `IFSC`, `BANK_ACCOUNT`, `VOTER_ID`,
`PASSPORT`, `DRIVING_LICENCE`, `API_KEY`, `PRIVATE_KEY`, `JWT`, `SECRET`.

---

## 5. Detection rules

| Type | Detection | Extra validation |
|---|---|---|
| Email | Standard regex | — |
| Phone | `+91`/`0` + `[6-9]` + 9 digits; libphonenumber-js for international | Valid-number check |
| PAN | `[A-Z]{5}[0-9]{4}[A-Z]` | 4th letter is one of `PCHFATBLJG` |
| Aadhaar | 12 digits (or `XXXX XXXX XXXX`), first digit 2–9 | **Verhoeff checksum** |
| API keys | AWS `AKIA…`, GitHub `ghp_…`, OpenAI `sk-…`, Stripe `sk_live_…`, Google `AIza…`, Slack `xox…` | Prefix + length |
| Private keys | `-----BEGIN … PRIVATE KEY-----` | — |
| JWT | `eyJ….eyJ….…` | Header decodes |
| Unknown secrets | Strings of 24+ characters | Shannon entropy ≥ 4.0, mixed case, 2+ digits |

**India-specific (Phase 1.5)**

| Type | Detection | Extra validation |
|---|---|---|
| GSTIN | State code + PAN + entity + `Z` + check char | **Mod-36 checksum** + valid state code (01–38, 97, 99) |
| UPI ID | `name@handle` (no dot in handle) | Known bank/app handle (okaxis, ybl, paytm…), or "UPI"/"VPA" written before it |
| IFSC | 4 letters + `0` + 6 characters | 5th character must be `0` |
| Bank account | 9–18 digits | Only when "account", "a/c" or "acct" is written just before it |
| Voter ID (EPIC) | 3 letters + 7 digits | Only with "voter"/"EPIC" before it |
| Passport | Letter (not Q/X/Z) + 7 digits | Only with "passport" before it |
| Driving licence | State + RTO + year + 7 digits | Real state code + year 19xx/20xx |

Formats that look like ordinary codes (bank account, voter ID, passport) need a **keyword before them**.
That's a deliberate trade-off: fewer false alarms, at the cost of missing numbers pasted with no label.

Overlapping matches: the **longer** one wins (fail safe: never leave part of a secret exposed).
At equal length the more specific one wins (Aadhaar beats phone; "account 9876543210" is a bank account, not a phone).

---

## 6. Database design (MongoDB Atlas collections)

### `sessions`: one document per chat conversation
```js
{
  _id: "a3f9…uuid",                 // random UUID from the extension
  counters: { EMAIL: 2, PAN: 1 },   // next tag number per type
  createdAt: Date,
  expiresAt: Date                   // TTL → auto-deleted
}
```

### `vault`: real values, encrypted
```js
{
  sessionId: "a3f9…",
  placeholder: "[[EMAIL_1]]",
  entityType: "EMAIL",
  valueHmac: "9c1e…",               // HMAC of value: reuses tags without revealing the value
  ciphertext: Buffer,               // AES-256-GCM
  iv: Buffer,                       // 12 random bytes, unique per value
  authTag: Buffer,                  // tamper detection
  createdAt: Date,
  expiresAt: Date                   // TTL → auto-deleted
}
```

### `auditlogs`: what was caught, never the real values
```js
{
  ts: Date,
  sessionId: "a3f9…",
  source: "chatgpt.com",            // or "api-proxy"
  entityType: "AADHAAR",
  count: 1,
  action: "masked"                  // or "blocked"
}
```

### `policies`: what to do with each type
```js
{ _id: "API_KEY", action: "block" } // mask | block | allow
```

### Indexes (Mongoose creates them at startup)
```js
sessions:  { expiresAt: 1 }  expireAfterSeconds: 0        // auto-delete
vault:     { expiresAt: 1 }  expireAfterSeconds: 0        // auto-delete
vault:     { sessionId: 1, valueHmac: 1 }   unique        // same value → same tag
vault:     { sessionId: 1, placeholder: 1 } unique        // fast unmask
auditlogs: { ts: -1 }                                     // dashboard
```

**Atomic tag numbering:** `Session.findOneAndUpdate({_id}, {$inc: {"counters.EMAIL": 1}}, {new: true, upsert: true})`.
Two requests arriving at the same moment can never both get `[[EMAIL_2]]`.

**Dashboard stats:** an aggregation pipeline, `$match` (date range), then `$group` by `entityType`, then `$sort`.

---

## 7. Cryptography

| Item | Choice | Why |
|---|---|---|
| Master key | 32 random bytes, base64, in `.env` as `MASTER_KEY` | Never stored in Atlas |
| Per-session keys | `HKDF-SHA256(masterKey, salt=sessionId, info="vault-enc")` | One leaked session key doesn't expose the others |
| HMAC key | `HKDF(masterKey, salt=sessionId, info="vault-hmac")` | Kept separate from the encryption key |
| Encryption | AES-256-GCM, new random 12-byte IV per value | Encrypts and detects tampering |
| Lookup | `HMAC-SHA256(hmacKey, value)` | Finds repeat values without storing them in readable form |

Generate the master key with:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

---

## 8. API endpoints

| Endpoint | Input | Output |
|---|---|---|
| `POST /mask` | `{sessionId, text, source}` | `{maskedText, found:[{type, placeholder}]}`, or `403` if the policy is `block` |
| `POST /unmask` | `{sessionId, text}` | `{text}` |
| `POST /v1/chat/completions` | OpenAI-style request | Masks, calls the AI, unmasks the reply |
| `GET /api/audit` | `?from&to` | Aggregated stats |
| `GET /health` | — | Gateway + Atlas connection status |

---

## 9. Folder structure

```
SAFE AI DATA GATEWAY/
├── gateway/
│   ├── src/
│   │   ├── detectors/   email.js phone.js pan.js aadhaar.js secrets.js entropy.js index.js
│   │   ├── crypto/      keys.js vault-crypto.js
│   │   ├── models/      Session.js Vault.js AuditLog.js Policy.js
│   │   ├── db.js        Mongoose connection to Atlas
│   │   ├── routes/      mask.js unmask.js proxy.js audit.js
│   │   ├── vault.js     getOrCreatePlaceholder / revealPlaceholders / forgetSession
│   │   ├── masker.js
│   │   └── server.js
│   ├── scripts/         check-db.js try-detect.js vault-demo.js
│   ├── public/dashboard/ index.html app.js
│   ├── test/            detectors.test.js crypto.test.js roundtrip.test.js
│   ├── .env.example     MONGODB_URI= MASTER_KEY= AI_API_KEY= PORT=7000 DNS_SERVERS=
│   └── package.json
├── extension/
│   ├── manifest.json
│   ├── content.js       catches Send/paste, swaps text, restores replies
│   ├── background.js    talks to the gateway
│   └── popup.html       on/off switch + "N items protected"
├── demo/                leak-samples.txt, demo-script.md
├── .gitignore           node_modules, .env
├── PLAN.md
└── README.md            Mermaid diagram + screenshots
```

---

## 10. Build order

| Step | Work | Done when |
|---|---|---|
| 0 | Atlas setup (section 3) + `npm init` | ✅ `GET /health` shows "db: connected" |
| 1 | Detectors + unit tests | All sample leaks caught, no false matches on normal text ✅ |
| 1.5 | India detectors (GSTIN, UPI, IFSC, bank account, voter ID, passport, DL) | ✅ 67/67 tests |
| 2 | Crypto + vault models | ✅ 103/103 tests (incl. 18 against real Atlas); Atlas stores only ciphertext |
| 3 | `/mask` and `/unmask` routes + policies + audit log + **browser playground** | ✅ 127/127 tests; round trip `unmask(mask(text)) === text` |
| 3.5 | **Bypass-resistant detection** (section 13) | ✅ 158/158 tests; Devanagari/Bengali/Tamil/Gujarati digits, invisible characters, look-alike letters, spaced digits all caught and counted |
| **4** | **Tamper-proof audit log + DPDP report** (section 13) | ✅ 183/183 tests (11 attack scenarios); signed DPDP report; playground step 4 |
| **5** | **Private code leak detection** (section 13) | ✅ 204/204 tests; renamed/reformatted/partial copies caught; demo repo `demo/acme-payments` |
| **6** | **Local AI for names and addresses** (section 13) | ✅ 220/220 tests; BERT-NER runs locally (~10 ms/message); PIN-code address rules; masking sped up 1.8 s → 0.33 s |
| 7 | AI proxy (OpenAI-compatible `/v1/chat/completions`) with a free Groq key | ✅ 231/231 tests (fake provider proves no raw values are sent); "Ask the real AI" in the playground; switch provider in `.env` |
| 8 | Chrome extension (ChatGPT, Claude, Gemini + local demo chat) | ✅ Tested on chatgpt.com: masked before sending, restored on screen (green), one session per chat, "show what the AI saw" switch. Backup demo: `/chat-demo.html` |
| 9 | Dashboard + README + demo script | ✅ 240/240 tests; `/dashboard.html` (charts, live policies, audit verify, signed report); README.md; demo/demo-script.md |
| 10 | Go online (section 11) | ✅ 250/250 tests; live at https://safe-ai-gateway.onrender.com; checked live: DB connected, http→https, CSP/HSTS, mask→unmask round trip, admin key 401, audit intact. Live check found and fixed: proxy hops (rate limits) and "Aadhaar" read as a name |
| 11 | **VS Code extension, part 1** (`vscode-extension/`): underline sensitive data, scan workspace, protect secret files from AI tools (8 ignore files + Claude Code deny rules + AGENTS.md), copy masked / paste restored | ✅ 19/19 extension tests + 252/252 gateway tests; fully offline; `download/safe-ai-gateway-vscode.vsix` (90 KB, private: git-ignored, owner-only) accepted by VS Code; browser extension untouched |
| 12 | **Gateway for AI coding tools** (`/agent/v1/chat/completions`): masks messages, tool results (files) and tool calls; streaming with tags cut across chunks; same tags across agent steps; off online without `AGENT_KEY` | ✅ 263/263 tests; **live with Groq (free):** a coding-agent request with a file containing PAN, email and AWS key; Groq saw only tags (audit log), the streamed `write_file` tool call came back with the real values in 1.7 s. Anthropic (Claude Code) and Responses (Codex) formats: later, they need paid keys to test live |
| 13 | **Connect AI tools** (VS Code extension 0.2.0, private): a **"Safe AI (masked)" model in Copilot Chat** (VS Code language-model provider → local gateway `/agent/v1`, streaming + tool calls) and a **"Connect AI tools"** command (Copilot, Cline/Continue/Roo/Aider setup; what protects Claude Code, Codex, Cursor, Antigravity) | ✅ 25/25 extension tests + 263/263 gateway tests; **live:** the built extension → local gateway → Groq: a file with PAN, email and AWS key was masked (audit: `vscode-copilot:groq`), the `write_file` tool call came back with real values in 1.5 s. Copilot itself isn't installed here yet, so the in-Copilot check is the user's |
| 14 | **Claude Code through the gateway** (`/agent/anthropic`, Anthropic Messages format): masks system, messages, files (tool results) and tool inputs; thinking blocks untouched; streaming relayed event by event; the user's Claude login passes through. VS Code extension 0.3.0: Claude Code masking ON/OFF per project | ✅ 272/272 gateway + 27/27 extension tests; **live with real Claude Code 2.1.325 on the user's subscription:** answered in 9 s with real values; audit shows PAN, email, API key (and 3 names from Claude Code's context) masked before Anthropic |
| 15 | **Online, no setup** (VS Code extension 0.4.0, private): uses the Render gateway by default with the access key built in (from `gateway/.env`, never in git); wakes the sleeping server; Claude Code ON also writes the key header and keeps `settings.local.json` out of git; Copilot model limited to Groq's measured 8,000 tokens/min. Gateway: `AGENT_NAME_DETECTION` (online off; the name model was measured at 43 s per 10 KB file and crashed at 18 KB on 0.1 CPU, regex checks < 0.5 s); rate limit 60/min for `/agent` | ✅ 275/275 gateway + 30/30 extension tests |

**Two products, one gateway:** the **browser extension** (`extension/`, for chatgpt.com, claude.ai, gemini.google.com) stays
exactly as it is. The **VS Code extension** is a separate, second product for AI coding tools. Gateway changes must keep
the browser extension's `/mask`, `/unmask` and `/health` working unchanged. Everything stays free.

**Risks**
- AI websites change their page structure often. Keep the extension's selectors in one config object, and keep the API-proxy demo as a backup.
- Atlas needs internet. For an offline demo, a local MongoDB is a drop-in swap: just change `MONGODB_URI`.

---

## 11. Going online (Phase 10, free)

### Hosting
| Option | Use for | Notes |
|---|---|---|
| **Render free web service** (main) | Permanent public URL, e.g. `https://safe-ai-gateway.onrender.com` | Free HTTPS certificate is automatic. Sleeps after ~15 min idle, and the first request after that takes ~30–60 s, so open it a minute before an interview. Deploys automatically on every GitHub push. |
| **Cloudflare quick tunnel** (backup) | Live demo straight from your laptop | `cloudflared tunnel --url http://localhost:7000` gives a temporary `https://….trycloudflare.com` URL. No account needed. |

The **Chrome Web Store** charges a one-time $5 fee, so skip it. Share the extension as a zip and load it with "Load unpacked", or show it in a screen recording.

### What was built for the public URL (Phase 10 ✅)
| Change | How |
|---|---|
| `HOST=0.0.0.0`, `PORT` from Render | Set in `render.yaml`. A non-local HOST switches on **public mode** |
| **HTTPS only** | Render provides the certificate; a 301 redirect when `X-Forwarded-Proto: http`; HSTS header |
| **Real visitor IP** (`CLIENT_IP_HEADER=true-client-ip` on Render) | **Measured on the live site** (temporary diagnostic, since removed): the `X-Forwarded-For` chain changes length from request to request (Cloudflare server + Render internals), so counting proxy hops (tried 1, 2 and 3) kept picking a Cloudflare server as the "visitor". Cloudflare's `True-Client-IP` header was the real address every time, so the limits use that |
| **Admin key** (`ADMIN_KEY`, Render generates it) | Needed only to **change** policies (`Authorization: Bearer …`, constant-time compare). The gateway refuses to start in public mode without one. The dashboard shows a 🔒 Unlock bar |
| No key for `/mask`, `/unmask`, `/v1` | Deliberate: the public playground must work for interviewers on their phones. A key embedded in a public page protects nothing, so **rate limits** protect these instead |
| **Rate limits** (`express-rate-limit`) | Per visitor: mask/detect 30/min, unmask 300/min (extension), API 60/min, real AI 6/min, admin 20 per 15 min. Plus **300 AI requests per day in total**, so the free Groq quota can't be drained |
| **No CORS** (deliberate) | Without CORS headers, other websites can't call the gateway with JSON. The extension is allowed by its manifest; the pages are same-origin |
| **Security headers** (`helmet`) | CSP `script-src 'self'` (the demo chat's inline script moved to `chat-demo.js`), nosniff, frame-ancestors, HSTS. Also on in local mode, so problems show up on the laptop first |
| Secrets in **Render → Environment**, never in git | `MONGODB_URI`, `MASTER_KEY` (**same** as the laptop: audit signatures and code fingerprints depend on it), `AI_API_KEY`, `ADMIN_KEY` |
| **Atlas → Network Access → `0.0.0.0/0`** | Render's free tier has no fixed IP. Acceptable: Atlas only stores ciphertext and the DB password is strong. Only this Atlas project is affected |
| `DNS_SERVERS` | Not set on Render (it was a fix for this laptop's DNS) |
| AI model on 0.1 CPU | **Measured:** 1 ONNX thread = 28 ms CPU per message (4 threads = 50 ms), so it's pinned to 1 thread: about 0.3 s per message on Render. Downloaded during the build (`npm run download-model`) |
| Public **playground page** with a "fake data only" banner | ✅ Since Phase 3 |

### Free-tier facts (checked 15 Nov 2026)
- **Render free web service:** 512 MB RAM, 0.1 CPU, free HTTPS. Sleeps after 15 min with no visitors and takes about 1 minute to wake. 750 free hours a month (enough for one service running all month). Render's free-plan page mentions a payment method only for paid extras (extra bandwidth or build minutes).
- **Groq:** the exact free limits are on your account's *Settings → Limits* page. The gateway caps itself at 300 AI requests a day.
- **Atlas M0:** 512 MB storage. The vault empties itself after 24 h and the audit log after 90 days.

---|---|
| `HOST=0.0.0.0`, `PORT` from Render | Render sets `PORT` itself; the code already reads it |
| **HTTPS only** | Render terminates TLS; set `app.set('trust proxy', 1)` and reject plain HTTP |
| **Gateway access key** (`Authorization: Bearer <GATEWAY_KEY>`) | Stops strangers from using your gateway and your free AI quota |
| **Rate limiting** (`express-rate-limit`, free) | Abuse and brute-force protection |
| **CORS** restricted to the extension and the dashboard | Stops other websites from calling the gateway from a browser |
| **Security headers** (`helmet`, free) | Standard hardening |
| Secrets in **Render → Environment**, never in git | `MONGODB_URI`, `MASTER_KEY`, `AI_API_KEY`, `GATEWAY_KEY` |
| **Atlas → Network Access → `0.0.0.0/0`** | Render's free tier has no fixed IP. Acceptable here because Atlas only stores ciphertext and the DB password is strong |
| `DNS_SERVERS` | Probably not needed on Render (that was a fix for this laptop's DNS) |
| `NAME_DETECTION` | **Measured:** the whole gateway incl. the AI model uses ~290 MB (model ≈ 165 MB). Render's free tier gives 512 MB, so it **fits**. `NAME_DETECTION=off` exists only as an emergency switch |
| Public **playground page** with a "demo only — don't paste real data" banner | ✅ Already built in Phase 3 (`gateway/public/playground.*`). Interviewers can try it in the browser, on any device |

---

## 12. Interview talking points

- "Atlas only stores ciphertext. Even if the database leaks, the data is useless without the master key, which never leaves the gateway."
- "Tools like Microsoft Purview and Nightfall solve this globally, but they're expensive and weak on Indian identifiers.
  Mine is free, self-hosted, and validates Indian IDs with real checksums."
- "Aadhaar detection uses the Verhoeff checksum, so random 12-digit numbers aren't flagged."
- "GSTIN is validated with GSTN's mod-36 check character, and its state code must be real."
- "Weak formats like passport numbers need a keyword nearby. That's a deliberate precision/recall trade-off."
- "Per-session keys come from HKDF, which limits the damage if one key is exposed."
- "TTL indexes delete the vault on their own, so sensitive data isn't kept forever."
- "Each encrypted value is sealed to its session and tag with GCM's associated data, so an attacker
  with database access can't even swap two encrypted values between rows. The tag check catches it."
- "Tag numbering uses an atomic $inc plus a unique index, and I tested 10 simultaneous requests
  for the same value to show they all get one tag."
- "The audit log proves what was blocked without storing what was blocked."

---

## 13. Exceptional features (Phases 3.5–6)

### Market check (November 2026)
| Product | What it is |
|---|---|
| Prompt Security | GenAI security company ($5M seed); not Indian |
| SecureGPT | A Chrome extension that masks data before chatbots; no India link found |
| **NexusNest** (New Delhi) | Masks sensitive data before ChatGPT/Claude; closest to this project |
| **Protecto GPTGuard** | PII tokenization with an India DPDP profile; enterprise |
| **Infopercept Invinsense** | LLM gateway with keyword-based AI DLP |
| **Repello AI** (Bengaluru) | GenAI security platform |

So "India-first masking" alone is **not** unique. Context: India's DPDP Act is partly in force and is
reported to be fully enforced by April 2027.
Only marketing pages were checked, so in interviews say "I didn't see X in their public material",
never "nobody does X".

### Phase 3.5: Bypass-resistant detection ✅ (~1–2% usage)
Employees will try to get around the filter. Normalise the text BEFORE detecting, then map positions
back to the original text so masking still replaces the right characters.
| Trick | Example | Fix |
|---|---|---|
| Indic digits | `२३४५ ६७८९ ०१२४` (Devanagari), `২৩৪৫…` (Bengali) | Convert all Unicode decimal digits to 0–9 |
| Invisible characters | `2345​6789​0124` (zero-width space) | Strip zero-width / format characters |
| Spaced-out digits | `2 3 4 5 6 7 8 9 0 1 2 4` | Collapse single spaces/dots between digits |
| Look-alike letters | Cyrillic `А`, `В`, `Е` inside a PAN | Map common homoglyphs to Latin (Unicode confusables) |
| Full-width characters | `ＡＢＣＰＥ１２３４Ｆ` | Unicode NFKC normalisation |
| Hindi/Bengali keywords | `आधार`, `পাসপোর্ট`, `खाता संख्या` | Add Indic keywords to the context lists |
Demo: "Try to sneak an Aadhaar past me."

### Phase 4: Tamper-proof audit log + DPDP report (~2% usage)
- **Hash-chained audit log**: every entry stores `hash = SHA-256(previous hash + this entry)`.
  Editing or deleting any old entry breaks every hash after it, so tampering is detectable.
- `GET /api/audit/verify` re-walks the chain and reports the first broken entry.
- Optional: sign the latest hash with an Ed25519 key (`node:crypto`) as a daily "checkpoint".
- **DPDP report** (`GET /api/reports/dpdp`): which categories of personal data were stopped, from which
  source, going to which AI provider, over a date range. Never includes the data itself.
Pitch: "Protection plus *proof* for the Data Protection Board."

### Phase 5: Private code leak detection (~2–3% usage)
- The company registers its repos: `npm run register-code -- <folder>`.
- Each file is **fingerprinted with winnowing** (the algorithm behind the MOSS plagiarism detector):
  normalise the code (remove comments and whitespace, rename identifiers to a fixed token) →
  k-gram hashes → keep the minimum hash in each sliding window.
- Only fingerprints are stored (`codefingerprints` collection), **never the code itself**.
- On `/mask`, pasted text is fingerprinted the same way; if enough fingerprints match a registered
  file, the policy decides: **block** (default) or warn.
- New type: `PRIVATE_CODE`. Catches renamed variables, reformatting and partial copies.
- As built: K = 12 tokens, window W = 8, so any copied run of 19+ tokens (about 2–3 lines) is
  guaranteed to share a fingerprint. A paste is flagged only where 8+ matches form a dense cluster,
  so generic snippets (a for-loop) aren't flagged. Fingerprints are HMAC-keyed (48-bit) from MASTER_KEY.
- Known limitation: very common boilerplate that IS in a registered repo (e.g. an Express setup)
  could match other people's identical boilerplate. Fix later: an "ignore" list, or don't register boilerplate files.

### Phase 6: Local AI for names and addresses (~3–4% usage)
- **transformers.js** runs a small NER model (named entity recognition) locally in Node. Free, offline:
  names never go to another AI just to be detected.
- New types: `PERSON`, `ADDRESS` (plus `ORG` optional).
- Indian address patterns help the model: PIN code (6 digits starting 1–9), "Sector", "Nagar",
  "Road", "Flat", city names.
- Runs AFTER the regex detectors; the overlap rules decide conflicts (regex wins at equal length).
- First run downloads the model (~100 MB); after that it works offline.

### New pitch
> "Protecto and NexusNest mask Indian data. Mine also **can't be bypassed** with Devanagari digits or
> invisible characters, **catches leaks of your source code**, and produces **tamper-proof DPDP
> evidence**. It's free and self-hosted for Indian SMBs."
