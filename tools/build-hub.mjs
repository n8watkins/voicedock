#!/usr/bin/env node
// Builds the VoiceDock hub as one executable for this OS (a Node single
// executable application), so people can run it without installing Node:
//
//   node tools/build-hub.mjs            build servers/piper/voicedock-hub(.exe)
//   node tools/build-hub.mjs --smoke    build, then start it and check /health and /engines
//
// 1. esbuild bundles servers/piper/hub-main.js and everything it requires
//    (Express included) into one CommonJS file.
// 2. Node turns that into a blob (--experimental-sea-config), and postject
//    injects it into a copy of this Node binary.
// 3. macOS: the copy is signed again (ad hoc), as the injection breaks
//    Node's signature.
//
// The executable is written into servers/piper, beside server.js, because
// the hub finds Piper, Kokoro, the catalog and installed engines from there.
// CI builds it on Windows, macOS and Linux (.github/workflows/hub-binaries.yml).
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piperDir = join(root, 'servers', 'piper');
const work = join(root, 'build', 'hub');
const isWin = process.platform === 'win32';
const exe = join(piperDir, isWin ? 'voicedock-hub.exe' : 'voicedock-hub');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

console.log('Bundling the hub…');
await build({
  entryPoints: [join(piperDir, 'hub-main.js')],
  outfile: join(work, 'voicedock-hub.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning',
});

writeFileSync(join(work, 'sea-config.json'), JSON.stringify({
  main: join(work, 'voicedock-hub.cjs'),
  output: join(work, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
}));
execFileSync(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')], { stdio: 'inherit' });

console.log(`Writing ${exe}…`);
rmSync(exe, { force: true });
copyFileSync(process.execPath, exe);
if (!isWin) chmodSync(exe, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const args = [postject, exe, 'NODE_SEA_BLOB', join(work, 'sea-prep.blob'), '--sentinel-fuse', FUSE];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
console.log(`Built ${exe} (${(statSync(exe).size / 1e6).toFixed(0)} MB)`);

if (process.argv.includes('--smoke')) {
  // Start it on a spare port with its own runtime folder, and time how long
  // it takes to answer (plan: budget 1 s; printed, not enforced, as shared
  // CI runners vary too much to fail a build on it).
  const port = 7577;
  const runDir = mkdtempSync(join(tmpdir(), 'vd-hub-run-'));
  const started = Date.now();
  const proc = spawn(exe, [], { cwd: piperDir, env: { ...process.env, PORT: String(port), KOKORO_PORT: '7578', N8TRAY_RUN_DIR: runDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', (c) => { output += c; });
  proc.stderr.on('data', (c) => { output += c; });
  try {
    let health = null;
    for (let i = 0; i < 100 && !health; i++) {
      health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
      if (!health) await new Promise((r) => setTimeout(r, 100));
    }
    if (!health) throw new Error(`The hub did not answer within 10 s:\n${output}`);
    const ms = Date.now() - started;
    const engines = await (await fetch(`http://127.0.0.1:${port}/engines`)).json();
    const ids = engines.engines.map((e) => e.id).join(', ');
    if (health.api !== 2 || ids !== 'piper, kokoro, pocket') throw new Error(`Unexpected answers: api ${health.api}, engines ${ids}`);
    const manifest = JSON.parse(execFileSync(exe, ['manifest', 'print'], { cwd: piperDir, encoding: 'utf8' }));
    if (!manifest.run.program?.startsWith('piper/voicedock-hub')) throw new Error(`The manifest does not run the executable: ${JSON.stringify(manifest.run)}`);
    const catalog = execFileSync(exe, ['engines', 'catalog'], { cwd: piperDir, encoding: 'utf8' });
    if (!/signature OK/.test(catalog)) throw new Error(`The engine catalog did not verify:\n${catalog}`);
    console.log(`Smoke test passed: /health in ${ms} ms (version ${health.version}, app ${health.appVersion}), engines ${ids}, manifest and catalog OK.`);
  } finally {
    proc.kill();
    rmSync(runDir, { recursive: true, force: true });
  }
}
