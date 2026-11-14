# 5-minute interview demo

**Before the interview (2 minutes):**
- **Online:** open `https://<your-service>.onrender.com/health` and wait until it shows `"db":"connected"`.
  The free server sleeps after 15 minutes with no visitors and needs about a minute to wake up.
  Interviewers can open the same link on their phones.
- **Or on the laptop:** `cd gateway` → `npm run dev`. Wait for `[db] connected` and `[ai] name detection: ready`.
- Open 3 tabs: the **playground** (`/`), the **dashboard** (`/dashboard.html`) and **chatgpt.com**.
- Extension popup → **Gateway URL** = the same address you're using (Render or `http://127.0.0.1:7000`).
- On the Render site, the dashboard's policies are locked: press **Unlock** and paste the `ADMIN_KEY` from Render → Environment.
- In the extension popup: Protection **on**, Show real values **on**.
- Have **Atlas → Data Explorer → safe-ai-gateway → auditlogs** open in another tab (for the tamper demo).

---

## 1. The problem (30 s)
> "Employees paste customer data and code into ChatGPT every day. Companies either ban AI and lose
> productivity, or allow it and risk a DPDP violation. This gateway lets them use AI safely."

## 2. ChatGPT, live (60 s)
In chatgpt.com, send:
```
Refund Rahul Verma, rahul@gmail.com, PAN ABCPE1234F, Aadhaar 2345 6789 0124
```
- Point at the toast: **"4 items protected"**.
- The values appear **green**: restored on my screen only.
- Popup → switch **off** "Show real values": the chat now shows `[[PERSON_1]]`, `[[EMAIL_1]]`…
  > "This is exactly what OpenAI received."
- Switch it back on.

## 3. Try to cheat (45 s)
Playground → **Bypass attempt 😈** → *Mask it*.
> "Hindi digits, invisible characters, Cyrillic letters, a phone typed one digit at a time.
> All caught, and the attempt itself is logged."

## 4. Private code (30 s)
Playground → **Private code 🔒** → *Mask it* → **Blocked**, naming the file.
> "Every variable renamed, no semicolons, different formatting. It's still matched by winnowing
> fingerprints. The database has no code at all, only keyed hashes."

## 5. A real AI, end to end (30 s)
Playground → **Customer refund** → **Ask the real AI (Groq)**.
> "Groq wrote `Dear [[PERSON_1]]`; I see `Dear Rahul Verma`. It never saw the name."

## 6. Evidence that can't be faked (60 s)
Dashboard → **Verify audit log now** → ✔ Intact.
- In Atlas, edit any `count` in `auditlogs` → **Verify** again → **✘ Tampering detected**, with the exact entry.
- Change it back → ✔ Intact.
> "Hash chain plus an Ed25519-signed head. Even a database admin can't quietly change the evidence."
- Click **Download signed DPDP report**.

## 7. Close (15 s)
> "Free, self-hosted, India-first: Aadhaar Verhoeff, GSTIN checksums, local AI for names, and
> 248 automated tests. Developers can use it too: it's an OpenAI-compatible proxy, one-line change."

---

## Likely questions

| Question | Short answer |
|---|---|
| Why not just regex? | Checksums cut false alarms (only ~1 in 10 random 12-digit numbers pass Verhoeff); a local BERT model finds names; winnowing finds code |
| What if the database leaks? | AES-256-GCM ciphertext with per-session HKDF keys; the master key never touches the database |
| What if the AI changes the tag? | Tolerant restore (`[EMAIL_1]`, `[[ EMAIL_1 ]]`) plus a system instruction to keep tags; tested with real models |
| What if the gateway is down? | The extension fails closed: nothing is sent |
| Can employees switch the extension off? | In a company it's force-installed with Chrome enterprise policy |
| How is this different from Purview / Nightfall? | Bypass-resistant Indian IDs, keyed code fingerprinting, tamper-evident DPDP evidence; free and self-hosted |
| It's public: can't anyone abuse it? | Rate limits per visitor, a daily cap on AI calls, CSP headers, HTTPS only, and only the admin key can change policies. Only ciphertext reaches the database |
| Limitations? | Latin-script names only; file uploads not checked yet; audit rollback needs an external anchor |

**If chatgpt.com changes its layout during the demo:** use `/chat-demo.html`. Same extension, and the
right-hand panel shows exactly what the "AI server" received.
