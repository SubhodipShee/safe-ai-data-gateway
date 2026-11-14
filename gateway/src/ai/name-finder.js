// =============================================================================
// ai/name-finder.js: finds people's NAMES with a small AI model, fully offline
// =============================================================================
//
// WHY AI? A pattern can recognise "ABCPE1234F" as a PAN, but no pattern can tell
// that "Rahul Verma" is a person and "Salt Lake" isn't. That needs a model that
// understands language.
//
// THE MODEL: BERT-base-NER ("Named Entity Recognition"), a well-known free model
// trained to label words as Person / Organisation / Location / Other.
//   - It runs INSIDE the gateway (transformers.js + ONNX Runtime), on this computer.
//   - Names are never sent to another AI just to be detected.
//   - First start downloads it once (~110 MB) into gateway/.models; after that it works offline.
//   - About 20 ms per paragraph on a normal laptop CPU.
//
// WHAT THE MODEL RETURNS (word pieces, without positions):
//   "customer Rahul Verma"  →  Ra (B-PER) ##hul (B-PER) V (I-PER) ##er (I-PER) ##ma (I-PER)
//   We glue the pieces back together ("##" = same word), find "Rahul Verma" in the
//   text, and report it as a PERSON finding.
//
// We only report PERSON. Organisations ("ACME") and places ("Kolkata") stay
// visible, because the AI needs that context and they aren't personal data on their own.
// (Addresses are handled by rules in detectors/address.js.)
// =============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeText, mapSpan } from '../detectors/normalize.js';

const MODEL_NAME = 'Xenova/bert-base-NER';

/** gateway/.models: where the model is downloaded (by `npm run download-model` or on first start). */
export const DEFAULT_MODEL_CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.models');

// ONE CPU thread. Measured on a laptop: 1 thread = 28 ms of CPU per message,
// 4 threads = 50 ms (faster on a big machine, but more CPU in total). Render's free
// server has only 0.1 of a CPU, so the least total CPU wins: ~0.3 s per message there.
const SESSION_OPTIONS = { intraOpNumThreads: 1, interOpNumThreads: 1 };
/** Only trust the model when it is at least this sure (0–1). */
const MIN_CONFIDENCE = 0.85;
/** BERT reads at most ~512 word pieces at once, so long text is split into chunks of this many characters. */
const CHUNK_CHARS = 1000;
/** Names are only searched in the first 20,000 characters (to keep huge pastes fast). */
export const MAX_NAME_SCAN_CHARS = 20_000;

// A real name: starts with a capital letter, only letters (plus . ' -), 1–5 words.
// This filters out model mistakes on code like "getUser_id2".
const LOOKS_LIKE_A_NAME = /^\p{Lu}[\p{L}.'’-]*(?:\s+[\p{L}.'’-]+){0,4}$/u;

/**
 * Splits text into chunks of about CHUNK_CHARS, at line breaks or spaces.
 * @returns {{ text: string, offset: number }[]}  offset = where the chunk starts in the full text
 */
function splitIntoChunks(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      // Prefer to cut at a line break, otherwise at a space, so no word is cut in half.
      const lineBreak = text.lastIndexOf('\n', end);
      const space = text.lastIndexOf(' ', end);
      const cut = lineBreak > start ? lineBreak : space > start ? space : end;
      end = cut;
    }
    chunks.push({ text: text.slice(start, end), offset: start });
    start = end;
  }
  return chunks;
}

/**
 * Glues the model's word pieces back into whole PERSON names.
 * Input:  [{ entity: 'B-PER', word: 'Ra', index: 10, score }, { entity: 'B-PER', word: '##hul', index: 11 }, …]
 * Output: [{ pieces: ['Ra', '##hul', 'V', '##er', '##ma'], confidence: 0.99 }]
 */
function groupNamePieces(tokens) {
  const names = [];
  let current = null;

  for (const token of tokens) {
    const [position, kind] = token.entity.split('-'); // e.g. 'B-PER' → 'B', 'PER'
    const isPerson = kind === 'PER';
    const isNextPiece = current && token.index === current.lastIndex + 1;
    // A piece continues the current name if it directly follows it AND is either
    // "inside" (I-) or the rest of a split word (##…).
    const continuesName = isPerson && isNextPiece && (position === 'I' || token.word.startsWith('##'));

    if (continuesName) {
      current.pieces.push(token.word);
      current.scores.push(token.score);
      current.lastIndex = token.index;
    } else {
      if (current) names.push(current);
      current = isPerson ? { pieces: [token.word], scores: [token.score], lastIndex: token.index } : null;
    }
  }
  if (current) names.push(current);

  return names.map((name) => ({
    pieces: name.pieces,
    confidence: name.scores.reduce((sum, s) => sum + s, 0) / name.scores.length,
  }));
}

