// VoiceDock tray (Windows / macOS / Linux).
//
// One small Node tray for both VoiceDock engines:
// - Piper (this folder's server.js, port 7477): status, memory, and
//   Start / Stop / Restart. The tray starts Piper when it is offline and only
//   ever stops the server it started; one started elsewhere shows as external.
// - Kokoro (servers/kokoro, port 7478): status and memory from its /health.
//   The Piper server this tray runs starts Kokoro on the first Kokoro read
//   and stops it after 30 idle minutes (servers/piper/kokoro.js), so the tray
//   needs no Kokoro controls. Kokoro is optional and shows as "Not installed
//   (optional)" until it has answered once.
//
// Memory: each engine's /health reports its own memory, shown in the menu and
// tooltip. "Record memory history" (off by default) samples it once a minute
// into daily CSV files under the user's app data folder, and "Memory report"
// builds and opens an HTML report with 24-hour and 7-day timelines.
//
//   node tray/voicedock-tray.js
//
// Had an older name (tray/piper-tray.js) up to VoiceDock 1.1; that tray's
// startup entry is replaced by "VoiceDock Tray" on first run.
//
// Hosted by N8 Tray: while N8 Tray's lease (%LOCALAPPDATA%\N8Tray\run\host.json,
// written every 5 s) is fresh and lists "voicedock", this tray shows no icon,
// starts no Piper and records no memory: N8 Tray runs VoiceDock then. It
// reads the lease every 5 s; when the lease goes stale (N8 Tray quit or
// crashed) the icon comes back within about 15 s, and when N8 Tray returns it
// goes away again (a Piper server this tray started keeps running, and N8
// Tray adopts it). See tray-core.js, "Host lease".
//
// Robustness: async (non-blocking) health checks, a single-instance lockfile
// with stale-lock recovery, graceful shutdown, and modest crash supervision.
const SysTray = require('systray2').default;
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const core = require('./tray-core');
const history = require('./memory-history');
const report = require('./memory-report');

const TRAY_DIR = __dirname;
const SERVER_DIR = path.dirname(TRAY_DIR); // .../servers/piper
const ASSETS = path.join(TRAY_DIR, 'assets');
// VOICEDOCK_TRAY_LOG_DIR moves the logs, pid files and lock (the tests use it).
const LOG_DIR = process.env.VOICEDOCK_TRAY_LOG_DIR || path.join(SERVER_DIR, 'logs');
const PID_FILES = core.pidFiles(LOG_DIR); // current name, plus the 1.1 one for one release
const LOCK_FILE = path.join(LOG_DIR, 'voicedock-tray.lock');
const TRAY_LOG = path.join(LOG_DIR, 'voicedock-tray.log');
const APP_DIR = core.appDataDir();
const SETTINGS_FILE = path.join(APP_DIR, 'tray-settings.json');
const HISTORY_DIR = path.join(APP_DIR, 'memory');
const { HOST, PORT } = require('../config'); // shared with server.js so they agree
const isWin = process.platform === 'win32';
const ICON_EXT = isWin ? 'ico' : 'png'; // Windows tray needs .ico; mac/linux use .png
const MAX_RESTARTS = 3;
const REFRESH_MS = 3000;
const LEASE_CHECK_MS = 5000;
const LEASE_FILE = core.hostLeasePath();
const STARTED_AT = Date.now();

fs.mkdirSync(LOG_DIR, { recursive: true });

function log(message) {
  try {
    if (fs.existsSync(TRAY_LOG) && fs.statSync(TRAY_LOG).size > 1048576) fs.renameSync(TRAY_LOG, `${TRAY_LOG}.1`);
    fs.appendFileSync(TRAY_LOG, `[${new Date().toISOString()}] ${message}\n`);
  } catch { /* logging must never break the tray */ }
}

