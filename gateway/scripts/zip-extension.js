// =============================================================================
// zip-extension.js: packs the browser extension into one zip file to share
// =============================================================================
//
// Run (from the gateway folder):   npm run zip-extension
// Creates:                         download/safe-ai-gateway-extension.zip
//
// The zip is kept in the GitHub repo, so anyone can download it straight away:
// https://github.com/SubhodipShee/safe-ai-data-gateway/raw/main/download/safe-ai-gateway-extension.zip
// Run this again after every change to the extension, then commit and push.
//
// No zip library is needed: a zip file is simple enough to write by hand.
// Each file = a "local header" + its compressed bytes; at the end comes a
// "central directory" (the table of contents) and an end record.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionFolder = path.join(projectRoot, 'extension');
export const outputFile = path.join(projectRoot, 'download', 'safe-ai-gateway-extension.zip');
const FOLDER_IN_ZIP = 'safe-ai-gateway-extension/'; // people "Load unpacked" this folder
const COMMENT = 'Safe AI Gateway (c) 2026 Subhodip Shee. All rights reserved. See LICENSE.txt.';

/** Every file in a folder (and its subfolders), as paths relative to that folder. */
function listFiles(folder, prefix = '') {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    return entry.isDirectory()
      ? listFiles(path.join(folder, entry.name), relative + '/')
      : [relative];
  }).sort();
}

/** Builds the zip in memory. The same files always give exactly the same bytes. */
export function buildExtensionZip() {
  const localParts = [];
  const directoryParts = [];
  let offset = 0;

  for (const relative of listFiles(extensionFolder)) {
    // Text files are packed with Unix line endings (LF), the same as GitHub stores them,
    // so the zip comes out identical on Windows and anywhere else.
    const raw = fs.readFileSync(path.join(extensionFolder, relative));
    const isText = /\.(js|json|html|css|md|txt|svg)$/.test(relative);
    const content = isText ? Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : raw;
    const compressed = deflateRawSync(content, { level: 9 });
    const name = Buffer.from(FOLDER_IN_ZIP + relative, 'utf8');
    const checksum = crc32(content);

    // Local file header (30 bytes + name). Date/time fields are left at zero, so the
    // zip is identical every time it's built from the same files.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature "PK\3\4"
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(0x0800, 6); // flag: names are UTF-8
    local.writeUInt16LE(8, 8); // compression: deflate
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    // Matching entry in the central directory (46 bytes + name).
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); // signature "PK\1\2"
    entry.writeUInt16LE(20, 4); // made by version 2.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(content.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42); // where this file's local header starts
    directoryParts.push(entry, name);

    offset += local.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(directoryParts);
  const comment = Buffer.from(COMMENT, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // signature "PK\5\6"
  end.writeUInt16LE(directoryParts.length / 2, 8); // files in this zip
  end.writeUInt16LE(directoryParts.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16); // where the central directory starts
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...localParts, directory, end, comment]);
}

// Write the file only when run directly (npm run zip-extension), not when a test imports this.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, buildExtensionZip());

  const { version } = JSON.parse(fs.readFileSync(path.join(extensionFolder, 'manifest.json'), 'utf8'));
  const sizeKb = (fs.statSync(outputFile).size / 1024).toFixed(0);
  console.log(`✔ download/safe-ai-gateway-extension.zip: extension v${version}, ${sizeKb} KB`);
  console.log('  Next: commit and push it, so the download link on GitHub has this version.');
}
