// Tests for the browser extension's tag restoring (extension/tag-restore.js).
// The file is a plain browser script, so we load it with Node's "vm" module.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', '..', 'extension', 'tag-restore.js'), 'utf8');
const context = {};
vm.runInNewContext(`${source}\nthis.SafeAiTagRestore = SafeAiTagRestore;`, context);
const { findTags, restore } = context.SafeAiTagRestore;

const VALUES = {
  '[[EMAIL_1]]': 'rahul@gmail.com',
  '[[PERSON_1]]': 'Rahul Verma',
  '[[PAN_1]]': 'ABCPE1234F',
};
const lookup = (tag) => VALUES[tag];

/** Text pieces like a page's text nodes. */
const pieces = (...texts) => texts.map((nodeValue) => ({ nodeValue }));
const joined = (ps) => ps.map((p) => p.nodeValue).join('');

describe('extension: restoring tags on the page', () => {
  test('a tag inside one piece', () => {
    const ps = pieces('Send it to [[EMAIL_1]] today');
    assert.equal(restore(ps, lookup), 1);
    assert.equal(joined(ps), 'Send it to rahul@gmail.com today');
  });

  test('a tag SPLIT across two pieces (how ChatGPT streams replies)', () => {
    const ps = pieces('Sure. I can email the receipt to [[EMAIL', '_1]].');
    // [...] copies the array out of the vm sandbox (arrays from another "realm" never compare equal)
    assert.deepEqual([...findTags(ps)], ['[[EMAIL_1]]']);
    restore(ps, lookup);
    assert.equal(joined(ps), 'Sure. I can email the receipt to rahul@gmail.com.');
  });

  test('a tag split into many pieces, e.g. "[" "[" "EMAIL_1" "]" "]"', () => {
    const ps = pieces('to ', '[', '[', 'EMAIL_1', ']', ']', '.');
    restore(ps, lookup);
    assert.equal(joined(ps), 'to rahul@gmail.com.');
  });

  test('several tags, some split, in one reply', () => {
    const ps = pieces('Dear [[PERSON', '_1]], your PAN [[PAN_1]] and email [[', 'EMAIL_1]] are noted.');
    assert.equal(restore(ps, lookup), 3);
    assert.equal(joined(ps), 'Dear Rahul Verma, your PAN ABCPE1234F and email rahul@gmail.com are noted.');
  });

  test('empty pieces in between are handled', () => {
    const ps = pieces('x ', '', '[[PAN', '', '_1]]', '', ' y');
    restore(ps, lookup);
    assert.equal(joined(ps), 'x ABCPE1234F y');
  });

  test('unknown tags (other chat / expired) are left untouched', () => {
    const ps = pieces('Old: [[EMAIL_9]] and new: [[EMAIL', '_1]]');
    assert.equal(restore(ps, lookup), 1);
    assert.equal(joined(ps), 'Old: [[EMAIL_9]] and new: rahul@gmail.com');
  });

  test('text without tags is not changed at all', () => {
    const ps = pieces('Nothing ', 'to [restore] here.');
    assert.equal(restore(ps, lookup), 0);
    assert.equal(joined(ps), 'Nothing to [restore] here.');
  });
});