// ─── Single instance (portable lockfile + stale-lock recovery) ───────────────
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
(function acquireLock(attempt = 0) {
  try {
    // 'wx' = create exclusively; fails atomically if the file exists, so two
    // instances starting at once can't both win the lock.
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let owner = 0;
      try { owner = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10); } catch { /* ignore */ }
      if (owner && owner !== process.pid && isAlive(owner)) {
        console.error(`VoiceDock tray already running (pid ${owner}); exiting.`);
        process.exit(0);
      }
      // Stale lock (owner gone): clear it once and retry.
      if (attempt < 1) { fs.rmSync(LOCK_FILE, { force: true }); acquireLock(attempt + 1); return; }
    }
    // Any other error: proceed without a lock rather than failing to launch.
  }
})();
const releaseLock = () => {
  try {
    if (fs.existsSync(LOCK_FILE) &&
        parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* ignore */ }
};

// ─── Settings ────────────────────────────────────────────────────────────────
let settings = core.loadSettings(SETTINGS_FILE);
function updateSettings(patch) {
  settings = { ...settings, ...patch };
  try { core.saveSettings(SETTINGS_FILE, settings); } catch (err) { log(`Could not save settings: ${err.message}`); }
}

// ─── Icons (pre-rendered; just swap which file is shown) ──────────────────────
const iconB64 = (name) => fs.readFileSync(path.join(ASSETS, `${name}.${ICON_EXT}`)).toString('base64');
const ICON_ONLINE = iconB64('online');
const ICON_OFFLINE = iconB64('offline');

// ─── Piper server lifecycle ──────────────────────────────────────────────────
// The pid recorded for the server a tray started (this run or an earlier one).
const filePid = () => {
  const pid = core.readRecordedPid(PID_FILES);
  return pid && isAlive(pid) ? pid : null;
};
const forgetPid = (onlyPid = null) => {
  for (const file of [PID_FILES.current, PID_FILES.legacy]) {
    try {
      if (onlyPid === null || parseInt(fs.readFileSync(file, 'utf8').trim(), 10) === onlyPid) fs.unlinkSync(file);
    } catch { /* ignore */ }
  }
};
// The server child this tray run spawned, while it runs (cleared on exit).
let ownChild = null;
// Ours only while our child runs or the answering server reports the recorded
// pid: a bare pid file could name a reused pid (see core.isManagedServer).
const managedPid = (health) => {
  const pid = filePid();
  const ownChildAlive = !!ownChild && ownChild.exitCode === null && ownChild.signalCode === null;
  return core.isManagedServer({ filePid: pid, health, ownChildAlive }) ? (ownChildAlive ? ownChild.pid : pid) : null;
};
function startServer() {
  const out = fs.openSync(path.join(LOG_DIR, 'voicedock-piper.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    // windowsHide hides the console window a detached child would otherwise
    // pop up on Windows.
    cwd: SERVER_DIR, detached: true, windowsHide: true, stdio: ['ignore', out, out],
  });
  forgetPid();
  try { fs.writeFileSync(PID_FILES.current, String(child.pid)); } catch { /* ignore */ }
  ownChild = child;
  child.once('exit', (code) => {
    if (ownChild === child) ownChild = null;
    // Forget the pid as soon as it is gone, before Windows can reuse it.
    forgetPid(child.pid);
    log(`The Piper server exited: pid ${child.pid}, code ${code}`);
  });
  child.unref();
  try { fs.closeSync(out); } catch { /* ignore */ } // child keeps its own dup; don't leak our fd
  log(`Started the Piper server: pid ${child.pid}`);
}
async function stopServer() {
  const pid = managedPid(await core.fetchHealth(HOST, PORT));
  if (pid) { try { process.kill(pid); log(`Stopped the Piper server: pid ${pid}`); } catch { /* ignore */ } }
  else if (filePid()) log('Not stopping: the recorded pid is not the Piper server that answers (pid reused, or the server is gone)');
  forgetPid();
}
// Is something already listening on the port? (Used so a restart waits for the
// old process to release it; otherwise the new server hits EADDRINUSE.)
const portInUse = () => new Promise((resolve) => {
  const s = net.connect({ host: HOST, port: PORT });
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.setTimeout(600, () => { s.destroy(); resolve(false); });
});
// Start the server, but first wait (briefly) for the port to be free, and never
// overlap two start attempts.
let starting = false;
async function startServerSafely() {
  if (starting) return;
  starting = true;
  try {
    const deadline = Date.now() + 12000;
    while ((await portInUse()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600));
    }
    // Hosted meanwhile: the host runs Piper now.
    if (systray) startServer();
  } finally {
    setTimeout(() => { starting = false; }, 1500); // let it bind before another attempt
  }
}
const openWith = (target) => {
  const opener = isWin ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  try { spawn(opener, [target], { detached: true, windowsHide: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
};
function openVoices() {
  const dir = path.join(SERVER_DIR, 'piper', 'voices');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  openWith(dir);
}

// ─── Launch at login (self-installing, per-OS) ───────────────────────────────
const AUTOSTART = core.autostartPaths();
const isAutostartInstalled = () => { try { return fs.existsSync(AUTOSTART.current); } catch { return false; } };
// On Windows the shortcut is written by a PowerShell child, so it may not exist
// yet right after installAutostart(); this keeps the checkbox right meanwhile.
let autostartJustInstalled = false;

function installAutostart() {
  const file = AUTOSTART.current;
  const script = path.join(TRAY_DIR, 'voicedock-tray.js');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* ignore */ }
  if (isWin) {
    // The shortcut runs the .vbs via wscript (a windowless host) so node
    // starts hidden: no console flash at sign-in, unlike a .bat launcher.
    const vbs = path.join(SERVER_DIR, 'scripts', 'start-voicedock-tray.vbs');
    const q = (s) => s.replace(/'/g, "''");
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(file)}');` +
      `$s.TargetPath='C:\\Windows\\System32\\wscript.exe';$s.Arguments='"${q(vbs)}"';` +
      `$s.WorkingDirectory='${q(path.dirname(vbs))}';$s.WindowStyle=7;` +
      `$s.Description='Start the VoiceDock tray at sign-in';$s.Save()`;
    spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  } else if (process.platform === 'darwin') {
    fs.writeFileSync(file,
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.voicedock.tray</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${script}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`);
    try { spawn('launchctl', ['load', file], { stdio: 'ignore' }); } catch { /* ignore */ }
  } else {
    fs.writeFileSync(file,
`[Desktop Entry]
Type=Application
Name=VoiceDock Tray
Exec=${process.execPath} ${script}
X-GNOME-Autostart-enabled=true
Terminal=false
`);
  }
}

function removeAutostartFile(file) {
  if (process.platform === 'darwin') { try { spawn('launchctl', ['unload', file], { stdio: 'ignore' }); } catch { /* ignore */ } }
  try { fs.unlinkSync(file); } catch { /* ignore */ }
}

// The tray had an older name up to VoiceDock 1.1. If its startup entry is
// still there, replace it with the VoiceDock one (keeping launch-at-login on).
function migrateLegacyAutostart() {
  if (!fs.existsSync(AUTOSTART.legacy)) return false;
  removeAutostartFile(AUTOSTART.legacy);
  if (!isAutostartInstalled()) installAutostart();
  autostartJustInstalled = true;
  updateSettings({ autostartChosen: true });
  log(`Replaced the old startup entry ${path.basename(AUTOSTART.legacy)} with ${path.basename(AUTOSTART.current)}`);
  return true;
}

// ─── Memory history ──────────────────────────────────────────────────────────
const sampler = { timer: null, prev: { piper: undefined, kokoro: undefined }, prunedDay: '' };

async function sampleMemory() {
  const [piper, kokoro] = await Promise.all([
    core.fetchHealth(HOST, PORT),
    core.fetchHealth(core.KOKORO_HOST, core.KOKORO_PORT),
  ]);
  const now = Date.now();
  const rows = [...history.rowsFromHealth('piper', sampler.prev.piper, piper, now)];
  // An engine that was never seen is not recorded as "offline" all day.
  if (kokoro || settings.kokoroSeen) rows.push(...history.rowsFromHealth('kokoro', sampler.prev.kokoro, kokoro, now));
  sampler.prev = { piper, kokoro };
  try {
    history.appendRows(HISTORY_DIR, rows, now);
    const day = history.localDay(now);
    if (sampler.prunedDay !== day) {
      sampler.prunedDay = day;
      const removed = history.pruneHistory(HISTORY_DIR, settings.memoryHistory.keepDays, now);
      if (removed.length) log(`Pruned memory history: ${removed.join(', ')}`);
    }
  } catch (err) {
    log(`Could not write memory history: ${err.message}`);
  }
}

function applyHistorySetting() {
  clearInterval(sampler.timer);
  sampler.timer = null;
  sampler.prev = { piper: undefined, kokoro: undefined };
  if (!settings.memoryHistory.enabled) return;
  sampleMemory();
  sampler.timer = setInterval(sampleMemory, settings.memoryHistory.intervalSeconds * 1000);
  log(`Recording memory history every ${settings.memoryHistory.intervalSeconds} s into ${HISTORY_DIR}`);
}

function openMemoryReport() {
  try {
    const file = report.writeReport(HISTORY_DIR, { out: path.join(HISTORY_DIR, 'memory-report.html') });
    openWith(file);
    log(`Opened the memory report: ${file}`);
  } catch (err) {
    log(`Could not build the memory report: ${err.message}`);
  }
}

// ─── Menu ────────────────────────────────────────────────────────────────────
// Click handling matches on titles, so actionable items keep fixed titles; the
// status lines (which change) are disabled.
const T = {
  start: 'Start Piper', stop: 'Stop Piper', restart: 'Restart Piper', voices: 'Open Piper Voices Folder',
  report: 'Memory report', history: 'Record memory history', login: 'Launch at login', quit: 'Quit',
};
const sep = () => Object.assign({}, SysTray.separator);
const titleItem = { title: 'VoiceDock', tooltip: '', enabled: false };
const piperItem = { title: 'Piper: checking…', tooltip: 'Piper engine (port 7477)', enabled: false };
const kokoroItem = { title: 'Kokoro: checking…', tooltip: 'Kokoro engine (port 7478, optional, starts when you read with it)', enabled: false };
const startItem = { title: T.start, tooltip: 'Start the local Piper server', enabled: true };
const stopItem = { title: T.stop, tooltip: 'Stop the Piper server this tray started', enabled: false };
const restartItem = { title: T.restart, tooltip: 'Stop and start the Piper server', enabled: false };
const voicesItem = { title: T.voices, tooltip: '', enabled: true };
const reportItem = { title: T.report, tooltip: 'Build and open the memory report (24 hours and 7 days)', enabled: true };
const historyItem = { title: T.history, tooltip: `Sample each engine's memory into ${HISTORY_DIR}`, checked: settings.memoryHistory.enabled, enabled: true };
const loginItem = { title: T.login, tooltip: 'Start the tray automatically at sign-in', checked: isAutostartInstalled(), enabled: true };
const quitItem = { title: T.quit, tooltip: '', enabled: true };
const menu = {
  icon: ICON_OFFLINE,
  title: 'VoiceDock',
  tooltip: 'VoiceDock',
  items: [
    titleItem, piperItem, kokoroItem, sep(),
    startItem, stopItem, restartItem, voicesItem, sep(),
    reportItem, historyItem, sep(),
    loginItem, quitItem,
  ],
};
// The icon exists only while the tray is not hosted; showTray and hideTray
// create and remove it.
let systray = null;
const pushItem = (item) => { if (systray) systray.sendAction({ type: 'update-item', item }).catch(() => {}); };

let intendedRunning = false; // the user (or auto-start) wants Piper up: gates crash supervision
let restarts = 0;
let lastKey = '';
let lastStates = '';
let refreshing = false;
let refreshTimer = null;

async function refresh() {
  if (refreshing || !systray) return; // a slow check must not stack up passes
  refreshing = true;
  try {
    const [piper, kokoro] = await Promise.all([
      core.fetchHealth(HOST, PORT),
      core.fetchHealth(core.KOKORO_HOST, core.KOKORO_PORT),
    ]);
    if (!systray) return; // hidden while the checks ran
    const online = !!piper;
    const managed = managedPid(piper) !== null;
    if (kokoro && !settings.kokoroSeen) updateSettings({ kokoroSeen: true });

    // Crash supervision: if we wanted it up and it died (not just starting), restart.
    if (intendedRunning && !online && !managed && !starting) {
      if (restarts < MAX_RESTARTS) { restarts += 1; log('Piper is down; restarting it'); startServerSafely(); }
    }
    if (online) restarts = 0;

    piperItem.title = core.piperStatusText(piper, managed);
    kokoroItem.title = core.kokoroStatusText(kokoro, settings.kokoroSeen);
    // Log state changes (not every memory change) so the log shows the history.
    const states = [piperItem.title, kokoroItem.title].map((t) => t.split(' · ')[0]).join(', ');
    if (states !== lastStates) { log(`Status: ${states}`); lastStates = states; }
    const tooltip = core.tooltipText(piper, kokoro, settings.kokoroSeen);
    const key = [piperItem.title, kokoroItem.title, online, managed, tooltip].join('|');
    if (key === lastKey) return; // only push to the tray on actual changes
    lastKey = key;

    startItem.enabled = !online;
    stopItem.enabled = managed;
    restartItem.enabled = managed;
    // update-menu only refreshes the icon and tooltip; the rendered items are
    // updated one by one with update-item.
    for (const item of [piperItem, kokoroItem, startItem, stopItem, restartItem]) pushItem(item);
    menu.icon = online ? ICON_ONLINE : ICON_OFFLINE;
    menu.tooltip = tooltip;
    systray.sendAction({ type: 'update-menu', menu }).catch(() => {});
  } finally {
    refreshing = false;
  }
}

function onMenuClick(action) {
  switch (action.item && action.item.title) {
    case T.start: intendedRunning = true; restarts = 0; startServerSafely(); setTimeout(refresh, 1200); break;
    case T.stop: intendedRunning = false; stopServer().finally(() => setTimeout(refresh, 800)); break;
    case T.restart:
      intendedRunning = true; restarts = 0;
      // startServerSafely waits for the port to free before starting.
      stopServer().then(startServerSafely).finally(() => setTimeout(refresh, 1500));
      break;
    case T.voices: openVoices(); break;
    case T.report: openMemoryReport(); break;
    case T.history:
      updateSettings({ memoryHistory: { ...settings.memoryHistory, enabled: !settings.memoryHistory.enabled } });
      historyItem.checked = settings.memoryHistory.enabled;
      pushItem(historyItem);
      applyHistorySetting();
      break;
    case T.login:
      if (isAutostartInstalled()) { removeAutostartFile(AUTOSTART.current); loginItem.checked = false; }
      else { installAutostart(); loginItem.checked = true; }
      updateSettings({ autostartChosen: true });
      pushItem(loginItem);
      break;
    case T.quit: shutdown(); break;
    default: break;
  }
}

// ─── Showing and hiding the icon (host lease) ────────────────────────────────
let mode = 'starting'; // 'starting' | 'waiting' | 'hosted' | 'own'
let settled = false; // hosted or shown at least once: no more start grace
let firstShowDone = false;

function showTray() {
  if (systray) return;
  lastKey = '';
  const tray = new SysTray({ menu, debug: false, copyDir: true });
  systray = tray;
  tray.onClick(onMenuClick);
  tray.ready().then(async () => {
    if (systray !== tray) return; // hidden again before it was ready
    log(`VoiceDock tray icon shown: pid ${process.pid}`);
    if (!firstShowDone) {
      firstShowDone = true;
      migrateLegacyAutostart();
      // Self-install launch at login on the very first run only; afterwards the
      // toggle is the user's choice and is never undone at start.
      if (!settings.autostartChosen) {
        if (!isAutostartInstalled()) { installAutostart(); autostartJustInstalled = true; }
        updateSettings({ autostartChosen: true });
      }
    }
    loginItem.checked = autostartJustInstalled || isAutostartInstalled();
    pushItem(loginItem);
    const health = await core.fetchHealth(HOST, PORT);
    if (systray !== tray) return;
    if (!health) { intendedRunning = true; restarts = 0; startServerSafely(); } // auto-start if offline
    else { intendedRunning = managedPid(health) !== null; }
    applyHistorySetting();
    await refresh();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, REFRESH_MS);
  }).catch((err) => {
    if (systray !== tray) return; // hidden while it started: nothing to report
    console.error('VoiceDock tray failed to start:', (err && err.message) || err);
    log(`Failed to start: ${(err && err.message) || err}`);
    releaseLock();
    process.exit(1);
  });
}

// Removes the icon and stops supervising Piper and recording memory: the host
// does both now. A Piper server this tray started keeps running (stopping it
// could cut off a reading); the host adopts it.
function hideTray() {
  clearInterval(refreshTimer);
  refreshTimer = null;
  clearInterval(sampler.timer);
  sampler.timer = null;
  intendedRunning = false;
  restarts = 0;
  const tray = systray;
  systray = null;
  if (tray) tray.kill(false).catch(() => {});
}

function checkLease() {
  const lease = core.readHostLease(LEASE_FILE);
  const next = core.trayMode({ lease, isAlive, startedAt: STARTED_AT, settled });
  if (next === 'hosted' || next === 'own') settled = true;
  if (next === mode) return;
  const host = lease && lease.host ? `${lease.host} (pid ${lease.pid})` : 'the host tray';
  if (next === 'hosted') log(`Hosted by ${host}: no icon; it runs VoiceDock`);
  else if (next === 'waiting') log(`${host} lists VoiceDock but its lease is stale; waiting up to ${core.LEASE_START_GRACE_MS / 1000} s for it to start`);
  else if (mode === 'hosted') log(`The lease from ${host} went stale: showing the icon again`);
  else if (mode === 'waiting') log(`${host} did not come up: showing the icon`);
  mode = next;
  if (next === 'own') showTray(); else hideTray();
}

function shutdown() {
  clearInterval(sampler.timer);
  releaseLock();
  if (!systray) process.exit(0);
  try { systray.kill(true); } catch { process.exit(0); }
}
process.on('exit', releaseLock);
process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

log(`VoiceDock tray started: pid ${process.pid}${LEASE_FILE ? `, host lease ${LEASE_FILE}` : ''}`);
checkLease();
setInterval(checkLease, LEASE_CHECK_MS);
