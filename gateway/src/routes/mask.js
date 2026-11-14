// =============================================================================
// routes/mask.js: POST /mask
// =============================================================================
//
// Request:
//   { "sessionId": "3f9a1c2e-…", "text": "Email rahul@abc.com", "source": "chatgpt.com" }
//
// Response 200 (masked):
//   { "blocked": false,
//     "maskedText": "Email [[EMAIL_1]]",
//     "items": [ { "type": "EMAIL", "placeholder": "[[EMAIL_1]]" } ],
//     "summary": { "EMAIL": 1 } }
//
// Response 403 (a "block" policy matched, so nothing may be sent):
//   { "blocked": true, "blockedTypes": { "PRIVATE_KEY": 1 }, "error": "…" }
// =============================================================================

import express from 'express';
import { badRequest, checkSessionAndText } from '../http-helpers.js';

const MAX_SOURCE_LENGTH = 200;

export function maskRoute(masker) {
  const router = express.Router();

  router.post('/mask', async (req, res) => {
    // ---- Check the request ----
    const problem = checkSessionAndText(req.body);
    if (problem) return badRequest(res, problem);

    const { sessionId, text, source } = req.body;
    if (source !== undefined && (typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH)) {
      return badRequest(res, `source must be a string of at most ${MAX_SOURCE_LENGTH} characters`);
    }

    // ---- Mask it ----
    const result = await masker.maskText({ sessionId, text, source });

    if (result.blocked) {
      // 403 Forbidden: the company policy doesn't allow this text to be sent at all.
      return res.status(403).json({
        ...result,
        error: 'Blocked by policy: this text contains data that must never be sent to an AI.',
      });
    }
    res.json(result);
  });

  return router;
}
