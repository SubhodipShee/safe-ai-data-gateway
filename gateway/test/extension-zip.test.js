// The shareable extension zip (download/safe-ai-gateway-extension.zip) must match the
// extension folder. If this fails, someone changed the extension and forgot to run:
//   npm run zip-extension     (then commit and push the new zip)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildExtensionZip, outputFile } from '../scripts/zip-extension.js';

test('the zip in download/ is up to date with the extension folder', () => {
  assert.ok(fs.existsSync(outputFile), 'download/safe-ai-gateway-extension.zip is missing: run npm run zip-extension');
  assert.ok(
    buildExtensionZip().equals(fs.readFileSync(outputFile)),
    'The extension changed but the zip did not: run npm run zip-extension, then commit and push',
  );
});
