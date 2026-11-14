// =============================================================================
// models/Policy.js: what to do with each type of data (used from Phase 3)
// =============================================================================
//
// Collection: "policies"
// Example documents:
//   { _id: "EMAIL",       action: "mask"  }   ← replace with [[EMAIL_1]], restore in the reply
//   { _id: "PRIVATE_KEY", action: "block" }   ← refuse to send the text at all
//   { _id: "PHONE",       action: "allow" }   ← let it through unchanged
//
// A company admin can change these in Atlas (or later from the dashboard)
// without touching any code.
// =============================================================================

import mongoose from 'mongoose';
import { ENTITY_TYPES } from '../detectors/index.js';

export const POLICY_ACTIONS = ['mask', 'block', 'allow'];

const policySchema = new mongoose.Schema(
  {
    _id: { type: String, enum: ENTITY_TYPES }, // the entity type, e.g. "EMAIL"
    action: { type: String, required: true, enum: POLICY_ACTIONS },
  },
  { versionKey: false },
);

export const Policy = mongoose.model('Policy', policySchema);

// Types that are BLOCKED by default instead of masked.
// Private source code: masking 200 lines into one tag would make the prompt useless
// anyway, and sending company code to an outside AI should be a conscious decision.
const DEFAULT_ACTIONS = { PRIVATE_CODE: 'block' };

/**
 * Makes sure every entity type has a policy (default "mask", see DEFAULT_ACTIONS).
 * Safe to run on every startup: "$setOnInsert" only writes when the policy
 * DOESN'T exist yet, so an admin's changes are never overwritten.
 */
export async function seedDefaultPolicies() {
  const operations = ENTITY_TYPES.map((type) => ({
    updateOne: {
      filter: { _id: type },
      update: { $setOnInsert: { action: DEFAULT_ACTIONS[type] ?? 'mask' } },
      upsert: true, // create it if it's missing
    },
  }));
  await Policy.bulkWrite(operations);
}
