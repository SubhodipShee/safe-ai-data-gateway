// =============================================================================
// popup.js: the extension popup (on/off, gateway address, status, counters)
// =============================================================================

const $ = (id) => document.getElementById(id);
const ask = (message) => chrome.runtime.sendMessage(message);

/** Shows whether the gateway answers, and what it has switched on. */
async function showStatus() {
  const status = $('status');
  status.textContent = 'Checking…';
  status.className = 'status';
  const { ok, data } = await ask({ type: 'health' });
  if (ok) {
    const ai = data.ai ? `AI: ${data.ai.provider}` : 'AI proxy off';
    status.textContent = `✔ Connected · names: ${data.nameDetection} · ${ai}`;
    status.className = 'status ok';
  } else {
    status.textContent = `✘ ${data.error || `Gateway problem (database: ${data.db ?? 'unknown'})`}`;
    // The free online server sleeps when nobody uses it; opening this popup wakes it.
    if ($('gateway-url').value.includes('onrender.com')) status.textContent += ' · probably waking up, reopen in about a minute';
    status.className = 'status bad';
  }
}

async function load() {
  const settings = await ask({ type: 'settings' });
  $('enabled').checked = settings.enabled;
  $('show-real-values').checked = settings.showRealValues;
  $('gateway-url').value = settings.gatewayUrl;
  $('fail-mode').value = settings.failMode;

  const { stats = {} } = await chrome.storage.local.get('stats');
  $('stat-protected').textContent = stats.protected ?? 0;
  $('stat-blocked').textContent = stats.blocked ?? 0;
  $('stat-bypass').textContent = stats.bypassAttempts ?? 0;

  showStatus();
}

$('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));
$('show-real-values').addEventListener('change', (e) => chrome.storage.local.set({ showRealValues: e.target.checked }));
$('fail-mode').addEventListener('change', (e) => chrome.storage.local.set({ failMode: e.target.value }));

$('save-url').addEventListener('click', async () => {
  const url = $('gateway-url').value.trim().replace(/\/+$/, '');
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    $('status').textContent = '✘ That is not a valid address';
    $('status').className = 'status bad';
    return;
  }
  // Addresses outside the built-in list (localhost, *.onrender.com, *.trycloudflare.com)
  // need the user's permission once.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] }).catch(() => false);
  const builtIn = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$|\.onrender\.com$|\.trycloudflare\.com$/.test(origin);
  if (!granted && !builtIn) {
    $('status').textContent = '✘ Permission for that address was not given';
    $('status').className = 'status bad';
    return;
  }
  await chrome.storage.local.set({ gatewayUrl: url });
  showStatus();
});

async function openGatewayPage(path) {
  const { gatewayUrl } = await ask({ type: 'settings' });
  chrome.tabs.create({ url: gatewayUrl.replace(/\/+$/, '') + path });
}
$('open-playground').addEventListener('click', () => openGatewayPage('/'));
$('open-demo').addEventListener('click', () => openGatewayPage('/chat-demo.html'));

load();
