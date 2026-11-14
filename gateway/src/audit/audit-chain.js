// =============================================================================
// audit/audit-chain.js: a tamper-evident audit log (hash chain + signed head)
// =============================================================================
//
// THE PROBLEM
// An audit log is only useful as evidence if nobody can quietly change it. But
// anyone with database access (a rogue admin, an attacker) could edit or delete
// entries in Atlas.
//
// THE SOLUTION: a hash chain, like a blockchain without the "coin" part
//
//   entry #1                 entry #2                     entry #3
//   prevHash = 000…0         prevHash = hash of #1   ──►  prevHash = hash of #2
//   hash = SHA-256(…)   ──►  hash = SHA-256(…)            hash = SHA-256(…)
//
//   Each entry's hash covers its own data AND the previous hash. So:
//     - EDIT entry #2           → its hash no longer matches its data      → caught
//     - edit #2 AND fix its hash → #3's prevHash no longer matches          → caught
//     - DELETE entry #2         → the numbers jump from #1 to #3           → caught
//
// PLUS A SIGNED HEAD (models/AuditHead.js)
//     - DELETE the newest entries → the chain still looks fine… but the
//       signed head says "the chain ends at #3 with hash X"                → caught
//     - REWRITE the whole chain   → the new last hash doesn't match the signed
//       head, and only the gateway's private key can sign a new head       → caught
//
// HOW TO USE IT
//   const chain = createAuditChain({ masterKey });
//   await chain.append([{ sessionId, source, entityType: 'EMAIL', count: 2, action: 'masked' }]);
//   await chain.verify()  → { valid: true, entriesChecked: 42, problems: [] }
// =============================================================================

import { createHash } from 'node:crypto';
import { AuditLog, AUDIT_LOG_RETENTION_DAYS } from '../models/AuditLog.js';
import { AuditHead } from '../models/AuditHead.js';
import { deriveSigningKeys, signMessage, verifySignature } from '../crypto/signing.js';

const HEAD_ID = 'audit';
const GENESIS_HASH = '0'.repeat(64); // the "previous hash" of entry #1 (there's nothing before it)
const MAX_ATTEMPTS = 8;
const DUPLICATE_KEY_ERROR = 11000;

/**
 * Turns an entry into ONE exact string to hash. The order of the fields is fixed,
 * so the same entry always produces exactly the same string (and the same hash).
 */
function canonicalString(entry) {
  return JSON.stringify([
    entry.seq,
    new Date(entry.ts).toISOString(),
    entry.sessionId ?? null,
    entry.source ?? null,
    entry.entityType,
    entry.count,
    entry.obfuscatedCount ?? 0,
    entry.action,
    entry.prevHash,
  ]);
}

/** SHA-256 of an entry (as 64 hex characters). */
export function computeEntryHash(entry) {
  return createHash('sha256').update(canonicalString(entry), 'utf8').digest('hex');
}

