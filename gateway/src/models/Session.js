// =============================================================================
// models/Session.js: one document per chat conversation
// =============================================================================
//
// Collection: "sessions"
// Example document:
//   {
//     _id:       "3f9a1c2e-7b4d-4e8a-9f1b-2c3d4e5f6a7b",   ← session ID (from the extension)
//     counters:  { EMAIL: 2, PAN: 1 },                    ← next tag number per type
//     createdAt: 2026-11-14T10:00:00Z,
//     expiresAt: 2026-11-15T10:00:00Z                     ← auto-deleted after this time
//   }
//
// WHY COUNTERS?
// The first email in a conversation becomes [[EMAIL_1]], the second [[EMAIL_2]]…
// The counter remembers which number is next, separately for each type.
// =============================================================================

import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema(
  {
    // We use the session ID itself as the document's _id (instead of MongoDB's
    // automatic ObjectId), so we can find a session directly by its ID.
    _id: { type: String, required: true },

    // A Map of type → number, e.g. { EMAIL: 2, PAN: 1 }.
    counters: { type: Map, of: Number, default: () => new Map() },

    // When this session (and its vault entries) should be deleted.
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // adds createdAt automatically
    versionKey: false, //                                 don't add Mongoose's "__v" field
  },
);

// TTL INDEX: MongoDB itself deletes the document once "expiresAt" has passed.
// (expireAfterSeconds: 0 means "delete exactly at expiresAt".)
// Atlas checks about once a minute, so deletion can be up to ~60 s late.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
