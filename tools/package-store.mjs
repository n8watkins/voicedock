// Builds the Chrome Web Store package: a zip of the files Chrome loads from
// extension/, without the React sources (dist/ holds their bundles).
//
//   node tools/package-store.mjs                     -> web-store/voicedock-<version>.zip
//   node tools/package-store.mjs --out release-artifacts
//
// The zip is reproducible: files are sorted and every entry gets the same
// timestamp, so the same commit always gives the same bytes (and checksum).
// Before writing, it checks the manifest against the store rules VoiceDock
// keeps: no broad host access, no content script on every site, no remote code.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION_DIR = join(repoRoot, 'extension');

// Under extension/src only shared.js ships: background.js imports it directly.
// Everything else there is JSX that esbuild bundles into dist/.
function isShipped(path) {
  if (path.startsWith('src/')) return path === 'src/shared.js';
  return true;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

export function storeFiles(extensionDir = EXTENSION_DIR) {
  return walk(extensionDir)
    .map((full) => relative(extensionDir, full).split(sep).join('/'))
    .filter((path) => !path.split('/').some((part) => part.startsWith('.')))
    .filter(isShipped)
    .sort();
}

// Files the manifest and the pages point at, which must all be in the zip.
function referencedFiles(manifest, extensionDir) {
  const refs = new Set(['manifest.json', manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page]);
  for (const path of Object.values(manifest.icons || {})) refs.add(path);
  for (const path of Object.values(manifest.action.default_icon || {})) refs.add(path);
  for (const page of ['popup.html', 'options.html', 'offscreen.html']) {
    const html = readFileSync(join(extensionDir, page), 'utf8');
    for (const [, path] of html.matchAll(/(?:src|href)="([^"]+)"/g)) refs.add(path.replace(/^\.\//, ''));
  }
  return [...refs];
}

export function checkManifest(manifest, files, extensionDir = EXTENSION_DIR) {
  const problems = [];
  const permissions = manifest.permissions || [];
  const hosts = [...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])];
  if (permissions.includes('tabs')) problems.push('the "tabs" permission is back; activeTab covers what VoiceDock needs');
  for (const host of hosts) {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/\*$/.test(host)) problems.push(`host permission ${host} is not a local engine`);
  }
  for (const script of manifest.content_scripts || []) {
    problems.push(`a declared content script (${(script.matches || []).join(', ')}); inject on demand instead`);
  }
  if (manifest.content_security_policy) problems.push('a custom content_security_policy; keep the MV3 default (no remote code)');
  for (const path of referencedFiles(manifest, extensionDir)) {
    if (!files.includes(path)) problems.push(`${path} is referenced but not in the package`);
  }
  for (const path of files.filter((p) => p.endsWith('.html'))) {
    const html = readFileSync(join(extensionDir, path), 'utf8');
    if (/<script[^>]+src="(?:https?:)?\/\//i.test(html)) problems.push(`${path} loads a remote script`);
    if (/<link[^>]+href="(?:https?:)?\/\//i.test(html)) problems.push(`${path} loads a remote stylesheet`);
  }
  for (const path of files.filter((p) => p.endsWith('.js'))) {
    const js = readFileSync(join(extensionDir, path), 'utf8');
    if (/\bimport\(\s*["'`]https?:/.test(js) || /importScripts\(\s*["'`]https?:/.test(js)) problems.push(`${path} imports remote code`);
  }
  return problems;
}

// ─── Minimal ZIP writer (deflate, fixed timestamp) ──────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 2026-01-01 00:00 in DOS time.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function buildPackage({ extensionDir = EXTENSION_DIR, outDir = join(repoRoot, 'web-store') } = {}) {
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  const files = storeFiles(extensionDir);
  const problems = checkManifest(manifest, files, extensionDir);
  if (problems.length > 0) {
    throw new Error(`Not packaging VoiceDock ${manifest.version}:\n- ${problems.join('\n- ')}`);
  }
  const archive = zip(files.map((name) => ({ name, data: readFileSync(join(extensionDir, name)) })));
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `voicedock-${manifest.version}.zip`);
  writeFileSync(outPath, archive);
  return { outPath, files, bytes: statSync(outPath).size, version: manifest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : undefined;
  try {
    const { outPath, files, bytes } = buildPackage(outDir ? { outDir } : {});
    console.log(`${relative(process.cwd(), outPath)}: ${files.length} files, ${(bytes / 1024).toFixed(1)} KB`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
