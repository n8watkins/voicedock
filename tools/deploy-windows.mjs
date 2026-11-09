// Deploy the built extension from this WSL repo to the Windows folder Chrome
// loads unpacked: C:\Users\<you>\Extensions\voicedock. It builds the bundles,
// then mirrors exactly the files the Chrome Web Store package ships (no React
// sources) into that folder, removing anything that no longer ships.
//
//   npm run deploy
//
// Override the folder with VOICEDOCK_WINDOWS_DIR, or the Windows user with
// VOICEDOCK_WINDOWS_USER (the older PIPER_TTS_* names still work for one // legacy-name
// release). After it runs, reload VoiceDock at chrome://extensions.
//
// An unpacked extension's ID, and with it the saved profiles, comes from its
// folder path, so keep deploying to the folder Chrome already loads.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSetting } from './env.mjs';
import { EXTENSION_DIR, storeFiles } from './package-store.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windowsUser = envSetting('WINDOWS_USER') || 'natha';
const dest = envSetting('WINDOWS_DIR') || `/mnt/c/Users/${windowsUser}/Extensions/voicedock`;

if (!existsSync(dest) || !existsSync(join(dest, 'manifest.json'))) {
  console.error(`${dest} is not an unpacked VoiceDock folder (no manifest.json).`);
  console.error('Point VOICEDOCK_WINDOWS_DIR at the folder Chrome loads (chrome://extensions, "Details", "Source").');
  process.exit(1);
}

console.log('Building bundles…');
execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });

const files = storeFiles();
const shipped = new Set(files);
for (const file of files) {
  const to = join(dest, file);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(EXTENSION_DIR, file), to);
}

// Remove what no longer ships (a deleted file, the old React sources), then
// any folder left empty.
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
let removed = 0;
for (const full of walk(dest)) {
  const rel = relative(dest, full).split(sep).join('/');
  if (!shipped.has(rel)) { rmSync(full); removed += 1; }
}
for (const dir of readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const full = join(dest, dir.name);
  if (statSync(full).isDirectory() && walk(full).length === 0) rmSync(full, { recursive: true });
}

const { version } = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
console.log(`\n✓ VoiceDock ${version}: ${files.length} files synced to ${dest}${removed ? `, ${removed} removed` : ''}.`);
console.log('  Reload it at chrome://extensions to pick up the changes.');