/** Escapes characters that have a special meaning in regular expressions. */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a pattern that finds the name in the text, e.g. pieces Ra ##hul V ##er ##ma
 * → /Rahul\s*Verma/  ("##" pieces join directly; other pieces may have spaces between).
 */
function patternForPieces(pieces) {
  const source = pieces
    .map((piece, i) => {
      if (piece.startsWith('##')) return escapeRegex(piece.slice(2));
      return (i === 0 ? '' : '\\s*') + escapeRegex(piece);
    })
    .join('');
  return new RegExp(source, 'g');
}

/** Widens a span to whole words (in case the model labelled only part of a word). */
function widenToWholeWords(text, start, end) {
  const isLetter = (ch) => ch !== undefined && /\p{L}/u.test(ch);
  while (isLetter(text[start - 1])) start -= 1;
  while (isLetter(text[end])) end += 1;
  return { start, end };
}

/**
 * Creates the name finder.
 * @param {object} options
 * @param {string} [options.cacheDir]  where the downloaded model is kept
 * @param {boolean} [options.enabled=true]  false = never load the model (emergency switch)
 */
export function createNameFinder({ cacheDir = DEFAULT_MODEL_CACHE_DIR, enabled = true } = {}) {
  let status = enabled ? 'not-loaded' : 'off';
  let loading = null;

  /** Loads the model once. Safe to call many times; later calls reuse the same promise. */
  function load() {
    if (!enabled) return Promise.resolve(null);
    if (!loading) {
      status = 'loading';
      loading = (async () => {
        // Imported only when needed, so the gateway starts fast and works without it.
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = cacheDir;
        const model = await pipeline('token-classification', MODEL_NAME, { dtype: 'q8', session_options: SESSION_OPTIONS });
        status = 'ready';
        return model;
      })().catch((error) => {
        // No internet on first run, not enough memory… The gateway keeps working;
        // names just aren't detected, and /health says so.
        status = 'failed';
        console.warn(`[ai] name detection unavailable: ${error.message}`);
        return null;
      });
    }
    return loading;
  }

  /**
   * Finds people's names in the text.
   * @returns {Promise<object[]>} e.g. [{ type: 'PERSON', label: 'ai', start, end, value: 'Rahul Verma', confidence: 0.99 }]
   */
  async function find(text) {
    const model = await load();
    if (!model || !text) return [];

    // Same clean copy as the other detectors (Phase 3.5), then map back at the end.
    const clean = normalizeText(text);
    const scanText = clean.text.slice(0, MAX_NAME_SCAN_CHARS);
    const findings = [];

    for (const chunk of splitIntoChunks(scanText)) {
      const tokens = await model(chunk.text);
      let searchFrom = 0; // names appear in order, so search after the previous one

      for (const name of groupNamePieces(tokens)) {
        if (name.confidence < MIN_CONFIDENCE) continue;

        // Find this name in the chunk.
        const pattern = patternForPieces(name.pieces);
        pattern.lastIndex = searchFrom;
        const match = pattern.exec(chunk.text);
        if (!match) continue;
        const { start, end } = widenToWholeWords(chunk.text, match.index, match.index + match[0].length);
        searchFrom = end;

        const cleanValue = chunk.text.slice(start, end);
        if (!LOOKS_LIKE_A_NAME.test(cleanValue)) continue;

        // Positions: chunk → clean copy → ORIGINAL text.
        const original = mapSpan(clean, chunk.offset + start, chunk.offset + end);
        findings.push({
          type: 'PERSON',
          label: 'ai',
          start: original.start,
          end: original.end,
          value: text.slice(original.start, original.end),
          confidence: Math.round(name.confidence * 100) / 100,
        });
      }
    }
    return findings;
  }

  return {
    load,
    find,
    /** 'off' | 'not-loaded' | 'loading' | 'ready' | 'failed' (shown at /health) */
    get status() {
      return status;
    },
  };
}
