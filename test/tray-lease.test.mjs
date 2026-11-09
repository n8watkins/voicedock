// The VoiceDock tray process under a fresh N8 Tray lease: it shows no icon and
// starts no Piper server. Runs the real voicedock-tray.js with its logs, pid
// files, lock, settings and the lease in a throw-away folder. It never shows an
// icon (the icon-showing path is covered by trayMode in tray-core.test.mjs and
// by the hands-on test on Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../servers/piper/tray/tray-core.js');
const TRAY = join(dirname(fileURLToPath(import.meta.url)), '..', 'servers', 'piper', 'tray', 'voicedock-tray.js');
const hasSystray = (() => { try { require.resolve('systray2', { paths: [dirname(TRAY)] }); return true; } catch { return false; } })();

const waitFor = async (check, ms = 10000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test('a fresh lease that lists VoiceDock keeps the tray hidden and Piper unstarted', { skip: !hasSystray && 'servers/piper dependencies not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voicedock-tray-lease-'));
  const env = {
    ...process.env,
    VOICEDOCK_TRAY_LOG_DIR: join(dir, 'logs'),
    LOCALAPPDATA: join(dir, 'local'), APPDATA: join(dir, 'roaming'),
    XDG_RUNTIME_DIR: join(dir, 'run'), XDG_CONFIG_HOME: join(dir, 'config'), HOME: join(dir, 'home'),
    // Nothing answers here, so a Piper start would be attempted if the tray were not hosted.
    PORT: '1',
  };
  const leaseFile = core.hostLeasePath(process.platform, env, env.HOME);
  mkdirSync(dirname(leaseFile), { recursive: true });
  // This test process plays the host: its pid is alive for the whole test.
  const writeLease = () => writeFileSync(leaseFile, JSON.stringify({
    contract: 2, host: 'n8tray', version: 'test', pid: process.pid, pidStartedAt: new Date().toISOString(),
    heartbeat: new Date().toISOString(), hosting: ['voicedock'],
  }));
  writeLease();
  const heartbeat = setInterval(writeLease, 2000);
  const child = spawn(process.execPath, [TRAY], { env, stdio: 'ignore' });
  try {
    const log = join(dir, 'logs', 'voicedock-tray.log');
    const hosted = await waitFor(() => existsSync(log) && /Hosted by n8tray/.test(readFileSync(log, 'utf8')));
    assert.ok(hosted, 'the tray logs that it is hosted');
    // Two lease checks later it is still hidden and has started nothing.
    await new Promise((r) => setTimeout(r, 6000));
    const text = readFileSync(log, 'utf8');
    assert.doesNotMatch(text, /icon shown|Started the Piper server|showing the icon/);
    assert.equal(existsSync(join(dir, 'logs', 'voicedock-piper.pid')), false, 'no Piper pid file');
    assert.equal(child.exitCode, null, 'the tray keeps running, waiting for the lease to go stale');
  } finally {
    clearInterval(heartbeat);
    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000);
    rmSync(dir, { recursive: true, force: true });
  }
});
