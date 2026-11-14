// =============================================================================
// dashboard.js: draws the dashboard from the gateway's API (counts only, never data)
// =============================================================================
//
//   GET /api/reports/dpdp   totals, per day, per category, per AI provider, audit status
//   GET /api/audit/verify   re-check the hash chain
//   GET /api/policies       mask / block / allow per type (PUT to change)
//   GET /api/audit/recent   the newest audit entries
//
// Charts are plain SVG built here: no chart library, nothing to download.
// =============================================================================

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const NUMBER = new Intl.NumberFormat('en-IN');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
// ---- Admin key (Phase 10) ----
// Online, changing a policy needs the admin key. It's kept only in THIS browser tab
// (sessionStorage: gone when the tab closes) and sent as "Authorization: Bearer <key>".
const ADMIN_KEY_STORAGE = 'safe-ai-admin-key';
function storedAdminKey() {
  try { return sessionStorage.getItem(ADMIN_KEY_STORAGE) || ''; } catch { return ''; }
}
function storeAdminKey(key) {
  try {
    if (key) sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
    else sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch { /* storage blocked (private window): the key just isn't remembered */ }
}

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const adminKey = storedAdminKey();
  if (method !== 'GET' && adminKey) headers.Authorization = `Bearer ${adminKey}`;
  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/** Creates an HTML element with optional class and text (text is always safe). */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Creates an SVG element with attributes. */
function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/** A table from a header row and data rows. `numeric` = column indexes to right-align. */
function table(headers, rows, numeric = []) {
  const wrap = el('div', 'table-scroll');
  const t = el('table');
  const head = el('tr');
  headers.forEach((h, i) => head.append(el('th', numeric.includes(i) ? 'num' : '', h)));
  t.append(head);
  for (const row of rows) {
    const tr = el('tr');
    row.forEach((cell, i) => {
      const td = el('td', numeric.includes(i) ? 'num' : '');
      if (cell instanceof Node) td.append(cell);
      else td.textContent = cell;
      tr.append(td);
    });
    t.append(tr);
  }
  wrap.append(t);
  return wrap;
}

/** A "nice" axis maximum: 1, 2, 5, 10, 20, 50… at or above the value. */
function niceMax(value) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}

