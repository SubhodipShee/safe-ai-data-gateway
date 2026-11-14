// =============================================================================
// models/AuditLog.js: a record of what was caught (used from Phase 3)
// =============================================================================
//
// Collection: "auditlogs"
// Example document:
//   {
//     ts:         2026-11-14T10:00:00Z,
//     sessionId:  "3f9a1c2e-…",
//     source:     "chatgpt.com",      ← where the text came from
//     entityType: "AADHAAR",
//     count:      1,
//     obfuscatedCount: 1,             ← how many of them were BYPASS ATTEMPTS
//                                       (e.g. Aadhaar written in Devanagari digits)
//     action:     "masked",           ← or "blocked"
//     seq:        42,                 ← position in the hash chain (Phase 4)
//     prevHash:   "77ab…",            ← hash of entry #41
//     hash:       "9c1e…"             ← SHA-256 of (prevHash + this entry's data)
//   }
//
// IMPORTANT: the audit log NEVER stores the sensitive value itself. It proves
// WHAT was blocked without storing WHAT was blocked.
//
// Entries are written ONLY through audit/audit-chain.js, which fills in
// seq / prevHash / hash so that any later edit can be detected.
// The dashboard (Phase 9) and the DPDP report read this collection.
// =============================================================================

import mongoose from 'mongoose';
import { ENTITY_TYPES } from '../detectors/index.js';

export const AUDIT_LOG_RETENTION_DAYS = 90;

const auditLogSchema = new mongoose.Schema(
  {
    ts: { type: Date, default: Date.now },
    sessionId: { type: String },
    source: { type: String, maxlength: 200 },
    entityType: { type: String, required: true, enum: ENTITY_TYPES },
    count: { type: Number, required: true, min: 1 },
    obfuscatedCount: { type: Number, default: 0, min: 0 },
    action: { type: String, required: true, enum: ['masked', 'blocked'] },

    // ---- Hash chain fields (Phase 4) ----
    seq: { type: Number },
    prevHash: { type: String },
    hash: { type: String },
  },
  { versionKey: false },
);

// Each chain position can only be used ONCE. If two gateway processes try to
// write entry #43 at the same moment, the database rejects the second one, and it
// retries as #44. ("sparse" = ignore old entries from before Phase 4 that have no seq.)
auditLogSchema.index({ seq: 1 }, { unique: true, sparse: true });

// Keep audit logs for 90 days, then let MongoDB delete them automatically.
// The same index also makes "latest first" dashboard queries fast.
auditLogSchema.index({ ts: 1 }, { expireAfterSeconds: AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
