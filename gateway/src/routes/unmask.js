// =============================================================================
// routes/unmask.js: POST /unmask
// =============================================================================
//
// Request:
//   { "sessionId": "3f9a1c2e-…", "text": "Sure, I'll write to [[EMAIL_1]]." }
//
// Response 200:
//   { "text": "Sure, I'll write to rahul@abc.com.",
//     "restored": 1,
//     "unknown": [] }       ← tags that couldn't be restored (expired / other session / made up)
// =============================================================================

import express from 'express';
import { badRequest, checkSessionAndText } from '../http-helpers.js';

export function unmaskRoute(masker) {
  const router = express.Router();

  router.post('/unmask', async (req, res) => {
    const problem = checkSessionAndText(req.body);
    if (problem) return badRequest(res, problem);

    const { sessionId, text } = req.body;
    const result = await masker.unmaskText({ sessionId, text });
    res.json(result);
  });

  return router;
}
