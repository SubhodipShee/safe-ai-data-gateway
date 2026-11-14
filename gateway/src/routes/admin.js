// =============================================================================
// routes/admin.js: endpoints for the dashboard (Phase 9)
// =============================================================================
//
//   GET /api/policies                → [{ type: 'EMAIL', action: 'mask' }, …]
//   PUT /api/policies/:type          body { "action": "block" }  → change one policy
//   GET /api/audit/recent?limit=20   → the newest audit entries (counts only, never values)
//
// SECURITY (Phase 10): changing a policy needs the admin key when ADMIN_KEY is set;
// app.js checks it before this route runs (see security.js). Reading is public:
// it's only counts and settings, never data.
// =============================================================================

import express from 'express';
import { badRequest } from '../http-helpers.js';
import { ENTITY_TYPES } from '../detectors/index.js';
import { Policy, POLICY_ACTIONS } from '../models/Policy.js';
import { AuditLog } from '../models/AuditLog.js';
import { clearPolicyCache } from '../policies.js';
import { providerForSource } from '../audit/dpdp-report.js';

export function adminRoute() {
  const router = express.Router();

  // ---- All policies, in the same order as ENTITY_TYPES ----
  router.get('/api/policies', async (req, res) => {
    const stored = new Map((await Policy.find().lean()).map((p) => [p._id, p.action]));
    res.json(ENTITY_TYPES.map((type) => ({ type, action: stored.get(type) ?? 'mask' })));
  });

  // ---- Change one policy ----
  router.put('/api/policies/:type', async (req, res) => {
    const { type } = req.params;
    const action = req.body?.action;
    if (!ENTITY_TYPES.includes(type)) return badRequest(res, `Unknown type: ${type}`);
    if (!POLICY_ACTIONS.includes(action)) return badRequest(res, `action must be one of: ${POLICY_ACTIONS.join(', ')}`);

    await Policy.updateOne({ _id: type }, { action }, { upsert: true });
    clearPolicyCache(); // take effect immediately, not after the 30-second cache
    res.json({ type, action });
  });

  // ---- Newest audit entries ----
  router.get('/api/audit/recent', async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const entries = await AuditLog.find()
      .sort({ ts: -1 })
      .limit(limit)
      .select({ ts: 1, source: 1, entityType: 1, count: 1, obfuscatedCount: 1, action: 1, seq: 1 })
      .lean();
    res.json(entries.map((e) => ({
      ts: e.ts,
      seq: e.seq ?? null,
      source: e.source ?? 'unknown',
      aiProvider: providerForSource(e.source ?? ''),
      type: e.entityType,
      count: e.count,
      bypassAttempts: e.obfuscatedCount ?? 0,
      action: e.action,
    })));
  });

  return router;
}
