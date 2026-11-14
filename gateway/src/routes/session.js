// =============================================================================
// routes/session.js: DELETE /session/:sessionId
// =============================================================================
//
// Deletes everything stored for a chat session right away, instead of waiting
// 24 hours for it to expire. (The "Clear" button in the extension/playground.)
//
// Response 200:  { "deleted": 3 }   ← how many hidden values were deleted
// =============================================================================

import express from 'express';
import { badRequest } from '../http-helpers.js';
import { isValidSessionId } from '../vault.js';

export function sessionRoute(vault) {
  const router = express.Router();

  router.delete('/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    if (!isValidSessionId(sessionId)) return badRequest(res, 'Invalid sessionId');

    const deleted = await vault.forgetSession(sessionId);
    res.json({ deleted });
  });

  return router;
}
