// =============================================================================
// test/test-db.js: shared helper for tests that need MongoDB Atlas
// =============================================================================
// (This file has no tests itself. Node's test runner loads it, finds nothing, and moves on.)
//
// Each test FILE uses its own database, e.g. "safe-ai-gateway-test-vault",
// because Node runs test files at the same time; sharing one database would
// let one file's clean-up delete another file's data mid-test.
// =============================================================================

import dns from 'node:dns';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Session } from '../src/models/Session.js';
import { VaultEntry } from '../src/models/VaultEntry.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { Policy } from '../src/models/Policy.js';
import { AuditHead } from '../src/models/AuditHead.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env'), quiet: true });

const mongoUri = process.env.MONGODB_URI;

/** False when there's no usable MONGODB_URI (e.g. on GitHub Actions): DB tests are then skipped. */
export const hasDatabase = Boolean(mongoUri) && !mongoUri.includes('PASTE_');

/** Use as:  describe('…', { skip: SKIP_WITHOUT_DB }, () => { … }) */
export const SKIP_WITHOUT_DB = hasDatabase ? false : 'no MONGODB_URI in gateway/.env';

/** Connects to a test database named "safe-ai-gateway-test-<name>" and builds all indexes. */
export async function connectTestDb(name) {
  const dnsServers = (process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (dnsServers.length) {
    dns.setServers(dnsServers); // same DNS fix as the app (see db.js), without the log line
  }
  await mongoose.connect(mongoUri, { dbName: `safe-ai-gateway-test-${name}`, serverSelectionTimeoutMS: 15_000 });
  // Make sure the indexes (especially the UNIQUE ones) exist before any test runs.
  await Promise.all([Session.init(), VaultEntry.init(), AuditLog.init(), Policy.init(), AuditHead.init()]);
}

/** Deletes the whole test database and disconnects. */
export async function dropTestDb() {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
}
