// Tests for Phase 3.5: bypass-resistant detection (normalize.js + detect()).
// Each test is a trick an employee might use to sneak data past the filter.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detect, countObfuscated } from '../src/detectors/index.js';
import { normalizeText, mapSpan } from '../src/detectors/normalize.js';
import { normalizeForLookup } from '../src/vault.js';

const ZWSP = '​'; // zero-width space (invisible)
const ZWJ = '‍'; //  zero-width joiner (invisible)
const SOFT_HYPHEN = '­';

/** The single finding in `text`, checking its type, exact original value and bypass flag. */
function expectOne(text, type, { obfuscated = true } = {}) {
  const findings = detect(text);
  assert.equal(findings.length, 1, `expected 1 finding in ${JSON.stringify(text)}, got ${JSON.stringify(findings)}`);
  const [finding] = findings;
  assert.equal(finding.type, type);
  assert.equal(text.slice(finding.start, finding.end), finding.value, 'positions must point at the ORIGINAL text');
  assert.equal(Boolean(finding.obfuscated), obfuscated, 'obfuscated flag');
  return finding;
}

describe('Phase 3.5: Indian-script digits', () => {
  test('Aadhaar in Devanagari digits', () => {
    const f = expectOne('आधार २३४५ ६७८९ ०१२४ है', 'AADHAAR');
    assert.equal(f.value, '२३४५ ६७८९ ०१२४');
  });
  test('Aadhaar in Bengali digits', () => {
    assert.equal(expectOne('আধার ২৩৪৫ ৬৭৮৯ ০১২৪', 'AADHAAR').value, '২৩৪৫ ৬৭৮৯ ০১২৪');
  });
  test('Aadhaar in Tamil and Gujarati digits', () => {
    expectOne('௨௩௪௫ ௬௭௮௯ ௦௧௨௪', 'AADHAAR');
    expectOne('૨૩૪૫ ૬૭૮૯ ૦૧૨૪', 'AADHAAR');
  });
  test('MIXED scripts in one number', () => {
    expectOne('2345 ६७८९ ০১২৪', 'AADHAAR');
  });
  test('phone number in Devanagari digits', () => {
    expectOne('फ़ोन ९८७६५ ४३२१०', 'PHONE');
  });
  test('wrong checksum is still rejected after cleaning (no false alarms)', () => {
    assert.deepEqual(detect('२३४५ ६७८९ ०१२५'), []);
  });
});

describe('Phase 3.5: invisible characters', () => {
  test('zero-width spaces inside an Aadhaar', () => {
    expectOne(`2345${ZWSP}6789${ZWSP}0124`, 'AADHAAR');
  });
  test('zero-width joiner inside a PAN', () => {
    expectOne(`ABC${ZWJ}PE1234F`, 'PAN');
  });
  test('soft hyphen inside an email', () => {
    const f = expectOne(`rahul${SOFT_HYPHEN}@abc.com`, 'EMAIL');
    assert.equal(f.value, `rahul${SOFT_HYPHEN}@abc.com`, 'the original (with the hidden character) is what gets masked');
  });
  test('invisible characters inside an AWS key', () => {
    expectOne(`AKIA${ZWSP}IOSFODNN7EXAMPLE`, 'API_KEY');
  });
});

describe('Phase 3.5: look-alike and full-width letters', () => {
  test('PAN written with Cyrillic letters (А В С Р Е look Latin)', () => {
    expectOne('PAN АВСРЕ1234F', 'PAN'); // the first 5 letters are Cyrillic
  });
  test('PAN in full-width characters', () => {
    expectOne('ＡＢＣＰＥ１２３４Ｆ', 'PAN');
  });
  test('email with a Cyrillic "а"', () => {
    expectOne('rаhul@abc.com', 'EMAIL'); // the "а" is Cyrillic
  });
  test('Aadhaar in maths-bold digits (2 code units each)', () => {
    const text = 'id 𝟐𝟑𝟒𝟓 𝟔𝟕𝟖𝟗 𝟎𝟏𝟐𝟒 ok';
    assert.equal(expectOne(text, 'AADHAAR').value, '𝟐𝟑𝟒𝟓 𝟔𝟕𝟖𝟗 𝟎𝟏𝟐𝟒');
  });
});

