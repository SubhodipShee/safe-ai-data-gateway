// =============================================================================
// scripts/vault-demo.js: SEE the vault working, and see what Atlas stores
// =============================================================================
//
// Run it with:   npm run vault-demo
//
// What it does:
//   1. Hides a few sample values in the vault (in your real "safe-ai-gateway" database).
//   2. Shows the tags it got back.
//   3. Shows the raw document exactly as Atlas stores it (only gibberish).
//   4. Reveals the tags again with the master key.
//
// The demo session expires on its own after 24 hours, so you have time to look
// at it in Atlas: Data Explorer → safe-ai-gateway → vault.
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDb } from '../src/db.js';
import { createVault } from '../src/vault.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env'), quiet: true });

const dnsServers = (process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
await connectDb(process.env.MONGODB_URI, { dnsServers });

const vault = createVault({ masterKey: Buffer.from(process.env.MASTER_KEY, 'base64') });
const sessionId = `demo-${randomUUID()}`;

// Fake sample data (not real people).
const samples = [
  ['EMAIL', 'rahul.verma@gmail.com'],
  ['EMAIL', 'Rahul.Verma@GMAIL.com'], // same person, different case → same tag
  ['PAN', 'ABCPE1234F'],
  ['AADHAAR', '2345 6789 0124'],
  ['PHONE', '+91 98765 43210'],
];

console.log(`\nSession: ${sessionId}\n`);
console.log('1) HIDING VALUES');
for (const [type, value] of samples) {
  const tag = await vault.getOrCreatePlaceholder(sessionId, type, value);
  console.log(`   ${value.padEnd(24)} → ${tag}`);
}

console.log('\n2) WHAT ATLAS ACTUALLY STORES (one document):');
const raw = await mongoose.connection.collection('vault').findOne({ sessionId, placeholder: '[[EMAIL_1]]' });
console.log(`   placeholder: ${raw.placeholder}`);
console.log(`   valueHmac:   ${raw.valueHmac.slice(0, 32)}…   (fingerprint, can't be reversed)`);
console.log(`   ciphertext:  ${raw.ciphertext.buffer.toString('base64')}   (encrypted email)`);
console.log(`   iv:          ${raw.iv.buffer.toString('base64')}`);
console.log(`   authTag:     ${raw.authTag.buffer.toString('base64')}`);

console.log('\n3) REVEALING WITH THE MASTER KEY');
const tags = ['[[EMAIL_1]]', '[[PAN_1]]', '[[AADHAAR_1]]', '[[PHONE_1]]'];
const revealed = await vault.revealPlaceholders(sessionId, tags);
for (const tag of tags) {
  console.log(`   ${tag.padEnd(14)} → ${revealed.get(tag)}`);
}

console.log('\nOpen Atlas → Data Explorer → safe-ai-gateway → vault to see these documents yourself.');
console.log('They delete themselves automatically in 24 hours.\n');

await mongoose.disconnect();
