// VoiceDock tray helpers (servers/piper/tray/tray-core.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const core = require('../servers/piper/tray/tray-core.js');

const PIPER = { status: 'ok', engine: 'piper', rssMb: 22.4, totalRssMb: 22.4, speaking: false };
const KOKORO = { status: 'ok', engine: 'kokoro', rssMb: 46.9, modelLoaded: false };

test('Piper status shows memory, external servers and reading', () => {
  assert.equal(core.piperStatusText(PIPER, true), 'Piper: Running · 22 MB');
  assert.equal(core.piperStatusText(PIPER, false), 'Piper: Running (external) · 22 MB');
  assert.equal(core.piperStatusText({ ...PIPER, totalRssMb: 108.6, speaking: true, activeVoice: 'en_US-ryan-high.onnx' }, true),
    'Piper: Running · 109 MB, reading');
  assert.equal(core.piperStatusText({ status: 'ok' }, true), 'Piper: Running', 'old server without memory fields');
  assert.equal(core.piperStatusText(null, false), 'Piper: Stopped');
});

test('Kokoro status is running, not installed or not running (starts on demand)', () => {
  assert.equal(core.kokoroStatusText(KOKORO, true), 'Kokoro: Running · 47 MB (model unloaded)');
  assert.equal(core.kokoroStatusText({ ...KOKORO, rssMb: 581.2, modelLoaded: true }, true), 'Kokoro: Running · 581 MB (model loaded)');
  assert.equal(core.kokoroStatusText({ status: 'ok' }, true), 'Kokoro: Running');
  assert.equal(core.kokoroStatusText(null, false), 'Kokoro: Not installed (optional)');
  assert.equal(core.kokoroStatusText(null, true), 'Kokoro: Not running (starts when you read)');
});

test('a Piper server is only ours while our child runs or /health reports the recorded pid', () => {
  assert.equal(core.isManagedServer({ ownChildAlive: true }), true, 'starting, not answering yet');
  assert.equal(core.isManagedServer({ filePid: 4242, health: { ...PIPER, pid: 4242 } }), true, 'started by an earlier tray run');
  assert.equal(core.isManagedServer({ filePid: 4242, health: null }), false, 'pid file names a reused pid while Piper is down');
  assert.equal(core.isManagedServer({ filePid: 4242, health: { ...PIPER, pid: 999 } }), false, 'another server answers');
  assert.equal(core.isManagedServer({ filePid: 4242, health: { status: 'ok' } }), false, 'a server without a pid field');
  assert.equal(core.isManagedServer(), false);
});

test('the tooltip names both engines and stays within the Windows limit', () => {
  assert.equal(core.tooltipText(PIPER, KOKORO, true), 'VoiceDock | Piper 22 MB · Kokoro 47 MB (model unloaded)');
  assert.equal(core.tooltipText(null, null, false), 'VoiceDock | Piper stopped');
  assert.equal(core.tooltipText(PIPER, null, true), 'VoiceDock | Piper 22 MB · Kokoro off until a read');
  const long = core.tooltipText({ ...PIPER, totalRssMb: 1e12, speaking: true, activeVoice: 'x'.repeat(200) }, KOKORO, true);
  assert.ok(long.length <= 127);
});

