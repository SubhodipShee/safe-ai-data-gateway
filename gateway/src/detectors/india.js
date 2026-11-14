// =============================================================================
// india.js: Indian identifiers (Aadhaar and PAN have their own files)
// =============================================================================
//
//   Type              Example                 How we avoid false alarms
//   ───────────────   ─────────────────────   ─────────────────────────────────────────
//   GSTIN             27AAPFU0939F1ZV         checksum + real state code
//   UPI_ID            rahul@okaxis            known bank/app handle list
//   IFSC              SBIN0001234             5th character must be 0
//   BANK_ACCOUNT      A/c 50100123456789      needs a keyword: "account", "a/c"…
//   VOTER_ID          Voter ID ABC1234567     needs a keyword: "voter", "epic"
//   PASSPORT          Passport K1234567       needs a keyword: "passport"
//   DRIVING_LICENCE   MH14 20110062821        real state code + valid year
//
// STRONG vs WEAK formats
//   STRONG formats are specific enough to trust on their own.
//   WEAK formats (bank account, voter ID, passport) look like ordinary codes,
//   e.g. "K1234567" could just as well be a product model. So we only flag them
//   when a KEYWORD appears just before them.
//   Trade-off: fewer false alarms, but an unlabelled passport number is missed.
// =============================================================================

import { findAll } from './util.js';

/**
 * Checks whether a keyword appears shortly BEFORE a position in the text.
 * Example: in "Passport No. K1234567", the word "passport" is just before K1234567.
 *
 * @param {string} text
 * @param {number} position     where the possible ID starts
 * @param {RegExp} keywords     e.g. /\bpassport\b/i
 * @param {number} lookBehind   how many characters back to search (default 40)
 */
function hasKeywordBefore(text, position, keywords, lookBehind = 40) {
  const from = Math.max(0, position - lookBehind);
  const textBefore = text.slice(from, position);
  return keywords.test(textBefore);
}

/**
 * Builds a keyword pattern from English words and Indian-language words.
 *
 * English words get \b (word boundaries), so "bank" doesn't match inside "embankment".
 * Indian-script words can't use \b: in JavaScript, \b only understands English
 * letters. So they're matched as plain text.
 *
 * Invisible joiner characters (often typed inside Bengali/Hindi words) are removed
 * from the keywords, because normalize.js removes them from the text too.
 *
 * Example: keywords(['passport'], ['पासपोर्ट', 'পাসপোর্ট'])
 */
function keywords(englishWords, indianWords = []) {
  const english = `\\b(?:${englishWords.join('|')})\\b`;
  const indian = indianWords.map((word) => word.replace(/[‌‍]/g, '')).join('|');
  return new RegExp(indian ? `${english}|${indian}` : english, 'i');
}

/** Like findAll, but keeps only the matches that have a keyword just before them. */
function findAllWithKeyword(text, pattern, type, keywords) {
  const findings = findAll(text, pattern, type);
  return findings.filter((finding) => hasKeywordBefore(text, finding.start, keywords));
}

// =============================================================================
// GSTIN (GST Identification Number): 15 characters
// =============================================================================
//    2 7 A A P F U 0 9 3 9 F 1 Z V
//    └┬┘ └───────┬───────┘ │ │ └─ check character (calculated from the first 14)
//     │          │         │ └─── always "Z"
//     │          │         └───── entity number (1st, 2nd… registration of this PAN)
//     │          └─────────────── the business's PAN
//     └────────────────────────── state code (27 = Maharashtra, 29 = Karnataka…)

const GST_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; // each character's value = its position

/**
 * Calculates the GSTIN check character from the first 14 characters
 * (the mod-36 algorithm published by GSTN).
 */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GST_ALPHABET.indexOf(first14[i]);
    const factor = i % 2 === 0 ? 1 : 2; // multiply every 2nd character by 2
    const product = value * factor;
    // Add the "base-36 digits" of the product (like adding digits in Luhn's algorithm).
    sum += Math.floor(product / 36) + (product % 36);
  }
  const checkValue = (36 - (sum % 36)) % 36;
  return GST_ALPHABET[checkValue];
}

/** True if the GSTIN has a real state code AND a correct check character. */
export function isValidGstin(value) {
  const gstin = value.toUpperCase();

  const stateCode = Number(gstin.slice(0, 2));
  const isRealState = (stateCode >= 1 && stateCode <= 38) || stateCode === 97 || stateCode === 99;

  const checkCharIsCorrect = gstinCheckChar(gstin.slice(0, 14)) === gstin[14];

  return isRealState && checkCharIsCorrect;
}

// 2 digits + 5 letters + 4 digits + 1 letter + entity (1-9 or A-Z) + Z + check character
const GSTIN_PATTERN = /(?<![A-Za-z0-9])\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z](?![A-Za-z0-9])/gi;

export function findGstins(text) {
  return findAll(text, GSTIN_PATTERN, 'GSTIN', { validate: isValidGstin });
}

// =============================================================================
// UPI ID: name@handle   e.g. rahul@okaxis, 9876543210@ybl
// =============================================================================
// The difference from an email: the part after @ has NO dot (okaxis, not okaxis.com).
// If the handle is in this list of real bank/app handles, it's definitely a UPI ID.
const KNOWN_UPI_HANDLES = new Set(
  `ybl ibl axl okaxis okhdfcbank okicici oksbi okbizaxis paytm ptyes ptaxis pthdfc ptsbi upi apl yapl
   rapl axisbank axisb icici hdfcbank sbi kotak kmbl idfcbank idfcfirst ikwik freecharge jupiteraxis fbl
   federal waicici wahdfcbank waaxis wasbi wasbx airtel airtelpaymentsbank apb jio pingpay abfspay
   barodampay cnrb idbi indus kbl pnb rbl yesbank yesbankltd yesg aubank dbs hsbc citi citigold sc
   unionbank unionbankofindia ubi boi mahb centralbank iob ucobank dlb kvb tjsb equitas fino
   superyes slice naviaxis goaxb tapicici postbank nsdl juspay amazonpay apay timecosmos zoicici
   indianbank allbank andb vijb denabank psb sib csbpay karurvysyabank cub jkb myicici`
    .split(/\s+/)
    .filter(Boolean),
);

