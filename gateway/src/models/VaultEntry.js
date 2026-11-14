// =============================================================================
// models/VaultEntry.js: the encrypted real values
// =============================================================================
//
// Collection: "vault"
// Example document (this is ALL that Atlas ever sees):
//   {
//     sessionId:   "3f9a1c2e-…",
//     placeholder: "[[EMAIL_1]]",
//     entityType:  "EMAIL",
//     valueHmac:   "9c1e4f7a…",              ← fingerprint, for "seen this before?" lookups
//     ciphertext:  <Binary 0x8f3a…>,         ← the encrypted email
//     iv:          <Binary 12 bytes>,
//     authTag:     <Binary 16 bytes>,
//     createdAt:   2026-11-14T10:00:00Z,
//     expiresAt:   2026-11-15T10:00:00Z
//   }
//
// Notice what is NOT here: the real email. Even someone with full access to
// the database can't read it without the MASTER_KEY, which lives only in the
// gateway's .env file.
// =============================================================================

import mongoose from 'mongoose';
import { ENTITY_TYPES } from '../detectors/index.js';

const vaultEntrySchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true },
    placeholder: { type: String, required: true },
    entityType: { type: String, required: true, enum: ENTITY_TYPES },
    valueHmac: { type: String, required: true },
    ciphertext: { type: Buffer, required: true },
    iv: { type: Buffer, required: true },
    authTag: { type: Buffer, required: true },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: 'vault', // name of the collection in Atlas
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
  },
);

// INDEX 1: auto-delete when expiresAt has passed (same as sessions).
vaultEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// INDEX 2: the same value can only be stored ONCE per session.
// If two requests try to store the same email at the same moment, the database
// rejects the second one, so the email can never end up with two different tags.
vaultEntrySchema.index({ sessionId: 1, valueHmac: 1 }, { unique: true });

// INDEX 3: fast lookups when un-masking ("what is [[EMAIL_1]] in this session?").
// Unique: one tag can only mean one value.
vaultEntrySchema.index({ sessionId: 1, placeholder: 1 }, { unique: true });

export const VaultEntry = mongoose.model('VaultEntry', vaultEntrySchema);
