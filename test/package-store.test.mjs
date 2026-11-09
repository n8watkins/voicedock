// The Chrome Web Store package: the right files, the store rules VoiceDock
// keeps (no broad hosts, no content script on every site, no remote code), and
// a zip Chrome can read back byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { buildPackage, checkManifest, EXTENSION_DIR, storeFiles } from '../tools/package-store.mjs';

function unzip(buf) {
  const files = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const size = buf.readUInt32LE(at + 18);
    const nameLength = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    const body = buf.subarray(start, start + size);
    files[name] = method === 8 ? inflateRawSync(body) : body;
    at = start + size;
  }
  return files;
}

test('the package has what Chrome loads and none of the React sources', () => {
  const files = storeFiles();
  for (const path of ['manifest.json', 'background.js', 'content.js', 'offscreen.html', 'offscreen.js',
    'popup.html', 'options.html', 'dist/popup.js', 'dist/options.js', 'src/shared.js', 'icons/icon128.png']) {
    assert.ok(files.includes(path), `${path} is packaged`);
  }
  assert.deepEqual(files.filter((p) => p.endsWith('.jsx')), []);
});

test('the current manifest passes the store checks', () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  assert.deepEqual(checkManifest(manifest, storeFiles()), []);
});

test('the store checks catch tabs, broad hosts and content scripts on every site', () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  const bad = {
    ...manifest,
    permissions: [...manifest.permissions, 'tabs'],
    host_permissions: ['<all_urls>'],
    content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }],
  };
  const problems = checkManifest(bad, storeFiles());
  assert.equal(problems.length, 3, problems.join('\n'));
});

test('the zip holds every file unchanged, and building twice gives the same bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voicedock-package-'));
  try {
    const first = buildPackage({ outDir: join(dir, 'a') });
    const second = buildPackage({ outDir: join(dir, 'b') });
    const bytes = readFileSync(first.outPath);
    assert.ok(bytes.equals(readFileSync(second.outPath)), 'reproducible');
    const files = unzip(bytes);
    assert.deepEqual(Object.keys(files), first.files);
    for (const name of first.files) {
      assert.ok(files[name].equals(readFileSync(join(EXTENSION_DIR, name))), `${name} round-trips`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
