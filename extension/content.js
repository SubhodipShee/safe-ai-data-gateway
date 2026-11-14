// =============================================================================
// content.js: runs INSIDE chatgpt.com / claude.ai / gemini.google.com
// =============================================================================
//
// 1. BEFORE SENDING (you press Enter or click Send):
//      stop the send → ask the gateway to /mask the text → put the masked text in
//      the editor → check it really changed → THEN send it.
//      Blocked text (private keys, company code…) is never sent.
//
// 2. AFTER THE REPLY ARRIVES:
//      find [[EMAIL_1]]-style tags on the page → ask the gateway to /unmask them →
//      show the real values. (Only on YOUR screen: the AI site only has the tags.)
//
// IF A SITE CHANGES ITS LAYOUT, only the SITES list below needs updating.
// =============================================================================

(() => {
  // ---------------------------------------------------------------------------
  // SITE SETTINGS: the only part that depends on each website's HTML
  // ---------------------------------------------------------------------------
  //   editor         where you type
  //   sendButton     the Send button
  //   conversationId the chat's ID from the URL (so one chat keeps the same tags)
  const SITES = [
    {
      name: 'ChatGPT',
      hosts: ['chatgpt.com', 'chat.openai.com'],
      source: 'chatgpt.com',
      editor: '#prompt-textarea, div.ProseMirror[contenteditable="true"], form textarea',
      sendButton: 'button[data-testid="send-button"], #composer-submit-button',
      conversationId: () => location.pathname.match(/\/c\/([\w-]+)/)?.[1] ?? null,
    },
    {
      name: 'Claude',
      hosts: ['claude.ai'],
      source: 'claude.ai',
      editor: 'div.ProseMirror[contenteditable="true"]',
      sendButton: 'button[aria-label="Send message"], button[aria-label*="Send" i]',
      conversationId: () => location.pathname.match(/\/chat\/([\w-]+)/)?.[1] ?? null,
    },
    {
      name: 'Gemini',
      hosts: ['gemini.google.com'],
      source: 'gemini.google.com',
      editor: 'rich-textarea .ql-editor, div.ql-editor[contenteditable="true"]',
      sendButton: 'button[aria-label*="Send" i]',
      conversationId: () => location.pathname.match(/\/app\/([\w-]+)/)?.[1] ?? null,
    },
    {
      // The gateway's own demo chat page (gateway/public/chat-demo.html): a backup demo.
      name: 'Demo chat',
      hosts: ['127.0.0.1', 'localhost'],
      source: 'chat-demo',
      editor: '#composer',
      sendButton: '#send',
      conversationId: () => null,
    },
  ];

  const site = SITES.find((s) => s.hosts.includes(location.hostname));
  if (!site) return;

  const TAG_PATTERN = /\[\[[A-Z_]+_\d+\]\]/g;
  const SEPARATOR = '\n<<SAFE-AI-SEP>>\n'; // splits several tags in one /unmask call

  // Diagnostic lines in the browser console (F12 → Console). Types and counts only,
  // NEVER the sensitive values.
  const log = (...parts) => console.info('%c[Safe AI]', 'color:#1f6feb;font-weight:bold', ...parts);

  // Shows which version is running, so you can check that a reload worked.
  log(`v${chrome.runtime.getManifest().version} active on ${location.hostname} (one session per tab)`);

  // ---------------------------------------------------------------------------
  // Talking to background.js (which talks to the gateway)
  // ---------------------------------------------------------------------------
  // When the extension is reloaded/updated, copies of this script that are still running
  // in already-open tabs are cut off from it: every call fails with "Extension context
  // invalidated". Instead of throwing errors, tell the user to reload the page, and never
  // send anything from such an orphaned copy.
  let extensionReloaded = false;

  async function ask(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (String(error?.message).includes('context invalidated')) {
        extensionReloaded = true;
        toast('🔄 Safe AI Gateway was updated: please reload this page (F5) before sending.', 'warn', 0);
      }
      return { ok: false, status: 0, data: { error: 'Extension was updated: reload this page' } };
    }
  }

  let settings = { enabled: true, failMode: 'block', showRealValues: true };
  ask({ type: 'settings' }).then((s) => { settings = s; });
  // When a setting changes in the popup (e.g. "Show real values"), update the page right away.
  chrome.storage.onChanged.addListener(() => ask({ type: 'settings' }).then((s) => {
    settings = s;
    restoreTags();
  }));

  // ---------------------------------------------------------------------------
  // SESSIONS: one chat = one session, so [[EMAIL_1]] always means the same email
  // ---------------------------------------------------------------------------
  // RULE: one session per browser TAB.
  //   - Every message in this tab uses the tab's session, however often the site
  //     changes the chat ID in the URL. (ChatGPT can change it more than once while
  //     creating a new chat; giving each ID its own session was a real bug.)
  //   - We also save "chat ID → session", so after a page reload an OLD chat finds
  //     its session again and its tags can still be restored.
  //   - Sharing one session across chats is harmless: the same value simply keeps
  //     the same tag. Two DIFFERENT sessions for one chat is what breaks restoring.
  let tabSession = null;
  // One lookup per chat ID: if two parts of this script ask at the same moment,
  // both wait for the SAME answer instead of racing.
  const sessionLookups = new Map(); // chat ID → Promise<sessionId>

  const randomId = () => crypto.randomUUID();

  function getSessionId() {
    const conversationId = site.conversationId();

    if (!conversationId) {
      tabSession ??= randomId(); // a brand-new chat with no ID yet
      return Promise.resolve(tabSession);
    }
    if (!sessionLookups.has(conversationId)) {
      sessionLookups.set(conversationId, linkChatToSession(conversationId));
    }
    return sessionLookups.get(conversationId);
  }

  /** Finds the session saved for this chat ID, or links the chat ID to the tab's session. */
  async function linkChatToSession(conversationId) {
    const key = `session:${site.source}:${conversationId}`;
    let stored;
    try {
      stored = (await chrome.storage.local.get(key))[key];
    } catch {
      // Extension was reloaded (storage unavailable to this old copy): keep the tab's session.
      tabSession ??= randomId();
      return tabSession;
    }
    if (stored) {
      tabSession = stored; // an older chat: continue with ITS session
      log(`chat ${conversationId.slice(0, 8)}… uses its saved session ${stored.slice(0, 8)}…`);
      return stored;
    }
    tabSession ??= randomId();
    const sessionId = tabSession;
    await chrome.storage.local.set({ [key]: sessionId }).catch(() => {});
    log(`chat ${conversationId.slice(0, 8)}… linked to session ${sessionId.slice(0, 8)}…`);
    return sessionId;
  }

  /**
   * After the FIRST message of a new chat, the site gives the chat an ID in the URL
   * a moment later. Watch for it (up to 20 s) and link it to the session right away,
   * so every later message in this chat uses the SAME session (and the same tags).
   */
  function linkNewChatWhenItGetsAnId() {
    if (site.conversationId()) return; // already an existing chat
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (site.conversationId()) {
        clearInterval(timer);
        getSessionId(); // stores "chat ID → session"
      } else if (tries > 66) {
        clearInterval(timer);
      }
    }, 300);
  }

  // ---------------------------------------------------------------------------
  // Small on-page messages ("🛡 3 items protected"), in a Shadow DOM so the site's
  // own CSS can't change how they look
  // ---------------------------------------------------------------------------
  const toastHost = document.createElement('div');
  toastHost.setAttribute('data-safeai-skip', '');
  const shadow = toastHost.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; max-width: 360px;
        padding: 10px 14px; border-radius: 10px; font: 14px/1.4 system-ui, sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,.25); color: #fff; background: #1f6feb; transition: opacity .3s; }
      .toast.bad { background: #b42318; } .toast.warn { background: #b54708; } .toast.hidden { opacity: 0; pointer-events: none; }
    </style>
    <div class="toast hidden" role="status"></div>`;
  document.documentElement.append(toastHost);
  const toastBox = shadow.querySelector('.toast');
  let toastTimer;

  function toast(message, kind = 'ok', ms = 3500) {
    toastBox.textContent = message;
    toastBox.className = `toast ${kind === 'ok' ? '' : kind}`;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => toastBox.classList.add('hidden'), ms);
  }

  // ---------------------------------------------------------------------------
  // Reading and writing the editor
  // ---------------------------------------------------------------------------
  const isTextarea = (el) => el instanceof HTMLTextAreaElement;

  function readEditor(editor) {
    return isTextarea(editor) ? editor.value : editor.innerText;
  }

  /** Compares texts while ignoring differences in spaces and line breaks. */
  const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

  /** Replaces everything in the editor with `text`. Returns true only if it really worked. */
  async function writeEditor(editor, text) {
    editor.focus();

    if (isTextarea(editor)) {
      // React ignores plain `.value = …`, so use the browser's own setter and fire "input".
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Rich editors (ProseMirror, Quill) understand a PASTE: select all, then paste.
      const selection = getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.addRange(range);

      const data = new DataTransfer();
      data.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      // If the editor ignored the paste, try "insertText" instead.
      if (!sameText(readEditor(editor), text)) {
        selection.removeAllRanges();
        range.selectNodeContents(editor);
        selection.addRange(range);
        document.execCommand('insertText', false, text);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    // SAFETY CHECK: only report success if the editor now holds exactly the masked text.
    return sameText(readEditor(editor), text);
  }

  // ---------------------------------------------------------------------------
  // Intercepting the send
  // ---------------------------------------------------------------------------
  let letNextSendThrough = false; // true while WE trigger the send after masking
  let busy = false;

  function findEditor(fromElement) {
    return fromElement?.closest?.(site.editor) ?? document.querySelector(site.editor);
  }

  async function clickSendWhenReady(editor) {
    // The site enables its Send button a moment after the text changes, so wait for it.
    for (let i = 0; i < 30; i++) {
      const button = document.querySelector(site.sendButton);
      if (button && !button.disabled) {
        letNextSendThrough = true;
        button.click();
        setTimeout(() => { letNextSendThrough = false; }, 500);
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // No button found: press Enter in the editor instead.
    letNextSendThrough = true;
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    setTimeout(() => { letNextSendThrough = false; }, 500);
    return true;
  }

  /** The heart of the extension: check the text, mask it, then send it. */
  async function protectAndSend(editor) {
    if (busy) return;
    busy = true;
    try {
      const text = readEditor(editor);
      if (!text.trim()) return clickSendWhenReady(editor);

      toast('🛡 Checking for sensitive data…', 'ok', 0);
      const sessionId = await getSessionId();
      const result = await ask({ type: 'mask', sessionId, text, source: site.source });

      // ---- This copy of the extension is outdated (extension reloaded while the tab was open) ----
      if (extensionReloaded) {
        return toast('🔄 Safe AI Gateway was updated: reload this page (F5). Nothing was sent.', 'warn', 0);
      }

      // ---- Gateway down ----
      if (result.status === 0) {
        if (settings.failMode === 'allow') {
          toast('⚠ Gateway unreachable: sent WITHOUT protection', 'warn');
          return clickSendWhenReady(editor);
        }
        return toast('⛔ Gateway unreachable: message NOT sent (your text is still in the box)', 'bad', 6000);
      }

      // ---- Blocked by policy ----
      if (result.status === 403) {
        const types = Object.keys(result.data.blockedTypes ?? {}).join(', ');
        const codeFile = (result.data.blockedItems ?? []).find((i) => i.type === 'PRIVATE_CODE')?.label;
        return toast(`⛔ Not sent: contains ${types}${codeFile ? ` (company code: ${codeFile})` : ''}`, 'bad', 8000);
      }

      if (!result.ok) return toast(`⛔ Not sent: ${result.data.error ?? 'gateway error'}`, 'bad', 6000);

      // ---- Mask and send ----
      const { maskedText, items, bypassAttempts } = result.data;
      if (items.length > 0) {
        const replaced = await writeEditor(editor, maskedText);
        if (!replaced) {
          // Never send if we couldn't be SURE the real data was removed.
          return toast('⛔ Could not safely replace the text: message NOT sent', 'bad', 6000);
        }
        const types = [...new Set(items.map((i) => i.type))].join(', ');
        toast(`🛡 ${items.length} item(s) protected (${types}). ${site.name} receives only tags; ` +
          `the real values are shown on YOUR screen only (green)${bypassAttempts ? ` · ⚠ ${bypassAttempts} bypass attempt(s)` : ''}`, 'ok', 6000);
        log(`masked ${items.length} item(s) [${types}] in session ${sessionId.slice(0, 8)}…`);
      } else {
        toast('🛡 Nothing sensitive found', 'ok', 1500);
        log('nothing sensitive found');
      }
      await clickSendWhenReady(editor);
      linkNewChatWhenItGetsAnId();
    } finally {
      busy = false;
    }
  }

  // "capture: true" on window = our listener runs BEFORE the site's own handlers,
  // so we can stop the send before the site sees it.
  window.addEventListener('keydown', (event) => {
    if (!settings.enabled || letNextSendThrough) return;
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const editor = event.target?.closest?.(site.editor);
    if (!editor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    protectAndSend(editor);
  }, true);

  window.addEventListener('click', (event) => {
    if (!settings.enabled || letNextSendThrough) return;
    if (!event.target?.closest?.(site.sendButton)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const editor = findEditor(null);
    if (editor) protectAndSend(editor);
  }, true);

  // ---------------------------------------------------------------------------
  // Restoring tags in replies (and in your own sent messages)
  // ---------------------------------------------------------------------------
  const knownValues = new Map(); //   "sessionId|[[EMAIL_1]]" → "rahul@abc.com"
  // Tags the gateway couldn't restore (expired / another chat), with WHEN we asked.
  // We don't ask again for 10 s, but then we retry: remembering "unknown" forever
  // meant a tag asked about a moment too early was never restored (a real bug).
  const unknownTags = new Map(); //   "sessionId|[[EMAIL_9]]" → time of the last attempt
  const UNKNOWN_RETRY_MS = 10_000;
  let restoreTimer;

  /**
   * All text pieces of the page, in order (skipping editors, our own toast and
   * [data-safeai-skip] areas). Tags may be split across them; see tag-restore.js.
   */
  function pageTextPieces() {
    const pieces = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || parent.closest('[contenteditable="true"], textarea, script, style, [data-safeai-skip]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) pieces.push(walker.currentNode);
    return pieces;
  }

  // ---- Green highlight on restored values ----
  // Uses the browser's "CSS Custom Highlight API": it colours text WITHOUT changing the
  // page's HTML at all, so the site can't be disturbed by it.
  const restoredHighlight = globalThis.CSS?.highlights ? new Highlight() : null;
  if (restoredHighlight) {
    CSS.highlights.set('safe-ai-restored', restoredHighlight);
    const style = document.createElement('style');
    style.textContent = '::highlight(safe-ai-restored) { background-color: rgba(46, 160, 67, 0.28); }';
    document.head.append(style);
  }

  /** The tag → value pairs known for one session, e.g. [['[[EMAIL_1]]', 'rahul@gmail.com']]. */
  function knownPairs(sessionId) {
    const prefix = `${sessionId}|`;
    return [...knownValues]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]);
  }

  /** Paints every restored value on the page green. */
  function highlightRestoredValues(pieces, pairs) {
    if (!restoredHighlight) return;
    restoredHighlight.clear();
    for (const piece of pieces) {
      for (const [, value] of pairs) {
        let at = piece.nodeValue.indexOf(value);
        while (at !== -1) {
          const range = new Range();
          range.setStart(piece, at);
          range.setEnd(piece, at + value.length);
          restoredHighlight.add(range);
          at = piece.nodeValue.indexOf(value, at + value.length);
        }
      }
    }
  }

  /** "Show real values" switched OFF: turn restored values back into tags (what the AI saw). */
  function showTagsAgain(pieces, pairs) {
    // Longest values first, so "Rahul Verma" is handled before a shorter value inside it.
    const longestFirst = [...pairs].sort((a, b) => b[1].length - a[1].length);
    for (const piece of pieces) {
      let text = piece.nodeValue;
      for (const [tag, value] of longestFirst) text = text.split(value).join(tag);
      if (text !== piece.nodeValue) piece.nodeValue = text;
    }
    restoredHighlight?.clear();
  }

  async function restoreTags() {
    if (!settings.enabled) return;
    const sessionId = await getSessionId();
    const pieces = pageTextPieces();

    // Demo mode: show exactly what the AI received.
    if (settings.showRealValues === false) {
      showTagsAgain(pieces, knownPairs(sessionId));
      return;
    }

    const tags = SafeAiTagRestore.findTags(pieces);
    if (tags.length === 0) {
      highlightRestoredValues(pieces, knownPairs(sessionId)); // keep the green marks up to date
      return;
    }
    const recentlyUnknown = (tag) => Date.now() - (unknownTags.get(`${sessionId}|${tag}`) ?? 0) < UNKNOWN_RETRY_MS;
    const missing = tags.filter((tag) => !knownValues.has(`${sessionId}|${tag}`) && !recentlyUnknown(tag));

    // Ask the gateway for all missing tags in ONE call, separated by SEPARATOR.
    if (missing.length > 0) {
      const result = await ask({ type: 'unmask', sessionId, text: missing.join(SEPARATOR) });
      if (result.ok) {
        const values = result.data.text.split(SEPARATOR);
        missing.forEach((tag, i) => {
          if (values[i] !== undefined && values[i] !== tag) knownValues.set(`${sessionId}|${tag}`, values[i]);
          else unknownTags.set(`${sessionId}|${tag}`, Date.now());
        });
      }
    }

    // Put the values back, even into tags split across several text pieces.
    // Only the TEXT changes, never the page structure, so the site's own code isn't confused.
    const replacedTags = SafeAiTagRestore.restore(pieces, (tag) => knownValues.get(`${sessionId}|${tag}`));
    highlightRestoredValues(pieces, knownPairs(sessionId));
    if (replacedTags > 0 || missing.length > 0) {
      log(`restored ${replacedTags} tag(s) on screen (session ${sessionId.slice(0, 8)}…, ${unknownTags.size} unknown)`);
    }
  }

  // Replies arrive word by word, so we wait for a short pause (300 ms) before restoring.
  // BUT busy pages (like ChatGPT) change something almost constantly and may never
  // pause, so we also restore at least once every second ("max wait").
  let firstChangeAt = 0;
  new MutationObserver(() => {
    const now = Date.now();
    if (!firstChangeAt) firstChangeAt = now;
    clearTimeout(restoreTimer);
    const run = () => { firstChangeAt = 0; restoreTags(); };
    if (now - firstChangeAt >= 1000) run();
    else restoreTimer = setTimeout(run, 300);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  restoreTags();
})();
