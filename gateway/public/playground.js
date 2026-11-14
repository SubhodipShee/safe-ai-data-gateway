// =============================================================================
// playground.js: the logic behind playground.html
// =============================================================================
//
// Talks to the gateway on the SAME address the page came from, so it works on
// localhost today and on the hosted URL later without any changes.
//
//   "Mask it"              → POST /mask
//   "Restore real values"  → POST /unmask
//   "Delete my session"    → DELETE /session/<id>
// =============================================================================

// ---- Example prompts (all FAKE data) ----
const EXAMPLES = {
  'Customer refund': [
    'Draft a polite refund email for our customer Rahul Verma.',
    'Ship the replacement to Flat 4B, Salt Lake Sector V, Kolkata 700091.',
    'Email: rahul.verma@gmail.com, phone +91 98765 43210.',
    'PAN ABCPE1234F, Aadhaar 2345 6789 0124.',
    'Refund to A/c 50100123456789, IFSC HDFC0001234, or UPI rahul@okicici.',
  ].join('\n'),
  'Developer config': [
    'Why does my app fail to connect? Here is my .env:',
    'MONGODB_URI=mongodb+srv://admin:Pa55w0rd@cluster0.ab12c.mongodb.net/shop',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'DB_PASSWORD=Sup3rS3cret!',
  ].join('\n'),
  'Business KYC': [
    'Summarise this vendor KYC:',
    'GSTIN 27AAPFU0939F1ZV, Voter ID ABC1234567, Passport K1234567,',
    'DL MH14 20110062821, contact priya.shah@vendor.co.in',
  ].join('\n'),
  // Phase 3.5: every value below is disguised to try to sneak past the filter.
  'Bypass attempt 😈': [
    'Aadhaar in Hindi digits: २३४५ ६७८९ ०१२४',
    'PAN with Cyrillic letters: АВСРЕ1234F',
    'Email with an invisible character: rahul\u200B.verma@gmail.com',
    'Phone one digit at a time: 9 8 7 6 5 4 3 2 1 0',
    'पासपोर्ट K1234567',
  ].join('\n'),
  // Phase 5: a RENAMED and REFORMATTED copy of demo/acme-payments/src/refund-service.js
  // (every variable renamed, semicolons removed, comment added). Still caught.
  'Private code 🔒': [
    'Can you optimise this function? Our refunds are slow.',
    '',
    'async function getRefundValue(o, p) {',
    '    // compute the refund',
    '    const d = daysSince(o.deliveredAt)',
    '    if (d > (p.maxDays ?? WINDOW)) {',
    '        throw new Error("too late")',
    '    }',
    '    let amt = o.total - o.shippingFee',
    '    if (o.coupon) {',
    '        amt = amt * (1 - o.coupon.discount)',
    '    }',
    "    if (o.paymentMethod === 'upi' && o.cashbackApplied) {",
    '        amt -= o.cashbackAmount',
    '    }',
    '    return Math.round(amt * 100) / 100',
    '}',
  ].join('\n'),
  'Nothing sensitive': 'Summarise our Q3 meeting: revenue grew 12% and we hired 4 engineers in Kolkata.',
};

// ---- Page elements ----
const promptBox = document.getElementById('prompt');
const replyBox = document.getElementById('reply');
const maskButton = document.getElementById('mask-btn');
const unmaskButton = document.getElementById('unmask-btn');
const clearButton = document.getElementById('clear-btn');
const maskResult = document.getElementById('mask-result');
const unmaskResult = document.getElementById('unmask-result');
const clearResult = document.getElementById('clear-result');

// =============================================================================
// SESSION ID: a random ID that groups this visitor's tags together
// =============================================================================
function makeRandomId() {
  // randomUUID only works on https:// or localhost, so fall back to random bytes elsewhere.
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function loadSessionId() {
  // Keep the same session while this browser tab is open (if storage is available).
  try {
    const saved = sessionStorage.getItem('safe-ai-session');
    if (saved) return saved;
    const fresh = makeRandomId();
    sessionStorage.setItem('safe-ai-session', fresh);
    return fresh;
  } catch {
    return makeRandomId();
  }
}

let sessionId = loadSessionId();
document.getElementById('session-id').textContent = sessionId.slice(0, 8) + '…';

// =============================================================================
// HELPERS
// =============================================================================

/** Sends JSON to the gateway and returns { ok, status, data }. */
async function callGateway(method, path, body) {
  try {
    const response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'Could not reach the gateway. Is it running?' } };
  }
}

/** Creates an element with optional class and text (textContent is always safe from HTML injection). */
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Shows text with every [[TAG_1]] highlighted. Built from text nodes, never innerHTML. */
function textWithTags(text) {
  const box = element('div', 'output');
  for (const part of text.split(/(\[\[[A-Z_]+_\d+\]\])/)) {
    if (/^\[\[[A-Z_]+_\d+\]\]$/.test(part)) {
      box.append(element('span', 'tag', part));
    } else if (part) {
      box.append(document.createTextNode(part));
    }
  }
  return box;
}

