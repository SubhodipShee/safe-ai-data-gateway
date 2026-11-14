// =============================================================================
// scripts/register-code.js: protect a code folder from being pasted into AI tools
// =============================================================================
//
// Usage (from the gateway folder):
//   npm run register-code -- <folder>                    register / update a repo
//   npm run register-code -- <folder> --repo my-name     choose the repo name
//   npm run register-code -- --remove my-name            stop protecting a repo
//
// Example with the included demo repo:
//   npm run register-code -- ../demo/acme-payments
//
// What it does: reads every source file in the folder, turns each into
// fingerprints (code/fingerprint.js), and saves ONLY the fingerprints in Atlas.
// The code itself never leaves this computer.
// =============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDb } from '../src/db.js';
import { createCodeGuard } from '../src/code/code-guard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env'), quiet: true });

// Which files count as source code.
const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.java', '.kt', '.go', '.rb', '.php',
  '.cs', '.c', '.h', '.cpp', '.hpp', '.rs', '.swift', '.scala', '.sql', '.sh', '.vue', '.svelte', '.dart',
]);
// Folders that are never the company's own code.
const SKIP_FOLDERS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', '.next', '__pycache__', 'venv', '.venv']);
const MAX_FILE_BYTES = 1_000_000;

/** Lists every source file under a folder (skipping dependencies and build output). */
async function listCodeFiles(folder) {
  const files = [];
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_FOLDERS.has(entry.name)) files.push(...(await listCodeFiles(fullPath)));
    } else if (CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }
  return files;
}

// ---- Read the command-line arguments ----
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const removeRepo = option('--remove');
const folderArg = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

if (!removeRepo && !folderArg) {
  console.log('Usage: npm run register-code -- <folder> [--repo name]   |   npm run register-code -- --remove <name>');
  process.exit(1);
}

const dnsServers = (process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
await connectDb(process.env.MONGODB_URI, { dnsServers });
const codeGuard = createCodeGuard({ masterKey: Buffer.from(process.env.MASTER_KEY, 'base64') });

try {
  if (removeRepo) {
    const removed = await codeGuard.unregisterRepo(removeRepo);
    console.log(`\nRemoved ${removed} file(s) of "${removeRepo}". Its code is no longer protected.\n`);
  } else {
    const folder = path.resolve(process.cwd(), folderArg);
    const repo = option('--repo') ?? path.basename(folder);
    const files = await listCodeFiles(folder);
    console.log(`\nRegistering "${repo}" (${files.length} source file(s) in ${folder})\n`);

    const totals = { added: 0, updated: 0, unchanged: 0, 'too-small': 0, skipped: 0 };
    for (const file of files) {
      const relativePath = path.relative(folder, file).split(path.sep).join('/');
      const { size } = await fs.stat(file);
      if (size > MAX_FILE_BYTES) {
        totals.skipped += 1;
        console.log(`   skipped    ${relativePath} (larger than 1 MB)`);
        continue;
      }
      const content = await fs.readFile(file, 'utf8');
      const result = await codeGuard.registerFile(repo, relativePath, content);
      totals[result.status] += 1;
      console.log(`   ${result.status.padEnd(10)} ${relativePath}  (${result.fingerprints} fingerprints)`);
    }

    console.log(`\nDone: ${totals.added} added, ${totals.updated} updated, ${totals.unchanged} unchanged, ` +
      `${totals['too-small']} too small, ${totals.skipped} skipped.`);
    console.log('Only fingerprints were saved. No source code left this computer.\n');
  }
} finally {
  await mongoose.disconnect();
}
