# Safe AI Gateway: browser extension

*Built by [Subhodip Shee](https://github.com/SubhodipShee) · © 2026 · All rights reserved.*
*You may install and try it. Copying, modifying, sharing further or publishing it (including in any store) needs written permission. See [LICENSE.txt](LICENSE.txt).*

Protects what you type into **ChatGPT, Claude and Gemini**. Before your message is sent,
sensitive data (emails, phone numbers, Aadhaar, PAN, API keys, names…) is replaced with
tags like `[[EMAIL_1]]`. The AI only sees the tags; on **your** screen the real values come back,
highlighted in green.

> **This is a demo. Please type fake data only.**
> It's connected to the gateway at https://safe-ai-gateway.onrender.com. There's nothing to set up: install it and use it.

## Install (2 minutes, Chrome or Edge)

1. **Download** the extension (26 KB): **[safe-ai-gateway-extension.zip](https://github.com/SubhodipShee/safe-ai-data-gateway/raw/main/download/safe-ai-gateway-extension.zip)**
2. **Unzip** it (right-click → *Extract All*).
3. Open the extensions page:
   - Chrome: type `chrome://extensions` in the address bar
   - Edge: type `edge://extensions`
4. Switch on **Developer mode** (top right in Chrome, left side in Edge).
5. Click **Load unpacked** and choose the unzipped **`safe-ai-gateway-extension`** folder (the one with `manifest.json` inside).
6. Click the 🧩 puzzle icon in the toolbar and **pin** "Safe AI Gateway".

It isn't in the Chrome Web Store (that costs a fee), which is why it's installed this way.

## Try it

1. Click the 🛡️ icon. The popup should say **✔ Connected**.
   If it says ✘, the free server is waking up (it sleeps when nobody uses it). Wait about a minute and open the popup again.
2. Open **chatgpt.com** and send this fake message:
   ```
   Write a refund email for Rahul Verma, rahul@gmail.com, PAN ABCPE1234F, Aadhaar 2345 6789 0124
   ```
3. A green note shows **"4 items protected"**. ChatGPT's answer shows the real values in green.
4. Want to see what ChatGPT actually received? In the popup, switch **off** "Show real values on my screen".
   The chat now shows `[[PERSON_1]]`, `[[EMAIL_1]]`… Switch it back on afterwards.

No ChatGPT account? Use the demo chat instead: https://safe-ai-gateway.onrender.com/chat-demo.html.
Its right-hand panel shows exactly what the "AI server" received.

## Good to know

- **If the gateway can't be reached, nothing is sent** (your text stays in the box). That's on purpose: it's safer to stop than to leak.
- Only what you **type or paste** into the chat box is checked. File uploads aren't checked yet.
- With the demo gateway, the masked values are stored **encrypted** (AES-256) and deleted automatically after 24 hours. That's still another person's server, so: **fake data only**.

## Remove it

`chrome://extensions` → Safe AI Gateway → **Remove**.