/** A rectangle with only its TOP corners rounded (bars are anchored to the baseline). */
function roundedTopBar(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height} V${y + r} Q${x},${y} ${x + r},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height} Z`;
}

/** A rectangle with only its RIGHT corners rounded (horizontal bars start at the axis). */
function roundedRightBar(x, y, width, height, radius) {
  const r = Math.min(radius, height / 2, width);
  return `M${x},${y} H${x + width - r} Q${x + width},${y} ${x + width},${y + r} V${y + height - r} Q${x + width},${y + height} ${x + width - r},${y + height} H${x} Z`;
}

const dayLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// ---------------------------------------------------------------------------
// Tooltip (one for the whole page)
// ---------------------------------------------------------------------------
const tooltip = $('tooltip');

function showTooltip(event, title, rows) {
  tooltip.replaceChildren(el('strong', '', title));
  for (const [swatchClass, label, value] of rows) {
    const row = el('div', 'row');
    const name = el('span');
    if (swatchClass) name.append(el('span', `swatch ${swatchClass}`));
    name.append(label);
    row.append(name, el('span', '', value));
    tooltip.append(row);
  }
  tooltip.hidden = false;
  // Keep it on screen.
  const { innerWidth } = window;
  const left = Math.min(event.clientX + 14, innerWidth - tooltip.offsetWidth - 8);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
}
const hideTooltip = () => { tooltip.hidden = true; };

// ---------------------------------------------------------------------------
// Chart 1: items stopped per day (stacked bars: masked + blocked)
// ---------------------------------------------------------------------------
function drawDailyChart(days) {
  const box = $('daily-chart');
  const total = days.reduce((sum, d) => sum + d.masked + d.blocked, 0);
  if (total === 0) {
    box.replaceChildren(el('p', 'empty', 'Nothing caught in this period yet.'));
    $('daily-table').replaceChildren();
    return;
  }

  const W = 1000; const H = 260;
  const M = { top: 12, right: 8, bottom: 26, left: 40 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const max = niceMax(Math.max(...days.map((d) => d.masked + d.blocked)));
  const y = (value) => M.top + plotH - (value / max) * plotH;
  const column = plotW / days.length;
  const barW = Math.min(column * 0.62, 26);
  const GAP = 2; // surface gap between the stacked segments

  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Items stopped per day: ${total} in total` });

  // Recessive grid + y-axis ticks (4 steps)
  const grid = svg('g', { class: 'grid' });
  for (let i = 1; i <= 4; i++) {
    const value = (max / 4) * i;
    grid.append(svg('line', { x1: M.left, x2: W - M.right, y1: y(value), y2: y(value) }));
    const tick = svg('text', { class: 'tick', x: M.left - 6, y: y(value) + 4, 'text-anchor': 'end' });
    tick.textContent = NUMBER.format(value);
    chart.append(tick);
  }
  chart.prepend(grid);

  // About 6 date labels along the bottom
  const every = Math.max(1, Math.ceil(days.length / 6));
  days.forEach((d, i) => {
    if (i % every !== 0 && i !== days.length - 1) return;
    const label = svg('text', { class: 'tick', x: M.left + column * i + column / 2, y: H - 6, 'text-anchor': 'middle' });
    label.textContent = dayLabel(d.date);
    chart.append(label);
  });

  // Bars: masked at the bottom, blocked on top; only the TOP segment gets rounded corners
  days.forEach((d, i) => {
    const x = M.left + column * i + (column - barW) / 2;
    const wash = svg('rect', { class: 'hover-wash', x: M.left + column * i, y: M.top, width: column, height: plotH });
    chart.append(wash);

    const maskedTop = y(d.masked);
    if (d.masked > 0) {
      const h = M.top + plotH - maskedTop;
      chart.append(svg('path', { class: 'masked', d: d.blocked > 0 ? `M${x},${maskedTop}h${barW}v${h}h${-barW}Z` : roundedTopBar(x, maskedTop, barW, h, 4) }));
    }
    if (d.blocked > 0) {
      const bottom = (d.masked > 0 ? maskedTop - GAP : M.top + plotH);
      const top = y(d.masked + d.blocked) - (d.masked > 0 ? GAP : 0);
      chart.append(svg('path', { class: 'blocked', d: roundedTopBar(x, top, barW, Math.max(bottom - top, 1), 4) }));
    }

    // Invisible hit area: the whole column, bigger than the bar, for an easy hover
    const hit = svg('rect', { class: 'hit', x: M.left + column * i, y: M.top, width: column, height: plotH });
    hit.addEventListener('mousemove', (event) => {
      wash.classList.add('on');
      showTooltip(event, dayLabel(d.date), [['masked', 'Masked', NUMBER.format(d.masked)], ['blocked', 'Blocked', NUMBER.format(d.blocked)]]);
    });
    hit.addEventListener('mouseleave', () => { wash.classList.remove('on'); hideTooltip(); });
    chart.append(hit);
  });

  chart.append(svg('line', { class: 'baseline', x1: M.left, x2: W - M.right, y1: M.top + plotH, y2: M.top + plotH }));
  box.replaceChildren(chart);

  // Table view (accessibility): only days with activity
  const active = days.filter((d) => d.masked + d.blocked > 0);
  $('daily-table').replaceChildren(table(['Date', 'Masked', 'Blocked'], active.map((d) => [dayLabel(d.date), NUMBER.format(d.masked), NUMBER.format(d.blocked)]), [1, 2]));
}

