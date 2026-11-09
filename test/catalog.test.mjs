// The signed engine catalog and side-by-side installs (servers/piper/hub):
// minisign signatures, the committed catalog, refusals (tampering, another
// key, an older serial, a wrong download), then install, rollback and remove
// with a real tar archive served by a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const minisign = require('../servers/piper/hub/minisign.js');
const { loadCatalog, platformKey, PUBLIC_KEY, CATALOG_DIR } = require('../servers/piper/hub/catalog.js');
const { createInstalls } = require('../servers/piper/hub/installs.js');

const quiet = { log() {}, error() {} };

test('a minisign signature made here verifies, and any change breaks it', () => {
  const pair = minisign.generateKeyPair();
  const pub = minisign.publicKeyFile(pair);
  const data = Buffer.from('{"serial":1}');
  const sig = minisign.sign(data, minisign.parseSecretKey(minisign.secretKeyFile(pair)), { trustedComment: 'serial:1 x' });
  assert.equal(minisign.verify(data, sig, pub).trustedComment, 'serial:1 x');
  assert.throws(() => minisign.verify(Buffer.from('{"serial":2}'), sig, pub), /does not match/);
  assert.throws(() => minisign.verify(data, sig.replace('serial:1 x', 'serial:9 x'), pub), /trusted comment/);
  assert.throws(() => minisign.verify(data, sig, minisign.publicKeyFile(minisign.generateKeyPair())), /different key/);
});

test('a signature made by the minisign tool (0.12) verifies here', () => {
  // minisign -G -W, then minisign -S -m msg.txt -t 'interop serial:1 '.
  const pub = 'untrusted comment: minisign public key C1516460F498E7C5\nRWTF55j0YGRRwcjB/5id2w6Kk5aSDr0i16h1eIfDQ++LV/xweZTxHuWM\n';
  const sig = 'untrusted comment: signature from minisign secret key\nRUTF55j0YGRRwdyCqHQmGHspGbZXjiac/LCjXCu1cIiMVWk03GMzo/Y9X/LDzi7m0EHTqKFPUdbUWWm888TNA0+zJuOASUiYYgw=\ntrusted comment: interop serial:1 \nBWJSVbJnZcADgpduu9evZYEVp1W/AJN4AkErI7N1emTpf2mmTGUzW4hl/0+kMJPmkgOVDRkVBjMwvz4/4AbLBA==\n';
  assert.equal(minisign.verify(Buffer.from('VoiceDock interop check\n'), sig, pub).trustedComment, 'interop serial:1 ');
  assert.throws(() => minisign.verify(Buffer.from('VoiceDock interop check!\n'), sig, pub));
});