function notice(kind, message) {
  return element('p', `notice ${kind}`, message);
}

/** Writes a believable AI reply that mentions every tag, so "Restore" has something to restore. */
function simulatedReply(items) {
  const tags = [...new Set(items.map((item) => item.placeholder))];
  if (tags.length === 0) {
    return 'Sure! Here is a summary of your notes. (Nothing sensitive was found, so there is nothing to restore.)';
  }
  return [
    "Sure, here's a draft based on your details.",
    '',
    'Hello,',
    `We've updated the records for ${tags.join(', ')}.`,
    `If anything is wrong, reply to this message and quote ${tags[0]}.`,
  ].join('\n');
}

// =============================================================================
// BUTTONS
// =============================================================================

// Example chips
const examplesBox = document.getElementById('examples');
for (const [name, text] of Object.entries(EXAMPLES)) {
  const chip = element('button', '', name);
  chip.type = 'button';
  chip.addEventListener('click', () => {
    promptBox.value = text;
    promptBox.focus();
  });
  examplesBox.append(chip);
}
promptBox.value = EXAMPLES['Customer refund'];

// STEP 2: Mask it
maskButton.addEventListener('click', async () => {
  maskButton.disabled = true;
  maskResult.replaceChildren(element('p', 'empty', 'Masking…'));

  const { ok, status, data } = await callGateway('POST', '/mask', {
    sessionId,
    text: promptBox.value,
    source: 'playground',
  });
  maskButton.disabled = false;

  // Blocked by a policy (e.g. a private key)
  if (status === 403 && data.blocked) {
    const types = Object.keys(data.blockedTypes).join(', ');
    const parts = [notice('bad', `Blocked: this text contains ${types}, which must never be sent to an AI. Nothing was sent.`)];
    // Phase 5: say WHICH registered file the pasted code came from.
    for (const item of data.blockedItems ?? []) {
      if (item.type === 'PRIVATE_CODE') {
        parts.push(element('p', 'small', `🔒 Matches the company's private file: ${item.label}`));
      }
    }
    maskResult.replaceChildren(...parts);
    unmaskButton.disabled = true;
    return;
  }
  if (!ok) {
    maskResult.replaceChildren(notice('bad', data.error || `Error ${status}`));
    return;
  }

  // Success: show the safe text, plus a chip per type
  const count = data.items.length;
  const parts = [
    notice('ok', count ? `${count} sensitive item(s) replaced. The AI only sees the tags below.` : 'Nothing sensitive found. The text is sent unchanged.'),
  ];
  // Phase 3.5: some values were disguised (Hindi digits, invisible characters, look-alike letters…)
  if (data.bypassAttempts > 0) {
    parts.push(notice('warn', `⚠ ${data.bypassAttempts} bypass attempt(s) caught: disguised values were detected anyway and logged.`));
  }
  parts.push(textWithTags(data.maskedText));
  if (count) {
    const chips = element('ul', 'chips');
    for (const [type, n] of Object.entries(data.summary)) chips.append(element('li', '', `${type} × ${n}`));
    parts.push(chips);
  }
  maskResult.replaceChildren(...parts);

  replyBox.value = simulatedReply(data.items);
  unmaskButton.disabled = false;
  unmaskResult.replaceChildren();
});

// =============================================================================
// STEP 3a: Ask the REAL AI (Phase 7) → POST /v1/chat/completions
// =============================================================================
const askAiButton = document.getElementById('ask-ai-btn');
const aiStatus = document.getElementById('ai-status');

// Is an AI provider configured on the gateway? (/health tells us.)
callGateway('GET', '/health').then(({ data }) => {
  if (data.ai) {
    askAiButton.disabled = false;
    askAiButton.textContent = `Ask the real AI (${data.ai.provider})`;
    aiStatus.textContent = `model: ${data.ai.model}`;
  } else {
    aiStatus.textContent = 'No AI key on the gateway yet: add a free Groq key to gateway/.env to enable this.';
  }
});

askAiButton.addEventListener('click', async () => {
  askAiButton.disabled = true;
  unmaskResult.replaceChildren(element('p', 'empty', 'Masking, asking the AI, restoring…'));

  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId, 'X-Gateway-Source': 'playground' },
    body: JSON.stringify({ messages: [{ role: 'user', content: promptBox.value }] }),
  }).catch(() => null);
  const data = response ? await response.json().catch(() => ({})) : { error: { message: 'Could not reach the gateway.' } };
  askAiButton.disabled = false;

  if (!response?.ok) {
    const blocked = data.error?.type === 'policy_violation';
    const parts = [notice('bad', blocked ? `Blocked: nothing was sent to the AI. ${data.error.message}` : data.error?.message || 'AI request failed')];
    for (const item of data.error?.blocked_items ?? []) {
      if (item.type === 'PRIVATE_CODE') parts.push(element('p', 'small', `🔒 Matches the company's private file: ${item.label}`));
    }
    unmaskResult.replaceChildren(...parts);
    return;
  }

  const g = data.gateway;
  unmaskResult.replaceChildren(
    notice('ok', `Real reply from ${g.provider}. It only ever saw the tags; ${g.restoredTags} tag(s) were restored for you.`),
    element('p', 'small', `What ${g.provider} actually wrote:`),
    textWithTags(g.aiReplyWithTags),
    element('p', 'small', 'What you see:'),
    element('div', 'output', data.choices[0].message.content),
  );
});

