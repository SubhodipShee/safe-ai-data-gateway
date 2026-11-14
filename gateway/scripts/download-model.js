// =============================================================================
// download-model.js: downloads the local AI name model ahead of time (Phase 10)
// =============================================================================
//
// Run:   npm run download-model
//
// Render runs this during the BUILD step, so the ~110 MB model is already in
// gateway/.models when the server starts, instead of being downloaded while the
// first visitor waits. (If it's missing anyway, the gateway downloads it on start.)
//
// It needs no .env and no database: it only fetches the model and tries it once.
// =============================================================================

import { createNameFinder } from '../src/ai/name-finder.js';

const startedAt = Date.now();
const nameFinder = createNameFinder();
await nameFinder.load();

if (nameFinder.status !== 'ready') {
  console.error('✘ Could not load the name model (see the message above).');
  process.exit(1);
}

// Quick check that it really works.
const found = await nameFinder.find('Please refund Rahul Verma today.');
console.log(`✔ Name model ready in ${((Date.now() - startedAt) / 1000).toFixed(1)} s; test found: ${found.map((f) => f.value).join(', ') || 'nothing'}`);
