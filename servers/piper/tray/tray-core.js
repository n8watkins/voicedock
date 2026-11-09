// Pure helpers for the VoiceDock tray: settings, status text, health checks
// and the autostart entry's location. Kept apart from voicedock-tray.js
// (which needs the systray2 helper binary) so they can be unit tested.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const KOKORO_HOST = process.env.KOKORO_HOST || '127.0.0.1';
const KOKORO_PORT = Number(process.env.KOKORO_PORT || 7478);

const DEFAULT_SETTINGS = Object.freeze({
  // Self-install the autostart entry only on the very first run; after that
  // the "Launch at login" toggle is the user's choice.
  autostartChosen: false,
  // Set once Kokoro has answered /health, so a later outage reads as
  // "not running" (it starts on the next read) rather than "not installed".
  kokoroSeen: false,
  memoryHistory: { enabled: false, intervalSeconds: 60, keepDays: 30 },
});

/** Per-user folder for tray settings and memory history. */
function appDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'VoiceDock');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'VoiceDock');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'voicedock');
}

function loadSettings(file) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run or unreadable: defaults */ }
  const history = { ...DEFAULT_SETTINGS.memoryHistory, ...(saved.memoryHistory || {}) };
  history.intervalSeconds = Math.max(5, Number(history.intervalSeconds) || 60);
  history.keepDays = Math.max(0, Number(history.keepDays) || 0);
  history.enabled = history.enabled === true;
  return { ...DEFAULT_SETTINGS, ...saved, memoryHistory: history };
}

function saveSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** GET /health as parsed JSON, or null (offline, timeout, not JSON, not 2xx). */
function fetchHealth(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 65536) body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({ status: 'ok' }); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const fmtMb = (n) => (n == null || !Number.isFinite(Number(n)) ? null : `${Math.round(Number(n))} MB`);

/** Piper's memory: the server plus any reader, as reported by /health. */
function piperMemoryText(health) {
  if (!health) return null;
  const total = fmtMb(health.totalRssMb ?? health.rssMb);
  if (!total) return null;
  return health.speaking && health.activeVoice ? `${total}, reading` : total;
}

function kokoroMemoryText(health) {
  if (!health) return null;
  const rss = fmtMb(health.rssMb);
  const model = health.modelLoaded === true ? 'model loaded' : health.modelLoaded === false ? 'model unloaded' : null;
  if (rss && model) return `${rss} (${model})`;
  return rss || (model ? `(${model})` : null);
}

/** "Running", "Running (external)" or "Stopped", plus memory when known. */
function piperStatusText(health, managed) {
  if (!health) return 'Piper: Stopped';
  const memory = piperMemoryText(health);
  const state = managed ? 'Running' : 'Running (external)';
  return `Piper: ${state}${memory ? ` · ${memory}` : ''}`;
}

/**
 * Kokoro starts on demand through the Piper server (servers/piper/kokoro.js),
 * so the tray never starts it. Status comes only from its /health: running,
 * or "not installed" / "not running" depending on whether it has ever
 * answered on this machine. Not running is normal: it starts on the next read.
 */
function kokoroStatusText(health, seen) {
  if (health) {
    const memory = kokoroMemoryText(health);
    return `Kokoro: Running${memory ? ` · ${memory}` : ''}`;
  }
  return seen ? 'Kokoro: Not running (starts when you read)' : 'Kokoro: Not installed (optional)';
}

/** One-line tooltip, kept under the 127 characters Windows shows. */
function tooltipText(piperHealth, kokoroHealth, kokoroSeen) {
  const piper = piperHealth ? `Piper ${piperMemoryText(piperHealth) || 'running'}` : 'Piper stopped';
  let kokoro;
  if (kokoroHealth) kokoro = `Kokoro ${kokoroMemoryText(kokoroHealth) || 'running'}`;
  else kokoro = kokoroSeen ? 'Kokoro off until a read' : null;
  const text = `VoiceDock | ${piper}${kokoro ? ` · ${kokoro}` : ''}`;
  return text.length > 127 ? `${text.slice(0, 126)}…` : text;
}

/**
 * Whether the Piper server is the one this tray started, so Stop and Restart
 * may act on it. A pid file alone is not proof: after a crash, Windows can
 * hand the same pid to an unrelated process, and killing it would be wrong.
 * It is ours while the child this tray spawned is still running (it may not
 * answer yet while it starts), or when the server that answers /health
 * reports the pid recorded in the pid file (a server a previous tray run
 * started).
 */
function isManagedServer({ filePid = null, health = null, ownChildAlive = false } = {}) {
  if (ownChildAlive) return true;
  if (!filePid || !health) return false;
  return Number(health.pid) === Number(filePid);
}

/**
 * The Piper server's pid file, and its name before VoiceDock 1.2. A server a
 * 1.1 tray started still has the old file, so both are read for one release.
 */