// ---------------------------------------------------------------------------
// Chart 2: by kind of data (one series → no legend; value labels at bar ends)
// ---------------------------------------------------------------------------
function drawCategoryChart(categories) {
  const box = $('category-chart');
  if (categories.length === 0) {
    box.replaceChildren(el('p', 'empty', 'Nothing caught in this period yet.'));
    return;
  }
  const rows = [...categories].sort((a, b) => (b.masked + b.blocked) - (a.masked + a.blocked));
  const W = 520; const ROW = 34; const LABEL_W = 170; const VALUE_W = 48;
  const H = rows.length * ROW + 4;
  const max = Math.max(...rows.map((c) => c.masked + c.blocked));
  const barMax = W - LABEL_W - VALUE_W;

  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Items stopped by kind of data' });
  rows.forEach((c, i) => {
    const total = c.masked + c.blocked;
    const yTop = i * ROW + 8;
    const width = Math.max((total / max) * barMax, 2);

    const label = svg('text', { class: 'label', x: 0, y: yTop + 12 });
    label.textContent = c.category;
    const bar = svg('path', { class: 'masked', d: roundedRightBar(LABEL_W, yTop, width, 16, 4) });
    const value = svg('text', { class: 'value', x: LABEL_W + width + 6, y: yTop + 12 });
    value.textContent = NUMBER.format(total);
    const hit = svg('rect', { class: 'hit', x: 0, y: yTop - 8, width: W, height: ROW });
    hit.addEventListener('mousemove', (event) => showTooltip(event, c.category, [
      ['masked', 'Masked', NUMBER.format(c.masked)],
      ['blocked', 'Blocked', NUMBER.format(c.blocked)],
      ...Object.entries(c.types).map(([type, n]) => ['', `  ${type}`, NUMBER.format(n.masked + n.blocked)]),
    ]));
    hit.addEventListener('mouseleave', hideTooltip);
    chart.append(label, bar, value, hit);
  });
  box.replaceChildren(chart);
}

// ---------------------------------------------------------------------------
// Loading everything for the chosen period
// ---------------------------------------------------------------------------
function periodDates() {
  const days = Number($('period').value);
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { days, from: iso(from), to: iso(to) };
}

/** Every day in the period, including days with nothing caught (shown as zero). */
function fillDays(daily, from, count) {
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const start = new Date(`${from}T00:00:00Z`).getTime();
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    return byDate.get(date) ?? { date, masked: 0, blocked: 0 };
  });
}

async function loadReport() {
  const { days, from, to } = periodDates();
  const report = await api('GET', `/api/reports/dpdp?from=${from}&to=${to}`);

  $('kpi-masked').textContent = NUMBER.format(report.totals.itemsMasked);
  $('kpi-blocked').textContent = NUMBER.format(report.totals.itemsBlocked);
  $('kpi-bypass').textContent = NUMBER.format(report.totals.bypassAttempts);

  // Status = icon + label, never colour alone
  const intact = report.auditLogIntegrity.valid;
  const audit = $('kpi-audit');
  audit.textContent = intact ? '✔ Intact' : '✘ Tampered';
  audit.className = `tile-value status ${intact ? 'good' : 'critical'}`;
  $('kpi-audit-note').textContent = `${NUMBER.format(report.auditLogIntegrity.entriesChecked)} entries checked`;

  drawDailyChart(fillDays(report.daily, from, days));
  drawCategoryChart(report.byCategory);

  $('provider-table').replaceChildren(report.byDestination.length
    ? table(['AI provider', 'Source', 'Masked', 'Blocked'],
      report.byDestination.map((d) => [d.aiProvider, d.source, NUMBER.format(d.masked), NUMBER.format(d.blocked)]), [2, 3])
    : el('p', 'empty', 'Nothing yet.'));

  $('updated').textContent = `Updated ${new Date().toLocaleTimeString('en-IN')}`;
}

