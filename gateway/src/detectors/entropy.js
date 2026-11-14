// =============================================================================
// entropy.js: catches secrets that have NO known format
// =============================================================================
//
// Some secrets (webhook secrets, internal tokens, random keys) don't start with a
// known prefix like "AKIA" or "sk-". But they all have one thing in common:
// they look RANDOM. Normal words and code don't.
//
// We measure "randomness" with Shannon entropy: roughly, "how unpredictable is
// each character?"
//
//   "aaaaaaaa"                   → entropy 0.0   (totally predictable)
//   "internationalization"       → entropy ~3.4  (real word, many repeated letters)
//   "q8Zt3LmX9vPa2RbK7wYc4NdF"   → entropy ~4.6  (random-looking → probably a secret)
//
// This is a GUESS (a heuristic), so it has the LOWEST priority: if any other
// detector also matches the same text, that detector wins (see index.js).
// =============================================================================

/**
 * Calculates Shannon entropy in bits per character.
 * Example: shannonEntropy('abcd') → 2   (4 different letters, each used once)
 */
export function shannonEntropy(str) {
  // Step 1: count how often each character appears.
  const counts = new Map();
  for (const char of str) {
    counts.set(char, (counts.get(char) || 0) + 1);
  }

  // Step 2: entropy = sum of  -p × log2(p)  for each character,
  //         where p = (times it appears) / (total length).
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / str.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

// Candidate "tokens": 24 or more characters in a row from the base64 alphabet
// (letters, digits, _ + = -).
// "/" is deliberately left out, so file paths like src/components/Card.jsx don't match.
const TOKEN_PATTERN = /(?<![\w+=-])[\w+=-]{24,}(?![\w+=-])/g;

const MIN_ENTROPY = 4.0; // for mixed letters + digits
const MIN_HEX_ENTROPY = 3.0; // hex only uses 16 characters, so its maximum is lower

/** Decides whether a candidate token looks like a secret. */
function looksLikeSecret(token) {
  const isHexOnly = /^[a-f0-9]+$/i.test(token);

  if (isHexOnly) {
    // Hex keys: 32 chars (MD5 / 128-bit key), 64 chars (SHA-256 / 256-bit key), etc.
    // EXCEPTION: exactly 40 characters is a git commit hash. Those show up in
    // logs all the time and aren't secret, so we skip them.
    const longEnough = token.length >= 32;
    const isGitCommitHash = token.length === 40;
    const hasLetters = /[a-f]/i.test(token);
    const hasDigits = /\d/.test(token);
    return longEnough && !isGitCommitHash && hasLetters && hasDigits
      && shannonEntropy(token) >= MIN_HEX_ENTROPY;
  }

  // Everything else: must mix lowercase, UPPERCASE and at least 2 digits.
  // This filters out long variable names like this_is_a_very_long_snake_case_name.
  const hasLowercase = /[a-z]/.test(token);
  const hasUppercase = /[A-Z]/.test(token);
  const digitCount = token.replace(/\D/g, '').length;
  return hasLowercase && hasUppercase && digitCount >= 2
    && shannonEntropy(token) >= MIN_ENTROPY;
}

/** Returns every random-looking token in the text. */
export function findHighEntropy(text) {
  const findings = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    if (looksLikeSecret(token)) {
      findings.push({
        type: 'SECRET',
        label: 'high-entropy',
        start: match.index,
        end: match.index + token.length,
        value: token,
      });
    }
  }
  return findings;
}