test('the committed catalog is signed with the built-in key, and lists Pocket TTS for every OS', () => {
  const c = loadCatalog();
  assert.equal(readFileSync(join(CATALOG_DIR, 'voicedock-catalog.pub'), 'utf8'), PUBLIC_KEY);
  const pocket = c.engines.pocket.versions[0];
  for (const key of ['windows-x64', 'linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64']) {
    assert.match(pocket.program[key].sha256, /^[0-9a-f]{64}$/, key);
    assert.match(pocket.program[key].url, /^https:\/\/github\.com\/kyutai-labs\/pocket-tts\/releases\/download\//);
  }
  assert.equal(pocket.model.voices.length, 26);
  assert.equal(c.engines.pocket.license.model, 'CC-BY-4.0');
  assert.throws(() => loadCatalog({ minSerial: c.serial + 1 }), /older/);
});

test("Git never changes the catalog's line endings, and a CRLF copy says why it fails", () => {
  for (const file of ['engines.json', 'engines.json.minisig', 'voicedock-catalog.pub']) {
    const out = execFileSync('git', ['check-attr', 'text', `servers/catalog/${file}`], { encoding: 'utf8' });
    assert.match(out, /text: unset/, file);
  }
  const dir = mkdtempSync(join(tmpdir(), 'vd-crlf-'));
  writeFileSync(join(dir, 'engines.json'), readFileSync(join(CATALOG_DIR, 'engines.json'), 'utf8').replace(/\n/g, '\r\n'));
  writeFileSync(join(dir, 'engines.json.minisig'), readFileSync(join(CATALOG_DIR, 'engines.json.minisig')));
  assert.throws(() => loadCatalog({ dir }), /CRLF/);
});

test('platform keys', () => {
  assert.equal(platformKey('win32', 'x64'), 'windows-x64');
  assert.equal(platformKey('darwin', 'arm64'), 'macos-arm64');
  assert.equal(platformKey('linux', 'ia32'), null);
});

// ─── Installs ───────────────────────────────────────────────────────────────
function fixture({ versions }) {
  const root = mkdtempSync(join(tmpdir(), 'vd-catalog-'));
  const pair = minisign.generateKeyPair();
  const secret = minisign.parseSecretKey(minisign.secretKeyFile(pair));
  const archives = new Map();
  const releases = versions.map((v) => {
    const src = join(root, 'src', v);
    mkdirSync(join(src, `tool-${v}`), { recursive: true });
    writeFileSync(join(src, `tool-${v}`, 'tool'), `#!/bin/sh\necho ${v}\n`);
    writeFileSync(join(src, `tool-${v}`, 'LICENSE'), 'MIT');
    const archive = join(root, `tool-${v}.tar.gz`);
    execFileSync('tar', ['-czf', archive, '-C', src, `tool-${v}`]);
    const bytes = readFileSync(archive);
    const url = `https://example.test/tool-${v}.tar.gz`;
    archives.set(url, bytes);
    const art = { url, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, format: 'tar.gz', program: `tool-${v}/tool`, license: `tool-${v}/LICENSE` };
    return { version: v, program: { [platformKey()]: art } };
  });
  const catalogDir = join(root, 'catalog');
  mkdirSync(catalogDir);
  const write = (catalog) => {
    const data = Buffer.from(JSON.stringify(catalog));
    writeFileSync(join(catalogDir, 'engines.json'), data);
    writeFileSync(join(catalogDir, 'engines.json.minisig'), minisign.sign(data, secret, { trustedComment: `voicedock-catalog serial:${catalog.serial} issued:x` }));
  };
  const catalog = { catalog: 1, serial: 3, issuedAt: 'x', engines: { tool: { name: 'Tool', versions: releases } } };
  write(catalog);
  const fetchImpl = async (url) => {
    const bytes = archives.get(url);
    if (!bytes) return new Response('no', { status: 404 });
    return new Response(bytes);
  };
  const installs = createInstalls({ dir: join(root, 'engines'), catalogOptions: { dir: catalogDir, publicKey: minisign.publicKeyFile(pair) }, fetchImpl, log: quiet });
  return { root, installs, catalog, write, archives };
}

test('installs side by side, switches, rolls back and removes', async () => {
  const f = fixture({ versions: ['2.0', '1.0'] });
  assert.equal(f.installs.program('tool'), null);
  const first = await f.installs.install('tool', { version: '1.0' });
  assert.equal(first.already, false);
  assert.equal(f.installs.program('tool').version, '1.0');
  assert.equal(readFileSync(join(first.dir, 'LICENSE'), 'utf8'), 'MIT');

  await f.installs.install('tool'); // newest
  assert.deepEqual(f.installs.state('tool'), { current: '2.0', previous: '1.0' });
  assert.match(readFileSync(f.installs.program('tool').file, 'utf8'), /echo 2\.0/);
  assert.deepEqual(f.installs.installed('tool').map((v) => v.version).sort(), ['1.0', '2.0']);

  assert.equal((await f.installs.install('tool')).already, true, 'same version again downloads nothing');

  f.installs.rollback('tool');
  assert.deepEqual(f.installs.state('tool'), { current: '1.0', previous: '2.0' });
  assert.throws(() => f.installs.remove('tool', '1.0'), /in use/);
  f.installs.remove('tool', '2.0');
  assert.equal(existsSync(f.installs.versionDir('tool', '2.0')), false);
  assert.deepEqual(f.installs.state('tool'), { current: '1.0', previous: null });
  assert.throws(() => f.installs.rollback('tool'), /No earlier/);
});

test('a download that does not match the catalog is refused and leaves nothing behind', async () => {
  const f = fixture({ versions: ['1.0'] });
  const url = f.catalog.engines.tool.versions[0].program[platformKey()].url;
  const good = f.archives.get(url);
  f.archives.set(url, Buffer.concat([good.subarray(0, good.length - 1), Buffer.from([good[good.length - 1] ^ 1])]));
  await assert.rejects(f.installs.install('tool'), /SHA-256/);
  assert.equal(f.installs.program('tool'), null);
  assert.deepEqual(f.installs.installed('tool'), []);
});

test('a tampered catalog, or one older than the last used, installs nothing', async () => {
  const f = fixture({ versions: ['1.0'] });
  await f.installs.install('tool');
  // Older serial, validly signed: a replay of an old catalog.
  f.write({ ...f.catalog, serial: 2 });
  await assert.rejects(f.installs.install('tool'), /older/);
  // Edited after signing.
  const file = join(f.root, 'catalog', 'engines.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"Tool"', '"Toal"'));
  await assert.rejects(f.installs.install('tool'), /signature is not valid/);
});

test('engine and version names cannot leave the engines folder', () => {
  const f = fixture({ versions: ['1.0'] });
  assert.throws(() => f.installs.use('tool', '../x'), /Not a version/);
  assert.throws(() => f.installs.state('../x'), /Not an engine/);
});
