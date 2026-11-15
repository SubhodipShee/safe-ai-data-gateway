# 🛡️ Safe AI Data Gateway

**Use ChatGPT, Claude and Gemini at work without leaking customer data, keys or source code.**

Built by **[Subhodip Shee](https://github.com/SubhodipShee)**.

**Live demo:** https://safe-ai-gateway.onrender.com (free server: the first visit after a quiet period takes about a minute to wake up. Use fake data only.)

Employees paste customer details, API keys and private code into AI chatbots every day.
This gateway and its browser extension replace the sensitive parts with tags like `[[EMAIL_1]]`
*before* the text leaves the company. The AI then answers using those tags, and the real values
are put back for the employee on their own screen.

```
You type:        Refund Rahul Verma, rahul@gmail.com, PAN ABCPE1234F
ChatGPT gets:    Refund [[PERSON_1]], [[EMAIL_1]], PAN [[PAN_1]]
ChatGPT replies: Dear [[PERSON_1]], your refund for PAN [[PAN_1]] is processed…
You see:         Dear Rahul Verma, your refund for PAN ABCPE1234F is processed…
```

Free, self-hosted, and built for India: Aadhaar, PAN and GSTIN are validated with their real checksums.

---

## The problem it solves

- **People paste sensitive data into AI chatbots every day.** Customer names, phone numbers, Aadhaar and PAN
  numbers, bank details, API keys, even the company's source code. Once sent, it sits on another company's
  servers and can't be taken back.
- **In India this is now a legal risk.** Under the Digital Personal Data Protection (DPDP) Act, 2023,
  a company must protect the personal data it holds; failing to take reasonable security safeguards can
  cost up to ₹250 crore.
- **Companies are stuck with two bad options.** Ban AI tools (and lose the productivity, while people use them
  on their phones anyway), or allow them and hope nothing leaks.
- **This project is the third option:** keep using ChatGPT, Claude and Gemini, but only *masked* text ever
  leaves. The AI works with tags; the employee still sees a normal answer with the real values, and the
  company gets tamper-proof evidence of what was protected.

**Who it's for:** teams and small/medium companies in India that want to use AI safely, developers who call
AI APIs from their own apps, and whoever has to show DPDP compliance.

## Tools that already exist

This isn't the first AI data-leak tool. These products solve parts of the same problem
(checked from their public product pages, November 2026):

| Product | What it does |
|---|---|
| **Microsoft Purview** | Enterprise data-loss prevention across Microsoft 365, including AI apps; part of paid Microsoft plans |
| **Nightfall AI** | Cloud data-loss prevention that finds sensitive data in SaaS apps and AI prompts; paid, enterprise |
| **Prompt Security** | Security platform for company use of generative AI |
| **SecureGPT** | Browser extension that masks data before it reaches chatbots |
| **NexusNest** (New Delhi) | Masks sensitive data before ChatGPT and Claude; the closest to this project |
| **Protecto GPTGuard** | Replaces personal data with tokens before AI, with an India DPDP profile; enterprise |
| **Infopercept Invinsense** | LLM gateway with keyword-based AI data-loss prevention |
| **Repello AI** (Bengaluru) | Security platform for generative AI |

So masking data before AI, even Indian data, is not new on its own. What's different is below.

## What this project adds

Features I didn't find described in those products' public material. They may have things they don't
advertise, so this is "not seen publicly", not "nobody does it".


| | |
|---|---|
| 🇮🇳 **India-first detection** | Aadhaar (Verhoeff checksum), PAN (holder-type check), GSTIN (mod-36 checksum), UPI IDs, IFSC, bank accounts, voter ID, passport, driving licence, Indian PIN-code addresses |
| 😈 **Can't be bypassed with tricks** | Catches data written in Hindi/Bengali/Tamil digits (`२३४५ ६७८९ ०१२४`), with invisible characters, Cyrillic look-alike letters, full-width text or spaced-out digits, and logs each attempt |
| 🔒 **Protects source code** | Registered repos are fingerprinted with *winnowing* (the algorithm behind the MOSS plagiarism detector). Pasted code is blocked even with every variable renamed and the formatting changed. No code is ever stored, only keyed hashes |
| 🤖 **Local AI for names** | A BERT named-entity model runs *inside* the gateway (offline, a few tens of milliseconds per message on a laptop) to find people's names. Names never go to another AI just to be detected |
| 🧾 **Tamper-proof evidence (DPDP Act)** | Every event is SHA-256 hash-chained with an Ed25519-signed head. Editing or deleting any audit entry is detected. Signed DPDP evidence reports |
| 🔐 **Encrypted vault** | Real values are stored with AES-256-GCM, one HKDF-derived key per session, sealed to their tag, and deleted automatically after 24 h |
| ↩️ **Answers still make sense** | The real values are put back into the AI's reply on the employee's screen, and the same value always gets the same tag, so the AI can reason about "[[PERSON_1]]" across a whole conversation |
| 💸 **Free and self-hosted** | Runs entirely on free tiers (Render, MongoDB Atlas M0, Groq). The data stays on infrastructure the company controls |

## Architecture

```mermaid
flowchart LR
    subgraph Laptop["Employee's browser"]
        EXT["Chrome extension<br/>(ChatGPT / Claude / Gemini)"]
    end
    APP["Developer's app<br/>(OpenAI SDK)"]

    subgraph GW["Gateway (Node.js + Express)"]
        DET["Detectors<br/>regex + checksums<br/>+ bypass cleaning"]
        NER["Local AI<br/>(names)"]
        CODE["Code fingerprints<br/>(winnowing)"]
        POL["Policies<br/>mask / block / allow"]
        VAULT["Vault<br/>AES-256-GCM"]
        AUDIT["Audit chain<br/>SHA-256 + Ed25519"]
    end

    DB[("MongoDB Atlas<br/>ciphertext + hashes only")]
    AI["AI provider<br/>(Groq / Gemini / OpenAI)"]

    EXT -- "/mask, /unmask" --> GW
    APP -- "/v1/chat/completions" --> GW
    DET --> POL
    NER --> POL
    CODE --> POL
    POL --> VAULT
    POL --> AUDIT
    VAULT --> DB
    AUDIT --> DB
    GW -- "masked text only" --> AI
```

**Neither the database nor the AI provider ever sees a real value.** Atlas stores only ciphertext,
keyed hashes and counts. The master key lives only in the gateway's environment.

## Four ways to use it

1. **Browser extension**: protects people using chatgpt.com, claude.ai and gemini.google.com directly. It's connected to the live gateway: install it and use it, with nothing to set up. **[Download the extension (zip)](https://github.com/SubhodipShee/safe-ai-data-gateway/raw/main/download/safe-ai-gateway-extension.zip)** · [Install guide](extension/README.md).
2. **VS Code extension** (for AI coding tools: Copilot, Claude Code, Codex, Cursor…): underlines Aadhaar, PAN and API keys in your files, protects secret files from AI tools, and copies code with values masked. Runs fully offline. *In development: private for now, not yet available for download.*
3. **API proxy**, also for **AI coding agents** (Claude Code via `/agent/anthropic`; Cline, Continue, Aider… via `/agent/v1`; masks the files they read, with streaming): OpenAI-compatible `POST /v1/chat/completions`. Existing code changes **one line**, the base URL.
4. **Playground + dashboard**: try it in any browser, and see what was stopped, by whom and where.

## Quick start (Windows `cmd`, all free)

You need Node.js 24, a free [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) M0 cluster and,
optionally, a free [Groq](https://console.groq.com) API key.

```
cd gateway
npm install
copy .env.example .env
npm run gen-key
```

Put the generated key in `.env` as `MASTER_KEY=`, then add your `MONGODB_URI` (and `AI_API_KEY`).

| Command | What it does |
|---|---|
| `npm run dev` | Start the gateway on http://127.0.0.1:7000 (reloads on save) |
| `npm test` | Run the 251 automated tests (some against your Atlas test databases) |
| `npm run check-db` | Check the Atlas connection without printing the password |
| `npm run check-ai` | Check the AI key and list the models it can use |
| `npm run register-code -- ../demo/acme-payments` | Protect a code folder (only fingerprints are stored) |
| `npm run tamper-demo` | Watch the audit chain catch an attacker (uses a throwaway database) |
| `npm run vault-demo` | See exactly what Atlas stores for a masked value |
| `npm run zip-extension` | Rebuild `download/safe-ai-gateway-extension.zip` after changing the extension (a test checks it's up to date) |
| `npm run download-model` | Download the local AI name model ahead of time (Render does this while building) |

Then open:
- **http://127.0.0.1:7000**: playground (mask → real AI → restore)
- **http://127.0.0.1:7000/dashboard.html**: dashboard, policies, audit verification
- **http://127.0.0.1:7000/chat-demo.html**: demo chat for the extension

**Browser extension:** `chrome://extensions` → *Developer mode* → *Load unpacked* → select the `extension` folder. It always talks to the live gateway. To use a gateway on your laptop instead, change `GATEWAY_URL` in `extension/background.js` and `host_permissions` in `extension/manifest.json`.

## Deploy online (free)

`render.yaml` describes the whole service for [Render](https://render.com)'s free plan:
512 MB RAM (the gateway uses about 290 MB with the AI model), free HTTPS, auto-deploy on every push.

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → pick the repo. Paste `MONGODB_URI`, `MASTER_KEY` (the same one as on your laptop) and `AI_API_KEY` when asked. Render generates `ADMIN_KEY` itself.
3. MongoDB Atlas → **Network Access** → allow `0.0.0.0/0` (Render's free plan has no fixed IP).
4. Open `https://<your-service>.onrender.com`. A free service sleeps after 15 minutes without visitors, so the first visit takes about a minute.

Setting `HOST=0.0.0.0` switches on **public mode** (see `gateway/src/security.js`).

## Use it with AI coding agents (on your laptop)

AI coding agents read your files and send them to their AI. Point them at the gateway and **everything**
they send (your messages, the files they read, their tool calls) is masked first. Streaming works.

1. Start the gateway on your laptop:
   ```
   cd gateway
   npm run dev
   ```
   Check http://127.0.0.1:7000/health shows `"agentProxy":"on"`.
2. In your agent, choose the **"OpenAI Compatible"** provider:

   | Field | Value |
   |---|---|
   | Base URL | `http://127.0.0.1:7000/agent/v1` |
   | API key | `local` (any value on your laptop) |
   | Model | the gateway's model, e.g. `openai/gpt-oss-120b` (Groq) or `gemini-2.5-flash` (Gemini) |

   Works with **Cline, Continue, Roo Code, Aider** and other tools with an OpenAI-compatible setting.
3. The AI that answers is the one in `gateway/.env` (`AI_PROVIDER`, `AI_API_KEY`). Agents send long requests;
   if Groq's free tier says "limit reached", a free Gemini key usually allows more per minute.

### Claude Code

Claude Code can send everything through the gateway too, **with your normal Claude login and plan**
(the gateway passes your login on to Anthropic unchanged; only the sensitive text inside is masked).

1. Start the gateway on your laptop (`npm run dev` in `gateway`).
2. Start Claude Code with the gateway's address. In cmd:
   ```
   set ANTHROPIC_BASE_URL=http://127.0.0.1:7000/agent/anthropic
   claude
   ```
   Or for one project, add to `.claude/settings.local.json`:
   `{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:7000/agent/anthropic" } }`
3. Keep the gateway running while that's set. To stop using it, remove the line (or close that cmd window).

Messages, files Claude Code reads, CLAUDE.md and tool calls are masked; answers and file edits get the real
values back. Streaming, prompt caching and Claude's thinking keep working.

**Online:** on Render the coding-tool proxies only answer requests that carry the private `AGENT_KEY`
(the owner's VS Code extension has it built in), so nobody else can use the server. Online, people's
**names** in coding tools' files are not masked: measured on Render's free 0.1 CPU, the name model needs 43 s
for one 10 KB file. Every other check takes under 0.5 s. The laptop gateway masks names too.

A VS Code extension (Copilot Chat model, file protection, copy masked) is in private testing.

## Security design

| Concern | How it's handled |
|---|---|
| Database stolen | Values are AES-256-GCM ciphertext; keys are derived per session (HKDF) from a master key that is never stored in the database |
| Ciphertext swapped between rows | GCM associated data binds each value to its session and tag, so swapping fails decryption |
| Same value, consistent tags | HMAC-SHA256 fingerprint (keyed, irreversible) with a unique index |
| Simultaneous requests | Atomic `$inc` counters + unique indexes, tested with 10–20 parallel writers |
| Audit log edited | Hash chain + Ed25519-signed head: edits, deletions, truncation and full rewrites are all detected |
| AI drops or alters a tag | The proxy instructs the model to keep tags; restore accepts `[EMAIL_1]`, `[[ EMAIL_1 ]]`… |
| Gateway down | Extension refuses to send by default (fail-closed) |
| Unsure the text was replaced | Extension re-reads the editor and refuses to send unless it matches the masked text |
| Strangers online | Public mode: HTTPS only, security headers (CSP), per-visitor rate limits, a daily cap on AI requests, and an admin key to change policies |
| Data kept forever | TTL indexes delete vault data after 24 h and audit logs after 90 days |

## Project structure

```
gateway/
  src/
    detectors/     email, phone, PAN, Aadhaar, India IDs, secrets, entropy, addresses, normalize (bypass)
    ai/            local name finder (BERT-NER), LLM client (Groq/Gemini/Ollama)
    code/          winnowing fingerprints + code guard
    crypto/        HKDF keys, AES-GCM + HMAC, Ed25519 signing
    audit/         hash chain, DPDP report
    models/        MongoDB collections
    routes/        HTTP endpoints
    masker.js      detect → policy → vault → replace → audit
    vault.js       encrypted storage of real values
  public/          playground, dashboard, demo chat
  test/            251 tests
extension/         browser extension (Chrome/Edge, Manifest V3)
vscode-extension/  VS Code extension for AI coding tools (private for now: kept on the owner's laptop, not in this repo)
demo/              fake "ACME Payments" repo + demo script
download/          the browser extension as a zip, ready to share
PLAN.md            full design and build log
AGENTS.md          guide for AI coding agents and new developers (structure, rules, how to add features)
```

## Free stack

Node.js 24 · Express 5 · helmet · express-rate-limit · MongoDB Atlas M0 · Mongoose · `node:crypto` · libphonenumber-js ·
transformers.js (BERT-NER, local) · Groq free tier · Render free plan · Chrome Manifest V3 · plain HTML/CSS/SVG (no chart library).
Total cost: **₹0**.

## Known limitations

- Names are found in Latin script only; a name written in Devanagari isn't detected yet.
- The extension checks what's typed or pasted into the chat box; file uploads aren't checked yet.
- Very common boilerplate code in a registered repo could match identical boilerplate elsewhere.
- Rolling the audit log back to an older signed head needs an external anchor to detect (e.g. publishing the daily head hash).
- Streaming responses are not supported by the API proxy yet.

---
*Technical evidence to support DPDP Act, 2023 compliance. Not legal advice.*

© 2026 Subhodip Shee. All rights reserved. You may view the code and try the extension and demo; copying, modifying, redistributing or publishing it needs written permission. See [LICENSE](LICENSE).
