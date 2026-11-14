// =============================================================================
// models/CodeFile.js: fingerprints of the company's registered source files
// =============================================================================
//
// Collection: "codefiles" (one document per registered file)
//   {
//     repo:             "acme-payments",
//     path:             "src/refund-service.js",
//     contentHash:      "4be1…",           ← SHA-256 of the file (to skip unchanged files)
//     hashes:           [ 81723…, 99120…, … ],   ← the winnowing fingerprints (numbers)
//     fingerprintCount: 214,
//     registeredAt:     2026-11-14T10:00:00Z
//   }
//
// NO SOURCE CODE IS STORED, only keyed hashes that mean nothing without the
// gateway's MASTER_KEY. Even someone who steals the database can't rebuild the code,
// and can't even test whether a snippet they know is in the registry.
// =============================================================================

import mongoose from 'mongoose';

const codeFileSchema = new mongoose.Schema(
  {
    repo: { type: String, required: true, maxlength: 200 },
    path: { type: String, required: true, maxlength: 1000 },
    contentHash: { type: String, required: true },
    hashes: { type: [Number], required: true },
    fingerprintCount: { type: Number, required: true },
    registeredAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

// "Which files contain ANY of these fingerprints?" needs to be fast.
// An index on an array field ("multikey index") indexes every number in it.
codeFileSchema.index({ hashes: 1 });

// One document per file per repo.
codeFileSchema.index({ repo: 1, path: 1 }, { unique: true });

export const CodeFile = mongoose.model('CodeFile', codeFileSchema);
