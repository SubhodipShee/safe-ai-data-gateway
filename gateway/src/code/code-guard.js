// =============================================================================
// code/code-guard.js: is this paste the company's private code?
// =============================================================================
//
// REGISTER (done once per repo, with: npm run register-code -- <folder>)
//   each source file → fingerprints (fingerprint.js) → saved in "codefiles"
//
// CHECK (on every /mask request)
//   pasted text → fingerprints → "which registered files share these?"
//   → if enough fingerprints match CLOSE TOGETHER in the paste, that part of
//     the paste is a PRIVATE_CODE finding (blocked by default).
//
// WHY "CLOSE TOGETHER"?
// Very generic code (a for-loop, an import line) can share a fingerprint or two
// with almost any repo by chance. Real copied code produces a dense CLUSTER of
// matches, e.g. 15 matches within a few lines. So we only flag clusters with
// at least MIN_CLUSTER_MATCHES matches.
// =============================================================================

import { createHash, hkdfSync } from 'node:crypto';
import { fingerprint } from './fingerprint.js';
import { normalizeText, mapSpan } from '../detectors/normalize.js';
import { CodeFile } from '../models/CodeFile.js';

/** A paste is flagged only where at least this many fingerprints match close together. */
export const MIN_CLUSTER_MATCHES = 8;
/** Matches further apart than this (in characters) start a new cluster. */
const CLUSTER_GAP = 300;
/** How long to remember "is anything registered at all?" (saves a database query per request). */
const REGISTRY_CACHE_MS = 60_000;

/**
 * Creates the code guard.
 * @param {object} options
 * @param {Buffer} options.masterKey  the fingerprint key is derived from it
 */
export function createCodeGuard({ masterKey }) {
  // Its own key (HKDF), separate from the vault and signing keys.
  const fingerprintKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'safe-ai-gateway/code-fingerprint', 32));

  let registryHasFiles = null;
  let registryCheckedAt = 0;

  async function anythingRegistered() {
    if (registryHasFiles === null || Date.now() - registryCheckedAt > REGISTRY_CACHE_MS) {
      registryHasFiles = (await CodeFile.estimatedDocumentCount()) > 0;
      registryCheckedAt = Date.now();
    }
    return registryHasFiles;
  }

  /**
   * Saves (or updates) the fingerprints of one source file.
   * @returns {Promise<{ status: 'added' | 'updated' | 'unchanged' | 'too-small', fingerprints: number }>}
   */
  async function registerFile(repo, path, content) {
    const contentHash = createHash('sha256').update(content).digest('hex');
    const existing = await CodeFile.findOne({ repo, path }, { contentHash: 1, fingerprintCount: 1 }).lean();
    if (existing?.contentHash === contentHash) {
      return { status: 'unchanged', fingerprints: existing.fingerprintCount };
    }

    const hashes = [...new Set(fingerprint(fingerprintKey, content).map((f) => f.hash))];
    if (hashes.length === 0) {
      return { status: 'too-small', fingerprints: 0 };
    }

    await CodeFile.updateOne(
      { repo, path },
      { $set: { contentHash, hashes, fingerprintCount: hashes.length, registeredAt: new Date() } },
      { upsert: true },
    );
    registryHasFiles = true;
    return { status: existing ? 'updated' : 'added', fingerprints: hashes.length };
  }

  /** Removes every registered file of a repo. Returns how many were removed. */
  async function unregisterRepo(repo) {
    const result = await CodeFile.deleteMany({ repo });
    registryHasFiles = null; // re-check next time
    return result.deletedCount;
  }

  /**
   * Looks for registered code in a piece of text.
   * @param {string} text  e.g. a prompt with some code pasted in
   * @returns {Promise<object[]>} PRIVATE_CODE findings, e.g.
   *   [{ type: 'PRIVATE_CODE', label: 'acme-payments/src/refund-service.js',
   *      start: 120, end: 980, value: '…the pasted code…', similarity: 0.94 }]
   */
  async function check(text) {
    // Nothing registered → nothing to find (and no database query).
    if (!(await anythingRegistered())) return [];

    // Undo bypass tricks first (Phase 3.5), e.g. invisible characters inside the code.
    const clean = normalizeText(text);
    const prints = fingerprint(fingerprintKey, clean.text);
    if (prints.length < MIN_CLUSTER_MATCHES) return [];

    // ---- Which registered files share fingerprints with the paste? ----
    // $setIntersection keeps only the fingerprints each file has in common with the paste,
    // so the database sends back just the matches, not every file's full list.
    const pasteHashes = [...new Set(prints.map((p) => p.hash))];
    const files = await CodeFile.aggregate([
      { $match: { hashes: { $in: pasteHashes } } },
      { $project: { repo: 1, path: 1, matched: { $setIntersection: ['$hashes', pasteHashes] } } },
    ]);
    if (files.length === 0) return [];

    // For each fingerprint: which file does it belong to? (the file with most matches wins)
    files.sort((a, b) => b.matched.length - a.matched.length);
    const fileOfHash = new Map();
    for (const file of files) {
      for (const hash of file.matched) {
        if (!fileOfHash.has(hash)) fileOfHash.set(hash, `${file.repo}/${file.path}`);
      }
    }

    // ---- Group the matching fingerprints into clusters ----
    const matchingPrints = prints.filter((p) => fileOfHash.has(p.hash)); // already in text order
    const clusters = [];
    for (const print of matchingPrints) {
      const current = clusters[clusters.length - 1];
      if (current && print.start - current.end <= CLUSTER_GAP) {
        current.end = Math.max(current.end, print.end);
        current.prints.push(print);
      } else {
        clusters.push({ start: print.start, end: print.end, prints: [print] });
      }
    }

    // ---- Dense clusters become findings ----
    const findings = [];
    for (const cluster of clusters) {
      if (cluster.prints.length < MIN_CLUSTER_MATCHES) continue; // too sparse: generic code

      // Which file does this cluster mostly come from?
      const votes = new Map();
      for (const p of cluster.prints) {
        const file = fileOfHash.get(p.hash);
        votes.set(file, (votes.get(file) || 0) + 1);
      }
      const [bestFile] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];

      // How much of the paste's code in this region matched (0–1).
      const printsInRegion = prints.filter((p) => p.start >= cluster.start && p.end <= cluster.end).length;
      const similarity = Math.round((cluster.prints.length / printsInRegion) * 100) / 100;

      // Widen to whole lines (so no half-line of private code is left behind),
      // then map from the clean copy back to the ORIGINAL text.
      const lineStart = clean.text.lastIndexOf('\n', cluster.start - 1) + 1;
      const nextNewline = clean.text.indexOf('\n', cluster.end);
      const lineEnd = nextNewline === -1 ? clean.text.length : nextNewline;
      const { start, end } = mapSpan(clean, lineStart, lineEnd);

      findings.push({
        type: 'PRIVATE_CODE',
        label: bestFile,
        start,
        end,
        value: text.slice(start, end),
        similarity,
      });
    }
    return findings;
  }

  /** Numbers for the dashboard: how many repos/files are protected. */
  async function stats() {
    const rows = await CodeFile.aggregate([
      { $group: { _id: '$repo', files: { $sum: 1 }, fingerprints: { $sum: '$fingerprintCount' } } },
      { $sort: { _id: 1 } },
    ]);
    return { repos: rows.map((r) => ({ repo: r._id, files: r.files, fingerprints: r.fingerprints })) };
  }

  return { registerFile, unregisterRepo, check, stats, fingerprintKey };
}
