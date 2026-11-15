// =============================================================================
// routes/activity.js: GET /agent/activity, for the VS Code pop-up (Phase 16)
// =============================================================================
//
// The VS Code extension asks every few seconds: "anything hidden from the AI since <time>?"
//
//   GET /agent/activity?since=1731650000000
//   X-Safe-AI-Key: <AGENT_KEY>          (the same key Claude Code and Copilot use)
//   X-Safe-AI-Install: <random ID>      (this install of the extension)
//
//   → { now: 1731650005000,
//       events: [{ time, tool: "Claude Code", found: { PAN: 1 },
//                  aiSaw: "repeat exactly, PAN [[PAN_1]]",       what the AI received
//                  youTyped: "repeat exactly, PAN ABCPE1234F" }] what you typed
//
// "youTyped" holds real values, so it's rebuilt from the encrypted vault only now,
// only for the install that sent them (like /unmask), and never stored or logged.
// =============================================================================

import express from 'express';
import { requireKey } from '../security.js';
import { requireDatabase } from '../http-helpers.js';
import { isInstallId } from '../agent/activity.js';

/**
 * @param {object} options
 * @param {object} options.activity   from createActivityLog()
 * @param {object} options.masker     from createMasker() (its unmaskText rebuilds "you typed")
 * @param {boolean} options.isPublic  online? Then AGENT_KEY is required
 * @param {string} [options.agentKey] the AGENT_KEY setting
 */
export function activityRoute({ activity, masker, isPublic, agentKey }) {
  const router = express.Router();

  router.get(
    '/agent/activity',
    (req, res, next) => {
      if (isPublic && !agentKey) return res.status(403).json({ error: 'Coding tools are turned off on this server.' });
      next();
    },
    requireKey(agentKey, (req) => req.get('x-safe-ai-key'), { error: 'Missing or wrong X-Safe-AI-Key.' }),
    requireDatabase,
    async (req, res) => {
      const installId = req.get('x-safe-ai-install');
      if (!isInstallId(installId)) return res.status(400).json({ error: 'Missing or invalid X-Safe-AI-Install header.' });

      const now = Date.now();
      const events = await Promise.all(activity.since(installId, req.query.since).map(async ({ sessionId, ...event }) => ({
        ...event,
        youTyped: event.aiSaw ? (await masker.unmaskText({ sessionId, text: event.aiSaw })).text : null,
      })));
      res.set('Cache-Control', 'no-store'); // real values: never keep a copy anywhere on the way
      res.json({ now, events });
    },
  );

  return router;
}
