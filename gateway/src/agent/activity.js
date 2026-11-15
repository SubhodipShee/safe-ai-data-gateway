// =============================================================================
// agent/activity.js: "what was hidden from the AI", for the VS Code pop-up (Phase 16)
// =============================================================================
//
// When Claude Code or Copilot sends sensitive data, the gateway masks it, and the
// VS Code extension shows a pop-up:
//
//   🛡 Safe AI hid PAN from Claude Code.   [Show what the AI saw]
//   The AI saw: "repeat exactly, PAN [[PAN_1]]"
//
// To know what to show, the extension asks GET /agent/activity every few seconds.
// Each install of the extension has its own random ID (header X-Safe-AI-Install,
// not a name or email), so people only see THEIR OWN activity.
//
// The pop-up shows both sides:
//   You typed:   PAN ABCPE1234F     ← rebuilt only when the extension asks, from the
//   Claude saw:  PAN [[PAN_1]]         encrypted vault (like /unmask), for its own install
//
// PRIVACY: kept in MEMORY only (gone after a restart), the last 10 events per install,
// for 30 minutes. It holds types, counts, the session and the MASKED text (tags only):
// never a real value.
// =============================================================================

const KEEP_MINUTES = 30;
const EVENTS_PER_INSTALL = 10;
const MAX_INSTALLS = 500; //    more than that: forget the oldest install
const PREVIEW_CHARS = 300; //   how much of the message to show
const INSTALL_ID = /^[A-Za-z0-9-]{16,64}$/;
const TAG = /\[\[[A-Z_]+_\d+\]\]/;

/** True for a valid install ID (the extension uses a random UUID). */
export function isInstallId(value) {
  return typeof value === 'string' && INSTALL_ID.test(value);
}

/**
 * The activity list.
 *   const activity = createActivityLog();
 *   activity.record(installId, { tool: 'Claude Code', found: { PAN: 1 }, aiSaw: 'PAN [[PAN_1]]', sessionId });
 *   activity.since(installId, lastTime)  → the newer events
 */
export function createActivityLog({ now = Date.now } = {}) {
  const byInstall = new Map(); // installId → [ events, oldest first ]

  /** Remembers one event, if something was hidden. sessionId = where the vault keeps its values. */
  function record(installId, { tool, found, aiSaw, sessionId }) {
    if (!isInstallId(installId) || Object.keys(found ?? {}).length === 0) return;
    const events = byInstall.get(installId) ?? [];
    events.push({ time: now(), tool, found, aiSaw: aiSaw ?? null, sessionId });

    // Move this install to the end (= most recently used), keep only its newest events.
    byInstall.delete(installId);
    byInstall.set(installId, events.slice(-EVENTS_PER_INSTALL));
    if (byInstall.size > MAX_INSTALLS) byInstall.delete(byInstall.keys().next().value);
  }

  /** The events after `time` (milliseconds), at most 30 minutes old. */
  function since(installId, time) {
    const cutoff = Math.max(Number(time) || 0, now() - KEEP_MINUTES * 60_000);
    return (byInstall.get(installId) ?? []).filter((event) => event.time > cutoff);
  }

  return { record, since };
}

/**
 * The part of the user's LATEST message the AI received, if it contains a tag.
 * Works for both formats (Copilot's OpenAI messages and Claude Code's Anthropic messages).
 * Returns null when the hidden data was elsewhere (a file the tool read, background text).
 */
export function latestUserText(messages) {
  const lastUser = [...(messages ?? [])].reverse().find((message) => message?.role === 'user');
  let text = lastUser?.content;
  if (Array.isArray(text)) {
    // Claude Code adds background notes as separate <system-reminder> blocks: skip those.
    const typed = text.filter((part) => part?.type === 'text' && !part.text?.startsWith('<system-reminder>'));
    text = typed.at(-1)?.text;
  }
  if (typeof text !== 'string' || !TAG.test(text)) return null;

  // A long message: show the part around the first tag.
  if (text.length <= PREVIEW_CHARS) return text;
  const start = Math.max(0, text.search(TAG) - 100);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + PREVIEW_CHARS)}…`;
}