async function loadRecent() {
  const entries = await api('GET', '/api/audit/recent?limit=15');
  $('recent').replaceChildren(entries.length
    ? table(['Time', 'Where', 'Type', 'Count', 'Action', 'Bypass'],
      entries.map((e) => [
        new Date(e.ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        e.aiProvider === 'Unknown' ? e.source : e.aiProvider,
        e.type,
        NUMBER.format(e.count),
        el('span', 'pill', e.action),
        e.bypassAttempts ? `⚠ ${e.bypassAttempts}` : '',
      ]), [3])
    : el('p', 'empty', 'No activity yet.'));
}

/** The "🔒 enter admin key" bar above the policies (only when the server requires a key). */
function adminBar(locked) {
  const bar = el('form', 'admin-bar');
  if (locked) {
    const input = el('input');
    input.type = 'password';
    input.placeholder = 'Admin key';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Admin key');
    const unlock = el('button', '', 'Unlock');
    unlock.type = 'submit';
    bar.append(el('span', 'muted small', '🔒 Viewing only. Changing policies needs the admin key.'), input, unlock);
    bar.addEventListener('submit', (event) => {
      event.preventDefault();
      storeAdminKey(input.value.trim());
      loadPolicies().catch(showError);
    });
  } else {
    const lock = el('button', 'ghost', 'Lock');
    lock.type = 'submit';
    bar.append(el('span', 'muted small', '🔓 Unlocked in this tab.'), lock);
    bar.addEventListener('submit', (event) => {
      event.preventDefault();
      storeAdminKey('');
      loadPolicies().catch(showError);
    });
  }
  return bar;
}

async function loadPolicies() {
  const [policies, health] = await Promise.all([
    api('GET', '/api/policies'),
    api('GET', '/health').catch(() => ({})),
  ]);
  const keyRequired = Boolean(health.adminKeyRequired);
  const locked = keyRequired && !storedAdminKey();

  const rows = policies.map((p) => {
    const select = el('select');
    select.disabled = locked;
    select.setAttribute('aria-label', `Policy for ${p.type}`);
    for (const action of ['mask', 'block', 'allow']) {
      const option = el('option', '', action);
      option.value = action;
      option.selected = action === p.action;
      select.append(option);
    }
    const cell = el('span');
    const saved = el('span', 'saved');
    select.addEventListener('change', async () => {
      try {
        await api('PUT', `/api/policies/${p.type}`, { action: select.value });
        saved.textContent = '✔ saved';
      } catch (error) {
        saved.textContent = `✘ ${error.message}`;
        if (error.status === 401) {
          // Wrong key: forget it, lock again and show the real (unchanged) policies.
          storeAdminKey('');
          setTimeout(() => loadPolicies().catch(showError), 1500);
          return;
        }
      }
      setTimeout(() => { saved.textContent = ''; }, 2500);
    });
    cell.append(select, saved);
    const item = el('div', 'policy');
    item.append(el('span', 'policy-type', p.type), cell);
    return item;
  });
  // A compact grid instead of an 18-row table.
  const grid = el('div', 'policy-grid');
  grid.append(...rows);
  $('policies').replaceChildren(...(keyRequired ? [adminBar(locked)] : []), grid);
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
$('verify-btn').addEventListener('click', async () => {
  const box = $('verify-result');
  box.replaceChildren(el('p', 'status-line', 'Checking every entry…'));
  try {
    const result = await api('GET', '/api/audit/verify');
    const parts = [el('p', `status-line ${result.valid ? 'good' : 'critical'}`, result.valid
      ? `✔ Intact: ${NUMBER.format(result.entriesChecked)} entries, every link and the signed head match.`
      : `✘ Tampering detected: ${result.problems.length} problem(s).`)];
    if (!result.valid) {
      const list = el('ul', 'problems');
      for (const p of result.problems) list.append(el('li', '', p.message));
      parts.push(list);
    }
    for (const note of result.notes) parts.push(el('p', 'muted small', note));
    box.replaceChildren(...parts);
  } catch (error) {
    box.replaceChildren(el('p', 'status-line critical', `✘ ${error.message}`));
  }
});

$('report-btn').addEventListener('click', async () => {
  const { from, to } = periodDates();
  const report = await api('GET', `/api/reports/dpdp?from=${from}&to=${to}`);
  const file = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = el('a');
  link.href = URL.createObjectURL(file);
  link.download = `dpdp-report-${from}-to-${to}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

$('period').addEventListener('change', () => loadReport().catch(showError));

function showError(error) {
  $('updated').textContent = `Could not load: ${error.message}`;
}

// First load, then refresh the numbers every 30 seconds.
Promise.all([loadReport(), loadRecent(), loadPolicies()]).catch(showError);
setInterval(() => Promise.all([loadReport(), loadRecent()]).catch(showError), 30_000);