const PID_FILE_NAME = 'voicedock-piper.pid';
const LEGACY_PID_FILE_NAME = 'piper-tts-server.pid'; // legacy-name: read for one release
function pidFiles(logDir) {
  return { current: path.join(logDir, PID_FILE_NAME), legacy: path.join(logDir, LEGACY_PID_FILE_NAME) };
}

/** The recorded pid (current file first, then the legacy one), or null. */
function readRecordedPid(files, readFile = (file) => fs.readFileSync(file, 'utf8')) {
  for (const file of [files.current, files.legacy]) {
    try {
      const pid = parseInt(readFile(file).trim(), 10);
      if (pid > 0) return pid;
    } catch { /* missing or unreadable: try the next */ }
  }
  return null;
}

/** Where the "Launch at login" entry lives, and where the 1.0 tray's one lived. */
function autostartPaths(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const dir = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    return { current: path.join(dir, 'VoiceDock Tray.lnk'), legacy: path.join(dir, 'Piper TTS Tray.lnk') }; // legacy-name
  }
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    return { current: path.join(dir, 'com.voicedock.tray.plist'), legacy: path.join(dir, 'com.n8.pipertts.tray.plist') }; // legacy-name
  }
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart');
  return { current: path.join(dir, 'voicedock-tray.desktop'), legacy: path.join(dir, 'piper-tts-tray.desktop') }; // legacy-name
}

// ─── Host lease (N8 Tray) ────────────────────────────────────────────────────
// A host tray (N8 Tray) that shows VoiceDock in its own hub writes a lease
// file every 5 s listing the apps it hosts. While a fresh lease lists
// VoiceDock, this tray shows no icon and leaves Piper to the host, so there is
// never a second icon or a second owner for the same server.
const LEASE_APP_ID = 'voicedock';
// A lease is fresh while its heartbeat is under 15 s old (three missed writes).
const LEASE_FRESH_MS = 15000;
// At start, a stale lease that lists VoiceDock usually means the host is
// starting too (both start at sign-in), so the tray waits this long for it
// before showing its own icon and starting Piper.
const LEASE_START_GRACE_MS = 30000;

/** Where a host tray writes its lease, or null where there is none. */
function hostLeasePath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'N8Tray', 'run', 'host.json');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'N8Tray', 'run', 'host.json');
  return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'n8tray', 'host.json') : null;
}

/** The parsed lease, or null (missing, unreadable, half-written or not an object). */
function readHostLease(file, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  if (!file) return null;
  try {
    // N8 Tray (Windows PowerShell) may write a UTF-8 BOM.
    const lease = JSON.parse(readFile(file).replace(/^﻿/, ''));
    return lease && typeof lease === 'object' && !Array.isArray(lease) ? lease : null;
  } catch {
    return null;
  }
}

/**
 * Whether a lease hosts this app right now: it lists the id, its heartbeat is
 * under LEASE_FRESH_MS old (a heartbeat slightly in the future is clock noise
 * and counts as fresh) and the host pid is alive.
 */
function leaseHostsApp(lease, { appId = LEASE_APP_ID, now = Date.now(), isAlive = () => true } = {}) {
  if (!lease || !Array.isArray(lease.hosting) || !lease.hosting.includes(appId)) return false;
  const heartbeat = Date.parse(lease.heartbeat);
  if (!Number.isFinite(heartbeat)) return false;
  const age = now - heartbeat;
  if (age > LEASE_FRESH_MS || age < -LEASE_FRESH_MS) return false;
  const pid = Number(lease.pid);
  return Number.isInteger(pid) && pid > 0 && isAlive(pid);
}

/**
 * What the tray should be: 'hosted' (no icon, Piper left to the host), 'own'
 * (its own icon and Piper), or 'waiting' (not shown yet: at start, a lease
 * that lists the app but is stale gets LEASE_START_GRACE_MS for its host to
 * come up). Once the tray has been hosted or has shown its icon (settled), it
 * never waits again: a lease going stale then means the host quit or crashed.
 */
function trayMode({ lease, appId = LEASE_APP_ID, now = Date.now(), isAlive = () => true, startedAt = now, settled = false } = {}) {
  if (leaseHostsApp(lease, { appId, now, isAlive })) return 'hosted';
  const listed = !!lease && Array.isArray(lease.hosting) && lease.hosting.includes(appId);
  if (!settled && listed && now - startedAt < LEASE_START_GRACE_MS) return 'waiting';
  return 'own';
}

module.exports = {
  KOKORO_HOST, KOKORO_PORT, DEFAULT_SETTINGS, appDataDir, loadSettings, saveSettings, fetchHealth,
  piperMemoryText, kokoroMemoryText, piperStatusText, kokoroStatusText, tooltipText, autostartPaths,
  isManagedServer, pidFiles, readRecordedPid,
  LEASE_APP_ID, LEASE_FRESH_MS, LEASE_START_GRACE_MS, hostLeasePath, readHostLease, leaseHostsApp, trayMode,
};
