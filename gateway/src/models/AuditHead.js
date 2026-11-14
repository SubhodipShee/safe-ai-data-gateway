// =============================================================================
// models/AuditHead.js: the signed "latest entry" marker of the audit chain
// =============================================================================
//
// Collection: "auditheads" (one document)
//   {
//     _id:       "audit",
//     seq:       42,                    ← number of the newest audit entry
//     hash:      "9c1e4f…",             ← that entry's hash
//     signedAt:  2026-11-14T10:00:00Z,
//     signature: "MEUCIQ…"              ← Ed25519 signature of (seq + hash + signedAt)
//   }
//
// WHY IS THIS NEEDED?
// The hash chain catches any change to an entry and any deletion IN THE MIDDLE.
// But if an attacker deletes the NEWEST entries, the remaining chain is still
// perfectly linked. The signed head catches that: it says the chain must end at
// entry #42 with hash 9c1e4f…, and nobody without the private key can change it.
// =============================================================================

import mongoose from 'mongoose';

const auditHeadSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true },
    hash: { type: String, required: true },
    signedAt: { type: Date, required: true },
    signature: { type: String, required: true },
  },
  { versionKey: false },
);

export const AuditHead = mongoose.model('AuditHead', auditHeadSchema);
