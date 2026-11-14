// =============================================================================
// policies.js: reads "what to do with each data type" from Atlas
// =============================================================================
//
// Each type has one of three actions (stored in the "policies" collection):
//   mask   replace with a tag like [[EMAIL_1]] and restore it in the reply  (default)
//   block  refuse to send the text at all
//   allow  let it through unchanged
//
// CACHING: reading Atlas on EVERY request would be slow, so we keep a copy in
// memory for 30 seconds. After an admin changes a policy in Atlas, it takes
// effect within 30 seconds.
// =============================================================================

import { Policy } from './models/Policy.js';

const CACHE_DURATION_MS = 30_000;

let cachedPolicies = null; // Map: type → action
let cachedAt = 0;

/** Returns a Map of type → action, e.g. Map { 'EMAIL' => 'mask', 'PRIVATE_KEY' => 'block' }. */
export async function getPolicies() {
  const cacheIsFresh = cachedPolicies && Date.now() - cachedAt < CACHE_DURATION_MS;
  if (cacheIsFresh) {
    return cachedPolicies;
  }

  // .lean() returns plain objects (faster; we only need to read them).
  const documents = await Policy.find().lean();
  cachedPolicies = new Map(documents.map((doc) => [doc._id, doc.action]));
  cachedAt = Date.now();
  return cachedPolicies;
}

/**
 * The action for one type. If a type has no policy, we MASK it:
 * the safe default (never accidentally let unknown data through).
 */
export function actionFor(policies, type) {
  return policies.get(type) ?? 'mask';
}

/** Forgets the cached copy, so the next call reads Atlas again. (Used by the tests.) */
export function clearPolicyCache() {
  cachedPolicies = null;
  cachedAt = 0;
}
