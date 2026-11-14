// =============================================================================
// routes/audit.js: audit log verification and the DPDP report
// =============================================================================
//
//   GET /api/audit/verify          re-checks the whole hash chain
//     → { valid: true, entriesChecked: 42, problems: [], … }
//
//   GET /api/audit/public-key      the public key that checks the signatures
//     → { algorithm: 'Ed25519', fingerprint: '…', publicKeyPem: '-----BEGIN PUBLIC KEY-----…' }
//
//   GET /api/reports/dpdp?from=2026-11-01&to=2026-11-30
//     → the signed DPDP evidence report (default: the last 30 days)
//
// SECURITY NOTE: these show organisation-wide statistics (counts only, never
// values). Before going online (Phase 10) they'll require an admin access key.
// =============================================================================

import express from 'express';
import { badRequest } from '../http-helpers.js';
import { buildDpdpReport, parseReportPeriod } from '../audit/dpdp-report.js';

export function auditRoute(auditChain) {
  const router = express.Router();

  router.get('/api/audit/verify', async (req, res) => {
    res.json(await auditChain.verify());
  });

  router.get('/api/audit/public-key', (req, res) => {
    res.json({
      algorithm: 'Ed25519',
      fingerprint: auditChain.keyFingerprint,
      publicKeyPem: auditChain.publicKeyPem,
    });
  });

  router.get('/api/reports/dpdp', async (req, res) => {
    let period;
    try {
      period = parseReportPeriod(req.query.from, req.query.to);
    } catch (error) {
      return badRequest(res, error.message);
    }
    res.json(await buildDpdpReport({ ...period, auditChain }));
  });

  return router;
}