describe('Phase 3.5: spaced-out digits and letter-for-digit swaps', () => {
  test('phone written one digit at a time', () => {
    expectOne('call 9 8 7 6 5 4 3 2 1 0 now', 'PHONE');
  });
  test('Aadhaar with dashes between every digit', () => {
    expectOne('2-3-4-5-6-7-8-9-0-1-2-4', 'AADHAAR');
  });
  test('letter O used instead of zero', () => {
    expectOne('call 98765 4321O', 'PHONE');
  });
  test('normal formats are NOT flagged as bypass attempts', () => {
    expectOne('Aadhaar 2345 6789 0124', 'AADHAAR', { obfuscated: false });
    expectOne('+91 98765 43210', 'PHONE', { obfuscated: false });
  });
});

describe('Phase 3.5: Hindi and Bengali keywords', () => {
  test('passport after "पासपोर्ट" (Hindi)', () => {
    expectOne('पासपोर्ट K1234567', 'PASSPORT', { obfuscated: false });
  });
  test('bank account after "खाता" (Hindi) and "অ্যাকাউন্ট" (Bengali)', () => {
    expectOne('खाता संख्या 50100123456789', 'BANK_ACCOUNT', { obfuscated: false });
    expectOne('অ্যাকাউন্ট 50100123456789', 'BANK_ACCOUNT', { obfuscated: false });
  });
  test('voter ID after "मतदाता"', () => {
    expectOne('मतदाता पहचान ABC1234567', 'VOTER_ID', { obfuscated: false });
  });
  test('passport keyword in Hindi + digits in Devanagari together', () => {
    expectOne('पासपोर्ट K१२३४५६७', 'PASSPORT');
  });
});

describe('Phase 3.5: no false alarms on normal Indian-language text', () => {
  test('Hindi sentence with Devanagari numbers', () => {
    assert.deepEqual(detect('२०२६ में बिक्री १२% बढ़ी और हमने ४ इंजीनियर रखे।'), []);
  });
  test('Bengali sentence', () => {
    assert.deepEqual(detect('আমরা কলকাতায় ৪ জন ইঞ্জিনিয়ার নিয়োগ করেছি।'), []);
  });
  test('ordinary words with o/l next to numbers are left alone', () => {
    assert.deepEqual(detect('HELLO 1, model 2O24 is cool, Iot 4 lol'), []);
  });
  test('a table column of single digits is not joined across lines', () => {
    assert.deepEqual(detect('9\n8\n7\n6\n5\n4\n3\n2\n1\n0'), []);
  });
});

describe('Phase 3.5: combined attack', () => {
  test('every trick at once: all caught, all flagged', () => {
    const text = [
      `Aadhaar २३४५ ६७८९ ०१२४`, //              Devanagari digits
      `PAN АВСРЕ1234F`, //                       Cyrillic letters
      `mail rahul${ZWSP}@abc.com`, //            invisible character
      `call 9 8 7 6 5 4 3 2 1 0`, //            spaced-out digits
    ].join('\n');
    const findings = detect(text);
    assert.deepEqual(findings.map((f) => f.type), ['AADHAAR', 'PAN', 'EMAIL', 'PHONE']);
    assert.equal(countObfuscated(findings), 4);
  });
});

describe('normalizeText internals', () => {
  test('plain ASCII text is untouched', () => {
    const n = normalizeText('Hello, rahul@abc.com 123');
    assert.equal(n.text, 'Hello, rahul@abc.com 123');
    assert.equal(n.changed, false);
  });
  test('mapSpan points back at the original characters', () => {
    const original = 'x २३४५ y';
    const n = normalizeText(original);
    const span = mapSpan(n, 2, 6);
    assert.equal(original.slice(span.start, span.end), '२३४५');
  });
  test('the vault fingerprints Devanagari and ASCII versions the SAME way (same person = same tag)', () => {
    assert.equal(normalizeForLookup('AADHAAR', '२३४५ ६७८९ ०१२४'), '234567890124');
    assert.equal(normalizeForLookup('AADHAAR', '2345 6789 0124'), '234567890124');
    assert.equal(normalizeForLookup('PAN', 'АВСРЕ1234F'), 'ABCPE1234F');
  });
});
