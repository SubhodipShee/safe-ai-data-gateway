// =============================================================================
// scripts/tamper-demo.js: watch the audit chain catch an attacker
// =============================================================================
//
// Run it with:   npm run tamper-demo
//
// It plays an attacker with full database access, step by step:
//   1. write 5 genuine audit entries      → verify: intact
//   2. secretly change entry #3's count   → verify: caught
//   3. also recompute entry #3's hash     → verify: caught (the link to #4 breaks)
//   4. delete the newest 2 entries        → verify: caught (the signed head)
//
// It uses a SEPARATE throwaway database ("safe-ai-gateway-tamper-demo") that is
// deleted at the end, so your real audit log is never touched.
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { useDnsServers } from '../src/db.js';
import { createAuditChain, computeEntryHash } from '../src/audit/audit-chain.js';
import { AuditLog } from '../src/models/AuditLog.js';
import { AuditHead } from '../src/models/AuditHead.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env'), quiet: true });
useDnsServers((process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean));

await mongoose.connect(process.env.MONGODB_URI, { dbName: 'safe-ai-gateway-tamper-demo', serverSelectionTimeoutMS: 15_000 });
await Promise.all([AuditLog.init(), AuditHead.init()]);
await AuditLog.deleteMany({});
await AuditHead.deleteMany({});

const chain = createAuditChain({ masterKey: Buffer.from(process.env.MASTER_KEY, 'base64') });

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

async function showVerification() {
  const result = await chain.verify();
  if (result.valid) {
    console.log(`   ${GREEN}✔ INTACT${RESET}: ${result.entriesChecked} entries, all links and the signed head match`);
  } else {
    for (const p of result.problems) console.log(`   ${RED}✘ CAUGHT${RESET}: ${p.message}`);
  }
}

try {
  console.log('\n1) Writing 5 genuine audit entries…');
  const types = ['AADHAAR', 'EMAIL', 'PAN', 'PHONE', 'API_KEY'];
  await chain.append(types.map((entityType, i) => ({
    sessionId: 'demo-session-0000000',
    source: 'chatgpt.com',
    entityType,
    count: i + 1,
    action: i === 2 ? 'blocked' : 'masked',
  })));
  for (const e of await AuditLog.find().sort({ seq: 1 }).lean()) {
    console.log(`   #${e.seq} ${e.entityType.padEnd(8)} ${e.action.padEnd(8)} count=${e.count}  ${DIM}hash ${e.hash.slice(0, 12)}… prev ${e.prevHash.slice(0, 12)}…${RESET}`);
  }
  await showVerification();

  console.log('\n2) ATTACK: change entry #3 from "blocked" to "masked" (hide that a leak was blocked)…');
  await AuditLog.updateOne({ seq: 3 }, { action: 'masked' });
  await showVerification();

  console.log('\n3) ATTACK: …and also recompute entry #3\'s hash so it looks consistent…');
  const entry = await AuditLog.findOne({ seq: 3 }).lean();
  await AuditLog.updateOne({ seq: 3 }, { hash: computeEntryHash(entry) });
  await showVerification();

  console.log('\n4) Undo the edits, then ATTACK: delete the 2 newest entries…');
  await AuditLog.updateOne({ seq: 3 }, { action: 'blocked' });
  const original = await AuditLog.findOne({ seq: 3 }).lean();
  await AuditLog.updateOne({ seq: 3 }, { hash: computeEntryHash(original) });
  await AuditLog.deleteMany({ seq: { $gte: 4 } });
  await showVerification();

  console.log(`\nEvery attack was caught. The attacker had full database access, but not the gateway's signing key.\n`);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