// STEP 3b: Restore a simulated reply
unmaskButton.addEventListener('click', async () => {
  unmaskButton.disabled = true;
  const { ok, status, data } = await callGateway('POST', '/unmask', { sessionId, text: replyBox.value });
  unmaskButton.disabled = false;

  if (!ok) {
    unmaskResult.replaceChildren(notice('bad', data.error || `Error ${status}`));
    return;
  }
  const parts = [
    notice('ok', `${data.restored} tag(s) restored. This is what the employee sees:`),
    element('div', 'output', data.text),
  ];
  if (data.unknown.length) {
    parts.push(notice('bad', `Not restored (unknown, expired or from another session): ${data.unknown.join(', ')}`));
  }
  unmaskResult.replaceChildren(...parts);
});

// =============================================================================
// STEP 4: audit log evidence (Phase 4)
// =============================================================================
const auditResult = document.getElementById('audit-result');

// "Verify audit log" → GET /api/audit/verify
document.getElementById('verify-btn').addEventListener('click', async () => {
  auditResult.replaceChildren(element('p', 'empty', 'Checking every entry…'));
  const { ok, data } = await callGateway('GET', '/api/audit/verify');
  if (!ok) {
    auditResult.replaceChildren(notice('bad', data.error || 'Could not verify'));
    return;
  }

  const parts = [];
  if (data.valid) {
    parts.push(notice('ok', `✔ Audit log intact: ${data.entriesChecked} entries checked, every link and the signed head match.`));
  } else {
    parts.push(notice('bad', `✘ TAMPERING DETECTED: ${data.problems.length} problem(s) found.`));
    const list = element('ul', 'problems');
    for (const p of data.problems) list.append(element('li', '', p.message));
    parts.push(list);
  }
  for (const note of data.notes) parts.push(element('p', 'small', note));
  auditResult.replaceChildren(...parts);
});

// "DPDP report" → GET /api/reports/dpdp
document.getElementById('report-btn').addEventListener('click', async () => {
  auditResult.replaceChildren(element('p', 'empty', 'Building report…'));
  const { ok, data } = await callGateway('GET', '/api/reports/dpdp');
  if (!ok) {
    auditResult.replaceChildren(notice('bad', data.error || 'Could not build the report'));
    return;
  }

  const t = data.totals;
  const parts = [
    notice(data.auditLogIntegrity.valid ? 'ok' : 'bad',
      `${t.itemsMasked} item(s) masked · ${t.itemsBlocked} blocked · ${t.bypassAttempts} bypass attempt(s) · audit log ${data.auditLogIntegrity.valid ? 'intact ✔' : 'TAMPERED ✘'}`),
  ];

  // A small table: category → masked / blocked
  if (data.byCategory.length) {
    const table = element('table', 'report');
    const head = element('tr');
    for (const h of ['Category', 'Masked', 'Blocked']) head.append(element('th', '', h));
    table.append(head);
    for (const c of data.byCategory) {
      const row = element('tr');
      row.append(element('td', '', c.category), element('td', '', String(c.masked)), element('td', '', String(c.blocked)));
      table.append(row);
    }
    parts.push(table);
  }

  const providers = data.byDestination.map((d) => `${d.aiProvider} (${d.masked + d.blocked})`).join(', ');
  if (providers) parts.push(element('p', 'small', `Stopped before reaching: ${providers}`));
  parts.push(element('p', 'small', `Signed with Ed25519 key ${data.signature.keyFingerprint}. ${data.disclaimer}`));
  auditResult.replaceChildren(...parts);
});

// Delete this session's stored values right away
clearButton.addEventListener('click', async () => {
  const { ok, data } = await callGateway('DELETE', `/session/${sessionId}`);
  clearResult.textContent = ok
    ? `Deleted ${data.deleted} stored value(s). A new session has started.`
    : data.error || 'Could not delete the session.';

  if (ok) {
    sessionId = makeRandomId();
    try { sessionStorage.setItem('safe-ai-session', sessionId); } catch { /* storage unavailable */ }
    document.getElementById('session-id').textContent = sessionId.slice(0, 8) + '…';
    unmaskButton.disabled = true;
  }
});