// How the pattern reads:
//   [A-Za-z0-9._-]{2,256}     the name part (2–256 characters)
//   @([A-Za-z]{2,64})         "@" + the handle, letters only (captured so we can check it)
//   (?![\w@-]|\.[A-Za-z0-9])  must not continue, e.g. into ".com". A dot that ENDS
//                             a sentence ("pay shop@paytm.") is allowed.
const UPI_PATTERN = /(?<![\w.@-])[A-Za-z0-9._-]{2,256}@([A-Za-z]{2,64})(?![\w@-]|\.[A-Za-z0-9])/g;

// For handles NOT in the list, we need "UPI" or "VPA" written just before.
const UPI_KEYWORDS = keywords(['upi', 'vpa'], ['यूपीआई', 'ইউপিআই']);

export function findUpiIds(text) {
  const findings = [];
  for (const match of text.matchAll(UPI_PATTERN)) {
    const handle = match[1].toLowerCase();
    const isKnownHandle = KNOWN_UPI_HANDLES.has(handle);
    const saysUpi = hasKeywordBefore(text, match.index, UPI_KEYWORDS);

    if (isKnownHandle || saysUpi) {
      findings.push({
        type: 'UPI_ID',
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
      });
    }
  }
  return findings;
}

// =============================================================================
// IFSC: bank branch code, 11 characters, e.g. SBIN0001234
// =============================================================================
//   SBIN   0   001234
//   bank   always 0   branch
const IFSC_PATTERN = /(?<![A-Za-z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Za-z0-9])/g;

export function findIfscs(text) {
  return findAll(text, IFSC_PATTERN, 'IFSC');
}

// =============================================================================
// BANK ACCOUNT NUMBER: 9 to 18 digits (WEAK format, so it needs a keyword)
// =============================================================================
//   "A/c no: 50100123456789"  → caught
//   "invoice 50100123456789"  → ignored (no keyword)
const BANK_ACCOUNT_PATTERN = /(?<![\w-])\d{9,18}(?![\w-])/g;
const BANK_KEYWORDS = keywords(
  ['account', 'acct', 'a\\/c', 'ac\\s*no', 'bank', 'khata'],
  ['खाता', 'बैंक', 'অ্যাকাউন্ট', 'ব্যাংক', 'হিসাব', 'খাতা'], // Hindi, Bengali
);

export function findBankAccounts(text) {
  return findAllWithKeyword(text, BANK_ACCOUNT_PATTERN, 'BANK_ACCOUNT', BANK_KEYWORDS);
}

// =============================================================================
// VOTER ID (EPIC number): 3 letters + 7 digits (WEAK format, so it needs a keyword)
// =============================================================================
const VOTER_ID_PATTERN = /(?<![A-Za-z0-9])[A-Z]{3}\d{7}(?![A-Za-z0-9])/gi;
const VOTER_KEYWORDS = keywords(['voter', 'epic', 'election'], ['मतदाता', 'वोटर', 'ভোটার']);

export function findVoterIds(text) {
  return findAllWithKeyword(text, VOTER_ID_PATTERN, 'VOTER_ID', VOTER_KEYWORDS);
}

// =============================================================================
// PASSPORT: 1 letter + 7 digits, e.g. K1234567 (WEAK format, so it needs a keyword)
// =============================================================================
// Indian passports never start with Q, X or Z, hence [A-PR-WY]
// (= A to P, R to W, and Y).
const PASSPORT_PATTERN = /(?<![A-Za-z0-9])[A-PR-WY][1-9]\d{6}(?![A-Za-z0-9])/gi;
const PASSPORT_KEYWORDS = keywords(['passport'], ['पासपोर्ट', 'পাসপোর্ট']);

export function findPassports(text) {
  return findAllWithKeyword(text, PASSPORT_PATTERN, 'PASSPORT', PASSPORT_KEYWORDS);
}

// =============================================================================
// DRIVING LICENCE: state + RTO + year + 7 digits, e.g. MH14 20110062821
// =============================================================================
//   MH   14    2011   0062821
//   │    │     │      └─ serial number
//   │    │     └──────── year of issue (19xx or 20xx)
//   │    └────────────── RTO office code
//   └─────────────────── state code (must be a real one, from the list below)
const STATE_CODES = [
  'AN', 'AP', 'AR', 'AS', 'BR', 'CH', 'CG', 'CT', 'DD', 'DL', 'DN', 'GA', 'GJ', 'HP',
  'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD',
  'OR', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TR', 'TS', 'TG', 'UK', 'UA', 'UP', 'WB',
];

// [ -]? allows an optional space or hyphen between the parts.
const DRIVING_LICENCE_PATTERN = new RegExp(
  '(?<![A-Za-z0-9])' +
    `(?:${STATE_CODES.join('|')})` + // state code
    '[ -]?\\d{2}' + //                  RTO code
    '[ -]?(?:19|20)\\d{2}' + //         year
    '[ -]?\\d{7}' + //                  serial number
    '(?![A-Za-z0-9])',
  'g',
);

export function findDrivingLicences(text) {
  return findAll(text, DRIVING_LICENCE_PATTERN, 'DRIVING_LICENCE');
}