test('settings default to history off and survive bad values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voicedock-tray-'));
  try {
    const file = join(dir, 'tray-settings.json');
    const fresh = core.loadSettings(file);
    assert.deepEqual(fresh.memoryHistory, { enabled: false, intervalSeconds: 60, keepDays: 30 });
    assert.equal(fresh.autostartChosen, false);
    assert.equal(fresh.kokoroSeen, false);
    core.saveSettings(file, { ...fresh, kokoroSeen: true, memoryHistory: { enabled: true, intervalSeconds: 1, keepDays: 'x' } });
    const back = core.loadSettings(file);
    assert.equal(back.kokoroSeen, true);
    assert.deepEqual(back.memoryHistory, { enabled: true, intervalSeconds: 5, keepDays: 0 });
    writeFileSync(file, '{not json');
    assert.equal(core.loadSettings(file).memoryHistory.enabled, false);
    assert.ok(readFileSync(file, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('app data and autostart paths per OS, with the 1.0 tray entry', () => {
  assert.match(core.appDataDir('win32', { APPDATA: 'R' }, 'H'), /^R.VoiceDock$/);
  assert.equal(core.appDataDir('linux', {}, '/home/u'), '/home/u/.config/voicedock');
  assert.equal(core.appDataDir('linux', { XDG_CONFIG_HOME: '/x' }, '/home/u'), '/x/voicedock');
  assert.equal(core.appDataDir('darwin', {}, '/Users/u'), '/Users/u/Library/Application Support/VoiceDock');
  const win = core.autostartPaths('win32', { APPDATA: 'A' }, 'H');
  assert.match(win.current, /Startup.VoiceDock Tray\.lnk$/);
  assert.match(win.legacy, /Startup.Piper TTS Tray\.lnk$/); // legacy-name
  const linux = core.autostartPaths('linux', {}, '/home/u');
  assert.equal(linux.current, '/home/u/.config/autostart/voicedock-tray.desktop');
  assert.equal(linux.legacy, '/home/u/.config/autostart/piper-tts-tray.desktop'); // legacy-name
});

test('fetchHealth parses JSON and treats errors, non-2xx and timeouts as offline', async () => {
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    if (mode === 'ok') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(KOKORO)); }
    else if (mode === '500') { res.statusCode = 500; res.end('{}'); }
    else if (mode === 'text') { res.end('ok'); }
    // 'hang': never answer
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.deepEqual(await core.fetchHealth('127.0.0.1', port), KOKORO);
    mode = '500';
    assert.equal(await core.fetchHealth('127.0.0.1', port), null);
    mode = 'text';
    assert.deepEqual(await core.fetchHealth('127.0.0.1', port), { status: 'ok' }, 'old server without JSON');
    mode = 'hang';
    const started = Date.now();
    assert.equal(await core.fetchHealth('127.0.0.1', port, 150), null);
    assert.ok(Date.now() - started < 1500);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  assert.equal(await core.fetchHealth('127.0.0.1', port), null, 'nothing listening');
});

test('the recorded Piper pid is read from the new pid file, then the 1.1 one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vd-pid-'));
  try {
    const files = core.pidFiles(dir);
    assert.match(files.current, /voicedock-piper\.pid$/);
    assert.match(files.legacy, /piper-tts-server\.pid$/); // legacy-name
    assert.equal(core.readRecordedPid(files), null, 'no pid file');
    writeFileSync(files.legacy, '4242\n');
    assert.equal(core.readRecordedPid(files), 4242, 'a server a 1.1 tray started');
    writeFileSync(files.current, '77');
    assert.equal(core.readRecordedPid(files), 77, 'the new file wins');
    writeFileSync(files.current, 'junk');
    assert.equal(core.readRecordedPid(files), 4242, 'an unreadable new file falls back');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ─── Host lease (N8 Tray) ────────────────────────────────────────────────────
const NOW = Date.parse('2026-11-09T18:04:10Z');
const lease = (extra = {}) => ({
  contract: 2, host: 'n8tray', version: '0.26.0', pid: 9124, pidStartedAt: '2026-11-09T08:01:40Z',
  heartbeat: new Date(NOW - 3000).toISOString(), hosting: ['voicedock'], ...extra,
});

test('the host lease lives in N8 Tray\'s run folder on each OS', () => {
  assert.equal(core.hostLeasePath('win32', { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a'),
    join('C:\\Users\\a\\AppData\\Local', 'N8Tray', 'run', 'host.json'));
  assert.equal(core.hostLeasePath('darwin', {}, '/Users/a'), join('/Users/a', 'Library', 'Application Support', 'N8Tray', 'run', 'host.json'));
  assert.equal(core.hostLeasePath('linux', { XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/a'), join('/run/user/1000', 'n8tray', 'host.json'));
  assert.equal(core.hostLeasePath('linux', {}, '/home/a'), null, 'no runtime dir, no host');
});

test('reading the lease tolerates a BOM and refuses anything that is not a lease object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voicedock-lease-'));
  try {
    const file = join(dir, 'host.json');
    writeFileSync(file, '\uFEFF' + JSON.stringify(lease()));
    assert.deepEqual(core.readHostLease(file).hosting, ['voicedock']);
    writeFileSync(file, '{"hosting": ["voice');
    assert.equal(core.readHostLease(file), null, 'half-written');
    writeFileSync(file, '[1]');
    assert.equal(core.readHostLease(file), null, 'not an object');
    assert.equal(core.readHostLease(join(dir, 'missing.json')), null);
    assert.equal(core.readHostLease(null), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lease hosts VoiceDock only while fresh, listing it, from a live host', () => {
  const alive = () => true;
  assert.equal(core.leaseHostsApp(lease(), { now: NOW, isAlive: alive }), true);
  assert.equal(core.leaseHostsApp(lease({ heartbeat: new Date(NOW - 14000).toISOString() }), { now: NOW, isAlive: alive }), true, 'just under 15 s');
  assert.equal(core.leaseHostsApp(lease({ heartbeat: new Date(NOW - 16000).toISOString() }), { now: NOW, isAlive: alive }), false, 'stale');
  assert.equal(core.leaseHostsApp(lease({ heartbeat: new Date(NOW + 2000).toISOString() }), { now: NOW, isAlive: alive }), true, 'clock noise');
  assert.equal(core.leaseHostsApp(lease({ heartbeat: new Date(NOW + 60000).toISOString() }), { now: NOW, isAlive: alive }), false, 'far future');
  assert.equal(core.leaseHostsApp(lease({ heartbeat: 'soon' }), { now: NOW, isAlive: alive }), false);
  assert.equal(core.leaseHostsApp(lease({ hosting: ['n8hotkeys'] }), { now: NOW, isAlive: alive }), false, 'not listed');
  assert.equal(core.leaseHostsApp(lease({ hosting: 'voicedock' }), { now: NOW, isAlive: alive }), false, 'not a list');
  assert.equal(core.leaseHostsApp(lease(), { now: NOW, isAlive: () => false }), false, 'host died');
  assert.equal(core.leaseHostsApp(lease({ pid: 0 }), { now: NOW, isAlive: alive }), false);
  assert.equal(core.leaseHostsApp(null, { now: NOW }), false);
});

test('the tray hides while hosted, waits briefly for a host that is starting, and shows otherwise', () => {
  const alive = () => true;
  const stale = lease({ heartbeat: new Date(NOW - 60000).toISOString() });
  assert.equal(core.trayMode({ lease: lease(), now: NOW, isAlive: alive }), 'hosted');
  assert.equal(core.trayMode({ lease: null, now: NOW, startedAt: NOW }), 'own', 'no host on this machine');
  assert.equal(core.trayMode({ lease: lease({ hosting: [] }), now: NOW, startedAt: NOW }), 'own', 'the host does not host VoiceDock');
  assert.equal(core.trayMode({ lease: stale, now: NOW, startedAt: NOW - 5000, isAlive: alive }), 'waiting', 'both start at sign-in');
  assert.equal(core.trayMode({ lease: stale, now: NOW, startedAt: NOW - core.LEASE_START_GRACE_MS, isAlive: alive }), 'own', 'the host never came');
  assert.equal(core.trayMode({ lease: stale, now: NOW, startedAt: NOW - 5000, isAlive: alive, settled: true }), 'own', 'the host quit or crashed: back at once');
  assert.equal(core.trayMode({ lease: lease(), now: NOW, isAlive: alive, settled: true }), 'hosted', 'the host came back');
});
