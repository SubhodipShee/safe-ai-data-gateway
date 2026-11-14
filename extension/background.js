// =============================================================================
// background.js: the extension's "service worker" (runs in the background)
// =============================================================================
//
// WHY IS THIS NEEDED?
// The content script (content.js) runs INSIDE chatgpt.com. A page on https://
// isn't allowed to call http://127.0.0.1 (browsers block it). The background
// worker belongs to the extension itself, and with "host_permissions" in
// manifest.json it MAY call the gateway. So:
//
//   content.js ──message──► background.js ──fetch──► gateway (/mask, /unmask, /health)
//
// It also keeps the settings (gateway address, on/off, what to do if the gateway
// is down) and simple counters for the popup.
// =============================================================================

const DEFAULT_SETTINGS = {
  enabled: true,
  // The public demo gateway (Phase 10), so the extension works right after installing.
  // Running your own gateway? Change it in the popup, e.g. http://127.0.0.1:7000
  gatewayUrl: 'https://safe-ai-gateway.onrender.com',
  // If the gateway can't be reached: 'block' = don't send (safe, recommended)
  //                                  'allow' = send the original text (unsafe)
  failMode: 'block',
  // true  = show the real values on YOUR screen (highlighted in green)
  // false = show the tags, i.e. exactly what the AI site received (good for demos)
  showRealValues: true,
};
const REQUEST_TIMEOUT_MS = 15_000;

/** Current settings (saved ones, falling back to the defaults). */
async function getSettings() {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...saved };
}

/** Calls the gateway. Always returns { ok, status, data } and never throws. */
async function callGateway(method, path, body) {
  const { gatewayUrl } = await getSettings();
  try {
    const response = await fetch(gatewayUrl.replace(/\/+$/, '') + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: `Gateway unreachable at ${gatewayUrl}` } };
  }
}

/** Adds to the counters shown in the popup. */
async function count(field, amount) {
  if (!amount) return;
  const { stats = { protected: 0, blocked: 0, bypassAttempts: 0 } } = await chrome.storage.local.get('stats');
  stats[field] = (stats[field] || 0) + amount;
  await chrome.storage.local.set({ stats });
}

/** Handles one message from content.js or popup.js. */
async function handle(message) {
  switch (message.type) {
    case 'settings':
      return getSettings();

    case 'mask': {
      const result = await callGateway('POST', '/mask', {
        sessionId: message.sessionId,
        text: message.text,
        source: message.source,
      });
      if (result.ok) {
        await count('protected', result.data.items?.length ?? 0);
        await count('bypassAttempts', result.data.bypassAttempts ?? 0);
      } else if (result.status === 403) {
        await count('blocked', 1);
      }
      return result;
    }

    case 'unmask':
      return callGateway('POST', '/unmask', { sessionId: message.sessionId, text: message.text });

    case 'health':
      return callGateway('GET', '/health');

    default:
      return { ok: false, status: 400, data: { error: `Unknown message type: ${message.type}` } };
  }
}

// Listen for messages. "return true" tells Chrome we'll answer asynchronously.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message).then(sendResponse, (error) => sendResponse({ ok: false, status: 0, data: { error: error.message } }));
  return true;
});
