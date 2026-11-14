import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detect, resolveOverlaps, summarize, MAX_TEXT_LENGTH } from '../src/detectors/index.js';
import { verhoeffValidate, verhoeffCheckDigit } from '../src/detectors/aadhaar.js';
import { shannonEntropy } from '../src/detectors/entropy.js';

// Fake credentials are assembled from pieces so secret scanners (e.g. GitHub push protection)
// don't mistake this test file for a real leak.
const j = (...parts) => parts.join('');
const FAKE = {
  aws: 'AKIAIOSFODNN7EXAMPLE', // AWS's own documentation example
  github: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  openai: j('sk-', 'proj-', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1w'),
  anthropic: j('sk-', 'ant-', 'api03-', 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2'),
  stripe: j('sk', '_live_', '51HxAbCdEfGhIjKlMn0pQrStUv'),
  razorpay: j('rzp', '_test_', 'Ab12Cd34Ef56Gh'),
  google: j('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  slack: j('xo', 'xb-', '1234567890-abcdefghij'),
  groq: j('gs', 'k_', 'Ab12Cd34Ef56Gh78Ij90Kl12'),
};

/** Values detected as `type` in `text`. */
const found = (text, type) => detect(text).filter((f) => f.type === type).map((f) => f.value);

/** Builds a valid Aadhaar number from an 11-digit prefix (first digit 2-9). */
const aadhaar = (prefix11) => prefix11 + verhoeffCheckDigit(prefix11);

describe('EMAIL', () => {
  test('finds normal and tricky emails', () => {
    assert.deepEqual(found('Mail rahul@abc.com now', 'EMAIL'), ['rahul@abc.com']);
    assert.deepEqual(found('cc: priya.sharma+hr@mail.company.co.in.', 'EMAIL'), ['priya.sharma+hr@mail.company.co.in']);
    assert.deepEqual(found('<a@b.io>, x_y-z@sub.domain.org', 'EMAIL'), ['a@b.io', 'x_y-z@sub.domain.org']);
  });
  test('ignores things that are not emails', () => {
    assert.deepEqual(found('ping @rahul on slack', 'EMAIL'), []);
    assert.deepEqual(found('user@localhost', 'EMAIL'), []);
    assert.deepEqual(found('price is 5@ 10 rupees', 'EMAIL'), []);
  });
});

describe('PHONE', () => {
  test('finds Indian mobiles in common formats', () => {
    assert.deepEqual(found('Call +91 98765 43210', 'PHONE'), ['+91 98765 43210']);
    assert.deepEqual(found('mob: 9876543210.', 'PHONE'), ['9876543210']);
    assert.deepEqual(found('+91-9876543210', 'PHONE'), ['+91-9876543210']);
  });
  test('finds Indian landlines and international numbers', () => {
    assert.deepEqual(found('office 080-2345-6789', 'PHONE'), ['080-2345-6789']);
    assert.deepEqual(found('US +1 650-253-0000', 'PHONE'), ['+1 650-253-0000']);
    assert.deepEqual(found('UK +44 20 7031 3000', 'PHONE'), ['+44 20 7031 3000']);
  });
  test('ignores order numbers, years, dates, PIN codes and amounts', () => {
    const text = 'Order #12345 in 2026 on 14-11-2026, PIN 700001, amount 1500000, v1.2.3';
    assert.deepEqual(found(text, 'PHONE'), []);
  });
});

describe('PAN', () => {
  test('finds valid PANs, upper or lower case', () => {
    assert.deepEqual(found('PAN: ABCPE1234F', 'PAN'), ['ABCPE1234F']);
    assert.deepEqual(found('pan abcpe1234f', 'PAN'), ['abcpe1234f']);
    assert.deepEqual(found('company AAACR5055K.', 'PAN'), ['AAACR5055K']);
  });
  test('rejects an invalid 4th letter (holder type)', () => {
    // D is not a valid holder type (P, C, H, F, A, T, B, L, J, G).
    assert.deepEqual(found('ABCDE1234F', 'PAN'), []);
  });
  test('ignores PAN-shaped text inside longer words', () => {
    assert.deepEqual(found('XABCPE1234F', 'PAN'), []);
    assert.deepEqual(found('ABCPE1234FX', 'PAN'), []);
  });
});

describe('AADHAAR (Verhoeff)', () => {
  test('Verhoeff matches the published test vector (236 → 3)', () => {
    assert.equal(verhoeffCheckDigit('236'), '3');
    assert.equal(verhoeffValidate('2363'), true);
    assert.equal(verhoeffValidate('2364'), false);
  });
  test('Verhoeff catches every single-digit typo', () => {
    const valid = aadhaar('23456789012');
    for (let i = 0; i < valid.length; i++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === valid[i]) continue;
        const typo = valid.slice(0, i) + d + valid.slice(i + 1);
        assert.equal(verhoeffValidate(typo), false, `typo at ${i} not caught: ${typo}`);
      }
    }
  });
  test('finds valid Aadhaar numbers in all common formats', () => {
    const n = aadhaar('23456789012');
    const spaced = `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`;
    const dashed = spaced.replaceAll(' ', '-');
    assert.deepEqual(found(`Aadhaar ${n}`, 'AADHAAR'), [n]);
    assert.deepEqual(found(`Aadhaar: ${spaced}.`, 'AADHAAR'), [spaced]);
    assert.deepEqual(found(`UID ${dashed}`, 'AADHAAR'), [dashed]);
  });
  test('rejects wrong checksum, bad first digit, mixed separators and longer numbers', () => {
    const n = aadhaar('23456789012');
    const wrong = n.slice(0, 11) + ((Number(n[11]) + 1) % 10);
    assert.deepEqual(found(wrong, 'AADHAAR'), []);
    assert.deepEqual(found(aadhaar('13456789012'), 'AADHAAR'), []); // Aadhaar never starts with 0/1
    assert.deepEqual(found(`${n.slice(0, 4)} ${n.slice(4, 8)}-${n.slice(8)}`, 'AADHAAR'), []);
    assert.deepEqual(found(`9${n}`, 'AADHAAR'), []);
  });
  test('a valid Aadhaar is reported as AADHAAR, not PHONE', () => {
    const n = aadhaar('98765432101');
    const types = detect(`id ${n}`).map((f) => f.type);
    assert.deepEqual(types, ['AADHAAR']);
  });
});

describe('API_KEY', () => {
  for (const [provider, key] of Object.entries(FAKE)) {
    test(`finds ${provider} key`, () => {
      const findings = detect(`const key = "${key}";`);
      assert.equal(findings.length, 1, JSON.stringify(findings));
      assert.equal(findings[0].type, 'API_KEY');
      assert.equal(findings[0].value, key);
    });
  }
  test('labels the provider', () => {
    assert.equal(detect(FAKE.aws)[0].label, 'AWS');
    assert.equal(detect(FAKE.anthropic)[0].label, 'Anthropic');
    assert.equal(detect(FAKE.openai)[0].label, 'OpenAI');
  });
  test('ignores look-alikes', () => {
    assert.deepEqual(detect('pip install scikit-learn sk-learn'), []);
    assert.deepEqual(detect('risk-assessment-framework-for-2026-q3'), []);
    assert.deepEqual(detect('AKIA is the AWS prefix'), []);
  });
});

describe('PRIVATE_KEY', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dV';
  test('finds a full PEM block', () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
    assert.deepEqual(found(`key:\n${pem}\nthanks`, 'PRIVATE_KEY'), [pem]);
  });
  test('finds RSA/EC/OPENSSH variants', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    assert.deepEqual(found(pem, 'PRIVATE_KEY'), [pem]);
  });
  test('finds a key that was cut off before END', () => {
    const partial = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`;
    assert.deepEqual(found(partial, 'PRIVATE_KEY'), [partial]);
  });
  test('ignores public keys and certificates', () => {
    assert.deepEqual(found('-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----', 'PRIVATE_KEY'), []);
  });
});

describe('JWT', () => {
  const jwt = j(
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  );
  test('finds a JWT', () => {
    assert.deepEqual(found(`token ${jwt} expired`, 'JWT'), [jwt]);
  });
  test('rejects JWT-shaped text whose header is not JSON with alg', () => {
    const fake = j('eyJub3RhbGciOjF9', '.eyJzdWIiOiIxIn0', '.abcdefghijklmnop'); // header {"notalg":1}
    assert.deepEqual(found(fake, 'JWT'), []);
  });
});

describe('SECRET (assigned, bearer, connection strings)', () => {
  test('masks the value of sensitive assignments, not the name', () => {
    assert.deepEqual(found('DB_PASSWORD=Sup3rS3cret!', 'SECRET'), ['Sup3rS3cret!']);
    assert.deepEqual(found('{"apiKey": "abcd1234efgh"}', 'SECRET'), ['abcd1234efgh']);
    assert.deepEqual(found("client_secret: 'q1w2e3r4t5'", 'SECRET'), ['q1w2e3r4t5']);
  });
  test('does not mask references to secrets', () => {
    assert.deepEqual(found('apiKey = process.env.API_KEY', 'SECRET'), []);
    assert.deepEqual(found('password: ********', 'SECRET'), []);
    assert.deepEqual(found('token: ${TOKEN}', 'SECRET'), []);
    assert.deepEqual(found('max_tokens: 1000000', 'SECRET'), []);
  });
  test('masks bearer tokens from curl commands', () => {
    assert.deepEqual(found('-H "Authorization: Bearer abc123def456ghi789"', 'SECRET'), ['abc123def456ghi789']);
  });
  test('masks whole database URIs that contain a password', () => {
    const uri = 'mongodb+srv://admin:Pa55w0rdXYZ@cluster0.ab12c.mongodb.net/shop';
    const findings = detect(`MONGO=${uri} done`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, 'SECRET');
    assert.equal(findings[0].value, uri);
    assert.deepEqual(found('postgres://app:hunter2@db.internal:5432/main', 'SECRET'), [
      'postgres://app:hunter2@db.internal:5432/main',
    ]);
  });
  test('leaves URIs without passwords alone', () => {
    assert.deepEqual(detect('mongodb://localhost:27017/test'), []);
  });
});

describe('SECRET (high entropy)', () => {
  test('entropy math', () => {
    assert.equal(shannonEntropy('aaaa'), 0);
    assert.equal(shannonEntropy('abcd'), 2);
  });
  test('finds random-looking tokens with no known format', () => {
    assert.deepEqual(found('webhook q8Zt3LmX9vPa2RbK7wYc4NdF here', 'SECRET'), ['q8Zt3LmX9vPa2RbK7wYc4NdF']);
    assert.deepEqual(found('hmac 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'SECRET'), [
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    ]);
  });
  test('ignores long words, identifiers, UUIDs, git hashes and paths', () => {
    const text = [
      'internationalization',
      'this_is_a_very_long_snake_case_name',
      'id 123e4567-e89b-12d3-a456-426614174000',
      'commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a',
      'src/components/dashboard/UserProfileCard.jsx',
    ].join('\n');
    assert.deepEqual(detect(text), []);
  });
});

describe('detect(): combined behaviour', () => {
  test('a realistic leaky prompt', () => {
    const n = aadhaar('34567890123');
    const text = [
      'Hi, please draft a refund email for customer Rahul (rahul.verma@gmail.com, +91 98765 43210).',
      `His PAN is ABCPE1234F and Aadhaar ${n}.`,
      `Our Stripe key is ${FAKE.stripe} and DB is mongodb+srv://admin:Pa55w0rdXYZ@cluster0.ab12c.mongodb.net/shop`,
    ].join('\n');
    assert.deepEqual(summarize(detect(text)), { EMAIL: 1, PHONE: 1, PAN: 1, AADHAAR: 1, API_KEY: 1, SECRET: 1 });
  });
  test('every finding points at its exact position in the text', () => {
    const text = `a@b.co ABCPE1234F ${FAKE.aws} 9876543210 ${aadhaar('45678901234')}`;
    for (const f of detect(text)) assert.equal(text.slice(f.start, f.end), f.value);
  });
  test('findings are sorted and never overlap', () => {
    const text = `x ${FAKE.github} rahul@abc.com 9876543210 key=${FAKE.openai}`;
    const fs = detect(text);
    for (let i = 1; i < fs.length; i++) assert.ok(fs[i - 1].end <= fs[i].start);
  });
  test('clean text returns nothing', () => {
    const text = 'Please summarise our Q3 sales meeting: revenue grew 12% and we hired 4 engineers in Kolkata.';
    assert.deepEqual(detect(text), []);
  });
  test('handles empty and non-string input', () => {
    assert.deepEqual(detect(''), []);
    assert.deepEqual(detect(undefined), []);
    assert.deepEqual(detect(42), []);
  });
  test('rejects text over the size limit', () => {
    assert.throws(() => detect('a'.repeat(MAX_TEXT_LENGTH + 1)), RangeError);
  });
});

describe('resolveOverlaps()', () => {
  test('longer finding wins (fail safe: mask more)', () => {
    const out = resolveOverlaps([
      { type: 'PHONE', start: 5, end: 15, value: '' },
      { type: 'SECRET', start: 0, end: 30, value: '' },
    ]);
    assert.deepEqual(out.map((f) => f.type), ['SECRET']);
  });
  test('same length: more specific type wins', () => {
    const out = resolveOverlaps([
      { type: 'SECRET', start: 0, end: 20, value: '' },
      { type: 'API_KEY', start: 0, end: 20, value: '' },
    ]);
    assert.deepEqual(out.map((f) => f.type), ['API_KEY']);
  });
});