/** The exact text the gateway signs for the head. */
function headMessage(seq, hash, signedAt) {
  return `safe-ai-gateway/audit-head|${seq}|${hash}|${new Date(signedAt).toISOString()}`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates the audit chain.
 * @param {object} options
 * @param {Buffer} options.masterKey  the 32-byte MASTER_KEY (the signing key is derived from it)
 */
export function createAuditChain({ masterKey }) {
  const keys = deriveSigningKeys(masterKey);

  // ---------------------------------------------------------------------------
  // Writing entries ONE AT A TIME
  // ---------------------------------------------------------------------------
  // Each entry needs the hash of the one before it, so two entries must never be
  // written at the same moment. `queue` makes every append wait for the previous one.
  // (Across several gateway processes, the unique index on "seq" does the same job:
  // a clash is rejected by the database and retried.)
  let queue = Promise.resolve();
  function runInOrder(task) {
    const result = queue.then(task);
    queue = result.catch(() => {}); // a failed append must not block the ones after it
    return result;
  }

  /** The newest point of the chain: where the next entry attaches. */
  async function findChainTip() {
    const newest = await AuditLog.findOne({ seq: { $exists: true } }).sort({ seq: -1 }).select({ seq: 1, hash: 1 }).lean();
    const head = await AuditHead.findById(HEAD_ID).lean();

    // Normally the newest entry IS the head. If the gateway crashed after writing an
    // entry but before signing the head, the newest entry is ahead, so continue from it.
    if (newest && (!head || newest.seq >= head.seq)) return { seq: newest.seq, hash: newest.hash };
    // If old entries expired (90-day retention), continue from the signed head.
    if (head) return { seq: head.seq, hash: head.hash };
    return { seq: 0, hash: GENESIS_HASH }; // brand-new chain
  }

  /**
   * Writes a batch of entries at the end of the chain in ONE database call.
   * The chain links are worked out in memory first: #43 links to the tip, #44 to #43…
   * Retries the whole batch if another process took the same numbers.
   */
  async function appendBatch(batch) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const tip = await findChainTip();
      const entries = [];
      let previous = tip;
      for (const data of batch) {
        const entry = {
          ts: new Date(),
          sessionId: data.sessionId,
          source: data.source,
          entityType: data.entityType,
          count: data.count,
          obfuscatedCount: data.obfuscatedCount ?? 0,
          action: data.action,
          seq: previous.seq + 1,
          prevHash: previous.hash,
        };
        entry.hash = computeEntryHash(entry);
        entries.push(entry);
        previous = entry;
      }

      try {
        // ordered: true = insert in order and stop at the first error. A clash with another
        // writer always happens on the FIRST entry (we both started from the same tip),
        // so on a clash nothing of ours was written and we can simply retry.
        await AuditLog.insertMany(entries, { ordered: true });
        return entries;
      } catch (error) {
        if (error.code !== DUPLICATE_KEY_ERROR) throw error;
        await wait(attempt * 25); // someone else wrote these numbers first: wait a moment and retry
      }
    }
    throw new Error('Could not append to the audit chain (too many simultaneous writers)');
  }

  /** Signs and saves "the chain now ends at this entry". Only ever moves FORWARD. */
  async function signHead(entry) {
    const signedAt = new Date();
    const head = {
      seq: entry.seq,
      hash: entry.hash,
      signedAt,
      signature: signMessage(keys.privateKey, headMessage(entry.seq, entry.hash, signedAt)),
    };

    // Update only if our entry is NEWER than the stored head…
    const result = await AuditHead.updateOne({ _id: HEAD_ID, seq: { $lt: entry.seq } }, { $set: head });
    if (result.matchedCount === 0) {
      // …or create the head if it doesn't exist yet. If it exists with a newer
      // entry already (another process won), the duplicate error is fine: ignore it.
      await AuditHead.create({ _id: HEAD_ID, ...head }).catch((error) => {
        if (error.code !== DUPLICATE_KEY_ERROR) throw error;
      });
    }
  }

  /**
   * Adds entries to the chain, in order, and signs the new head.
   * @param {object[]} entries  e.g. [{ sessionId, source, entityType, count, obfuscatedCount, action }]
   * @returns {Promise<object[]>} the written entries (with seq / prevHash / hash)
   */
  function append(entries) {
    return runInOrder(async () => {
      if (entries.length === 0) return [];
      const written = await appendBatch(entries);
      if (written.length > 0) {
        await signHead(written[written.length - 1]);
      }
      return written;
    });
  }

  /**
   * Re-checks the WHOLE chain from the oldest entry to the newest.
   * @returns {Promise<object>} e.g.
   *   { valid: false, entriesChecked: 42, firstSeq: 1, lastSeq: 42,
   *     problems: [ { seq: 17, kind: 'modified', message: 'Entry #17 was changed after it was written.' } ],
   *     notes: [], legacyEntries: 0, head: { seq: 42, signedAt } }
   */
  async function verify({ maxProblems = 20 } = {}) {
    const problems = [];
    const notes = [];
    function problem(seq, kind, message) {
      if (problems.length < maxProblems) problems.push({ seq, kind, message });
    }

    const head = await AuditHead.findById(HEAD_ID).lean();
    // Entries written before Phase 4 have no chain fields; we report how many.
    const legacyEntries = await AuditLog.countDocuments({ seq: { $exists: false } });

    // ---- Walk the chain from oldest to newest ----
    let previous = null;
    let firstSeq = null;
    let checked = 0;
    const cursor = AuditLog.find({ seq: { $exists: true } }).sort({ seq: 1 }).lean().cursor();

    for await (const entry of cursor) {
      checked += 1;
      if (firstSeq === null) firstSeq = entry.seq;

      // CHECK 1: does the entry still match its own hash?
      if (computeEntryHash(entry) !== entry.hash) {
        problem(entry.seq, 'modified', `Entry #${entry.seq} was changed after it was written.`);
      }

      // CHECK 2: is it correctly linked to the entry before it?
      if (previous) {
        if (entry.seq !== previous.seq + 1) {
          problem(entry.seq, 'missing', `Entries #${previous.seq + 1} to #${entry.seq - 1} were deleted.`);
        } else if (entry.prevHash !== previous.hash) {
          problem(entry.seq, 'broken-link', `Entry #${entry.seq} doesn't link to entry #${previous.seq}: one of them was replaced.`);
        }
      } else if (entry.seq === 1 && entry.prevHash !== GENESIS_HASH) {
        problem(1, 'broken-link', 'Entry #1 has the wrong starting hash.');
      }

      previous = entry;
    }

    // CHECK 3: does the chain end exactly where the SIGNED head says it should?
    if (!head) {
      if (checked > 0) problem(null, 'no-head', 'The signed head is missing: it was deleted.');
    } else if (!verifySignature(keys.publicKey, headMessage(head.seq, head.hash, head.signedAt), head.signature)) {
      problem(head.seq, 'bad-signature', 'The signed head was altered (its signature is invalid).');
    } else if (!previous) {
      notes.push(`All entries up to #${head.seq} have been removed by the ${AUDIT_LOG_RETENTION_DAYS}-day retention policy.`);
    } else if (previous.seq < head.seq) {
      problem(previous.seq + 1, 'truncated', `The newest entries #${previous.seq + 1} to #${head.seq} were deleted.`);
    } else if (previous.seq > head.seq) {
      problem(head.seq + 1, 'unsigned', `Entries after #${head.seq} are not covered by the signed head.`);
    } else if (previous.hash !== head.hash) {
      problem(previous.seq, 'head-mismatch', `Entry #${previous.seq} doesn't match the signed head: it was replaced.`);
    }

    // Old entries disappear on purpose after the retention period.
    if (firstSeq !== null && firstSeq > 1) {
      notes.push(`Entries before #${firstSeq} were removed by the ${AUDIT_LOG_RETENTION_DAYS}-day retention policy.`);
    }

    return {
      valid: problems.length === 0,
      entriesChecked: checked,
      firstSeq,
      lastSeq: previous?.seq ?? null,
      head: head ? { seq: head.seq, signedAt: head.signedAt } : null,
      problems,
      notes,
      legacyEntries,
    };
  }

  return {
    append,
    verify,
    publicKeyPem: keys.publicKeyPem,
    keyFingerprint: keys.fingerprint,
    sign: (message) => signMessage(keys.privateKey, message),
  };
}
