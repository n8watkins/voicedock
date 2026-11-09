// The engine hub (servers/piper/hub): the engine policy with a fake Kokoro
// launcher and a fake clock, then the HTTP side (N8 Tray's control plane,
// presence, warm-up, and Kokoro reads proxied to a fake Kokoro server).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fake Kokoro server, listening before kokoro.js is loaded (it reads
// KOKORO_PORT once), so no test ever reaches a real Kokoro on 7478.
const kokoroRequests = [];
const fakeKokoroServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    kokoroRequests.push({ url: req.url, body: body ? JSON.parse(body) : null, origin: req.headers.origin });
    if (req.url === '/tts') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(Buffer.from('RIFFfakeWAVE'));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});
await new Promise((r) => fakeKokoroServer.listen(0, '127.0.0.1', r));
process.env.KOKORO_PORT = String(fakeKokoroServer.address().port);

const require = createRequire(import.meta.url);
const { createHub, noClientStopSeconds } = require('../servers/piper/hub/engines.js');
const { crashBackoffMs, createKokoroLauncher } = require('../servers/piper/kokoro.js');
const n8 = require('../servers/piper/hub/n8tray.js');

// ─── A fake Kokoro launcher ─────────────────────────────────────────────────
function fakeKokoro({ installed = true } = {}) {
  const k = {
    running: false,
    loaded: false,
    speaking: false,
    calls: [],
    owned: () => k.running,
    health: async () => (k.running ? { status: 'ok', voices: 54, speaking: k.speaking, modelLoaded: k.loaded, idleSeconds: 60, idleUnloadSeconds: 600, idleExitSeconds: 1800 } : null),
    status: async (h) => {
      if (h === undefined) h = await k.health();
      return {
        id: 'kokoro',
        state: h ? 'ready' : installed ? 'stopped' : 'not-installed',
        owned: k.running, pid: k.running ? 4242 : null, rssMb: h ? 300 : null,
        modelLoaded: k.loaded, speaking: k.speaking,
        setup: installed ? null : "Kokoro's Python environment is missing",
        setupState: installed ? null : 'not-installed',
        startsOnDemand: installed, lastStartMs: 600, modelLoadMs: 1800, lastError: null, health: h,
      };
    },
    start: async (opts = {}) => { k.calls.push(['start', opts.manual === true]); k.running = true; return { state: 'ready', owned: true, startedMs: 600 }; },
    stop: () => { k.calls.push(['stop']); const was = k.running; k.running = false; k.loaded = false; return was; },
    unload: async () => { k.calls.push(['unload']); const was = k.loaded; k.loaded = false; return was; },
    voices: () => ({ engine: 'kokoro', voices: ['af_heart'], defaultVoice: 'af_heart' }),
    yieldTo: async () => false,
  };
  return k;
}

function fakeReaders() {
  return { snapshot: () => ({ speaking: false, readers: [], readerRssMb: 0, lastReaderPeakRssMb: null }) };
}

function makeHub(opts = {}) {
  const clock = { now: Date.UTC(2026, 10, 9, 18, 0, 0) };
  const kokoro = opts.kokoro || fakeKokoro();
  const hub = createHub({
    kokoro,
    readers: fakeReaders(),
    piperVoices: async () => opts.voices ?? ['en_US-ryan-high.onnx'],
    piperInstalled: () => opts.piper ?? true,
    env: opts.env || {},
    now: () => clock.now,
    log: {},
  });
  return { hub, kokoro, clock };
}

const byId = async (hub) => Object.fromEntries((await hub.list()).engines.map((e) => [e.id, e]));

// ─── Engine states ─────────────────────────────────────────────────────────
test('the engine list says what is set up and what runs', async () => {
  const { hub, kokoro } = makeHub();
  let e = await byId(hub);
  assert.equal(e.piper.state, 'ready');
  assert.equal(e.piper.installed, true);
  assert.equal(e.kokoro.state, 'idle', 'set up, not running: starts when you read');
  assert.equal(e.kokoro.installed, true);
  assert.equal(e.kokoro.running, false);
  assert.match(e.kokoro.detail, /^Starts when you read, about \d+ s$/);
  assert.equal(e.kokoro.coldStart.estimateMs, 600 + 1800 + 1000, 'measured start + model load + first sentence');

  kokoro.running = true;
  kokoro.loaded = true;
  e = await byId(hub);
  assert.equal(e.kokoro.state, 'ready');
  assert.match(e.kokoro.detail, /unloads in 9 min/);

  kokoro.loaded = false;
  assert.equal((await byId(hub)).kokoro.state, 'idle', 'running, model released');
});

test('Not installed and needs setup come from the hub', async () => {
  let e = await byId(makeHub({ piper: false, kokoro: fakeKokoro({ installed: false }) }).hub);
  assert.equal(e.piper.state, 'not-installed');
  assert.equal(e.piper.installed, false);
  assert.equal(e.kokoro.state, 'not-installed');
  assert.equal(e.kokoro.installed, false);
  e = await byId(makeHub({ voices: [] }).hub);
  assert.equal(e.piper.state, 'needs-setup');
});

// ─── Starting ──────────────────────────────────────────────────────────────
test('a read starts Kokoro on demand, and low memory refuses it', async () => {
  const { hub, kokoro } = makeHub();
  await hub.ensure('kokoro');
  assert.deepEqual(kokoro.calls, [['start', false]]);
  await hub.ensure('kokoro');
  assert.equal(kokoro.calls.length, 1, 'already running');

  kokoro.stop();
  await hub.setPressure('problem');
  await assert.rejects(hub.ensure('kokoro'), (err) => err.code === 'low-memory');
  assert.equal((await byId(hub)).kokoro.state, 'stopped', 'shown as off while memory is low');
  await hub.setPressure('ok');
  await hub.ensure('kokoro');
  assert.equal(kokoro.running, true);
});

test('Piper needs no process; without voices it is not set up', async () => {
  assert.equal((await makeHub().hub.ensure('piper')).state, 'ready');
  await assert.rejects(makeHub({ voices: [] }).hub.ensure('piper'), (err) => err.code === 'not-installed');
});

test('warm starts Kokoro without waiting and says how long it takes', async () => {
  const { hub, kokoro } = makeHub();
  const warm = await hub.warm('kokoro');
  assert.equal(warm.outcome, 'ok');
  assert.equal(warm.state, 'starting');
  assert.equal(warm.expectedMs, 3400);
  await new Promise((r) => setImmediate(r));
  assert.equal(kokoro.running, true);
  assert.equal((await hub.warm('kokoro')).outcome, 'already');

  const low = makeHub();
  await low.hub.setPressure('attention');
  const refused = await low.hub.warm('kokoro');
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.reason, 'low-memory');
  assert.equal(low.kokoro.running, false);

  const missing = makeHub({ kokoro: fakeKokoro({ installed: false }) });
  assert.equal((await missing.hub.warm('kokoro')).reason, 'not-installed');
});

// ─── No browser, no engines ────────────────────────────────────────────────
test('engines stop after 5 minutes without a heartbeat, but only once one arrived', async () => {
  const { hub, kokoro, clock } = makeHub();
  await hub.ensure('kokoro');
  clock.now += 60 * 60_000;
  assert.equal(await hub.tick(), false, 'no heartbeat ever: an older extension; the idle timers decide');
  assert.equal(kokoro.running, true);

  hub.presence('chrome-extension://abc', { extensionVersion: '1.2.0', activeEngine: 'kokoro', reading: false });
  clock.now += 4 * 60_000;
  assert.equal(await hub.tick(), false);
  clock.now += 60_000;
  assert.equal(await hub.tick(), true);
  assert.equal(kokoro.running, false);
  assert.match(hub.events().at(-1).reason, /no browser heartbeat for 5 min/);
});

test('a speaking engine is not stopped for a missing heartbeat', async () => {
  const { hub, kokoro, clock } = makeHub();
  hub.presence('chrome-extension://abc', {});
  await hub.ensure('kokoro');
  hub.beginRead('kokoro');
  clock.now += 6 * 60_000;
  assert.equal(await hub.tick(), false);
  assert.equal(kokoro.running, true);
  hub.endRead('kokoro');
  clock.now += 6 * 60_000;
  assert.equal(await hub.tick(), true);
  assert.equal(kokoro.running, false);
});

test('the no-heartbeat period is a setting', () => {
  assert.equal(noClientStopSeconds({}), 300);
  assert.equal(noClientStopSeconds({ VOICEDOCK_NO_CLIENT_STOP_SECONDS: '60' }), 60);
  assert.equal(noClientStopSeconds({ VOICEDOCK_NO_CLIENT_STOP_SECONDS: 'soon' }), 300);
});

test('presence counts recent clients and remembers the active engine', () => {
  const { hub, clock } = makeHub();
  assert.deepEqual(hub.presenceDoc(), { lastSeenAt: null, clients: 0 });
  hub.presence('chrome-extension://a', { extensionVersion: '1.2.0', activeEngine: 'kokoro' });
  hub.presence('chrome-extension://b', { activeEngine: 'not an id!' });
  const doc = hub.presenceDoc();
  assert.equal(doc.clients, 2);
  assert.equal(doc.activeEngine, 'kokoro');
  clock.now += 6 * 60_000;
  assert.equal(hub.presenceDoc().clients, 0);
});

// ─── Memory pressure ───────────────────────────────────────────────────────
test('attention releases an idle model; problem stops engines that are not speaking', async () => {
  const { hub, kokoro } = makeHub();
  await hub.ensure('kokoro');
  kokoro.loaded = true;
  await hub.setPressure('attention');
  assert.deepEqual(kokoro.calls.at(-1), ['unload']);
  assert.equal(kokoro.running, true);

  kokoro.loaded = true;
  kokoro.speaking = true;
  await hub.setPressure('problem');
  assert.equal(kokoro.running, true, 'never stopped mid-sentence');
  kokoro.speaking = false;
  await hub.setPressure('problem');
  assert.equal(kokoro.running, false);
  await assert.rejects(hub.setPressure('purple'));
});

// ─── Crashes (kokoro.js) ───────────────────────────────────────────────────
test('crash backoff grows to 60 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 8, 20].map(crashBackoffMs), [0, 0, 1000, 2000, 4000, 8000, 60000, 60000]);
});

test('five crashes in ten minutes make Kokoro failed until it is started by hand', async () => {
  const { EventEmitter } = await import('node:events');
  const logDir = mkdtempSync(join(tmpdir(), 'voicedock-crash-'));
  let clock = 0;
  let proc;
  const launcher = createKokoroLauncher({
    health: async () => null,
    spawnImpl: () => {
      proc = new EventEmitter();
      proc.pid = 7;
      proc.exitCode = null;
      proc.signalCode = null;
      proc.kill = () => {};
      setImmediate(() => { proc.exitCode = 1; proc.emit('exit', 1, null); });
      return proc;
    },
    setup: () => null,
    dir: () => logDir,
    python: () => 'python',
    logFile: join(logDir, 'kokoro.log'),
    pollMs: 1,
    startTimeoutMs: 200,
    env: {},
    log: {},
    now: () => clock,
  });
  for (let i = 0; i < 5; i++) {
    await assert.rejects(launcher.start());
    clock += 61_000; // past any backoff
  }
  const status = await launcher.status();
  assert.equal(status.state, 'failed');
  assert.equal(status.startsOnDemand, false);
  await assert.rejects(launcher.start(), (err) => err.code === 'failed' && /by hand/.test(err.message));
  await assert.rejects(launcher.start({ manual: true }), (err) => /exited while starting/.test(err.message), 'a manual start tries again');
  rmSync(logDir, { recursive: true, force: true });
});

// ─── Manifest and folders ──────────────────────────────────────────────────
test('the manifest installs to the modules folder and uninstalls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voicedock-modules-'));
  const file = n8.installManifest({ modulesDir: dir, version: '1.2.0' });
  assert.equal(file, join(dir, 'voicedock.json'));
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(manifest.id, 'voicedock');
  assert.equal(manifest.version, '1.2.0');
  assert.equal(manifest.status.url, 'http://127.0.0.1:7477/n8/v2/status');
  assert.deepEqual(manifest.actions.map((a) => a.id), ['engine.start', 'engine.stop']);
  assert.equal(n8.uninstallManifest({ modulesDir: dir }), file);
  assert.equal(existsSync(file), false);
  rmSync(dir, { recursive: true, force: true });
});

test('folders follow the spec per OS, with test overrides', () => {
  assert.equal(n8.runDir({ env: { N8TRAY_RUN_DIR: '/tmp/x' }, platform: 'linux' }), '/tmp/x');
  assert.equal(n8.runDir({ env: { LOCALAPPDATA: 'C:\\Users\\n\\AppData\\Local' }, platform: 'win32' }).replace(/\//g, '\\'), 'C:\\Users\\n\\AppData\\Local\\N8Tray\\run');
  assert.equal(n8.runDir({ env: {}, platform: 'linux' }), null, 'no XDG_RUNTIME_DIR: standalone');
  assert.equal(n8.runDir({ env: { XDG_RUNTIME_DIR: '/run/user/1000' }, platform: 'linux' }), '/run/user/1000/n8tray');
  assert.equal(n8.modulesDir({ env: {}, platform: 'linux', home: '/home/n' }), '/home/n/.local/share/n8tray/modules');
  assert.equal(n8.modulesDir({ env: {}, platform: 'darwin', home: '/Users/n' }), '/Users/n/Library/Application Support/N8Tray/modules');
});

test('the summary puts the engine in use first', () => {
  assert.equal(n8.summaryFor([{ name: 'Piper', state: 'ready' }, { name: 'Kokoro', state: 'idle' }]), 'Piper ready, Kokoro sleeping');
  assert.equal(n8.summaryFor([{ name: 'Piper', state: 'idle' }, { name: 'Kokoro', state: 'ready' }]), 'Kokoro ready, Piper sleeping');
});

// ─── HTTP: the server with a fake Kokoro behind it ─────────────────────────
let app;
let server;
let base;
let port;
let runFolder;
let token;

before(async () => {
  const voiceDir = mkdtempSync(join(tmpdir(), 'voicedock-hub-voices-'));
  writeFileSync(join(voiceDir, 'en_US-test-medium.onnx'), 'x');
  writeFileSync(join(voiceDir, 'en_US-test-medium.onnx.json'), '{}');
  process.env.VOICE_DIR = voiceDir;
  process.env.PIPER_BIN = process.execPath; // exists; never run here

  ({ app } = require('../servers/piper/server.js'));
  app.locals.kokoro = fakeKokoro();
  runFolder = join(mkdtempSync(join(tmpdir(), 'voicedock-run-')), 'run');
  app.locals.n8.prepare({ dir: runFolder });
  token = readFileSync(join(runFolder, 'voicedock.token'), 'utf8');
  app.locals.stopped = [];
  app.locals.onStop = (reason) => app.locals.stopped.push(reason);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  server?.close();
  fakeKokoroServer?.close();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

test('the token is 64 hex characters, user-only, in a user-only folder', () => {
  assert.match(token, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(runFolder, 'voicedock.token')).mode & 0o077, 0);
    assert.equal(statSync(runFolder).mode & 0o077, 0);
  }
});

test('the control plane refuses what it must', async () => {
  const status = `${base}/n8/v2/status`;
  assert.equal((await fetch(status)).status, 401, 'no token');
  assert.equal((await fetch(status, { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } })).status, 401, 'wrong token');
  assert.equal((await fetch(status, { headers: { ...auth(), Origin: 'chrome-extension://abc' } })).status, 403, 'any Origin, even the extension');
  const unknown = await fetch(`${base}/n8/v2/actions/no-such-action`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unknown.status, 404);
  const noComponent = await fetch(`${base}/n8/v2/actions/engine.start`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: '{"component":"pocket"}' });
  assert.equal(noComponent.status, 400);
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  const http = await import('node:http');
  const code = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/n8/v2/status', headers: { ...auth(), Host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(code, 403);
});

test('the status document has the hub, its components and fresh resources', async () => {
  const res = await fetch(`${base}/n8/v2/status`, { headers: auth() });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(token), false, 'no secrets');
  const doc = JSON.parse(text);
  assert.equal(doc.contract, 2);
  assert.equal(doc.id, 'voicedock');
  assert.equal(doc.pid, process.pid);
  assert.equal(doc.state, 'ready');
  assert.deepEqual(doc.components.map((c) => [c.id, c.state]), [['piper', 'ready'], ['kokoro', 'idle']]);
  assert.equal(doc.resources.processes[0].pid, process.pid);
  assert.equal(doc.resources.processes[0].role, 'hub');
  assert.ok(Math.abs(Date.parse(doc.pidStartedAt) - (Date.now() - process.uptime() * 1000)) < 2000);
  assert.deepEqual(doc.features, ['pressure', 'presence']);
});

test('engine actions start and stop Kokoro, and pressure is accepted', async () => {
  const post = (path, body) => fetch(`${base}/n8/v2${path}`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.equal((await post('/actions/engine.start', { component: 'kokoro' })).outcome, 'ok');
  assert.equal(app.locals.kokoro.running, true);
  assert.equal((await post('/actions/engine.start', { component: 'kokoro' })).outcome, 'already');
  assert.equal((await post('/actions/engine.stop', { component: 'kokoro' })).outcome, 'ok');
  assert.equal(app.locals.kokoro.running, false);
  assert.equal((await post('/actions/engine.stop', { component: 'kokoro' })).outcome, 'already');
  assert.equal((await post('/actions/engine.start', { component: 'piper' })).outcome, 'already');
  assert.deepEqual(await post('/pressure', { level: 'ok' }), { outcome: 'ok' });
  const stop = await post('/actions/stop', {});
  assert.equal(stop.outcome, 'ok');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(app.locals.stopped, ['asked by N8 Tray']);
});

test('the extension heartbeat shows in /engines and the status', async () => {
  const res = await fetch(`${base}/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abcdefghijklmnop' },
    body: JSON.stringify({ extensionVersion: '1.2.0', activeEngine: 'kokoro', reading: false }),
  });
  assert.equal(res.status, 200);
  const list = await (await fetch(`${base}/engines`)).json();
  assert.equal(list.api, 2);
  assert.equal(list.presence.clients, 1);
  assert.equal(list.presence.activeEngine, 'kokoro');
  assert.equal(list.policy.heartbeatArmed, true);
  const page = await fetch(`${base}/presence`, { method: 'POST', headers: { Origin: 'https://example.com' } });
  assert.equal(page.status, 403);
});

test('a Kokoro read goes through the hub: started on demand, then proxied', async () => {
  app.locals.kokoro.stop();
  const res = await fetch(`${base}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abcdefghijklmnop' },
    body: JSON.stringify({ engine: 'kokoro', text: 'Hello there.', voice: 'af_heart' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'RIFFfakeWAVE');
  assert.equal(app.locals.kokoro.running, true, 'started for the read');
  const sent = kokoroRequests.at(-1);
  assert.deepEqual(sent.body, { text: 'Hello there.', voice: 'af_heart' });
  assert.equal(sent.origin, undefined, 'the hub calls Kokoro without an Origin');
});

test('Kokoro read errors say why: not set up, low memory', async () => {
  const real = app.locals.kokoro;
  app.locals.kokoro = fakeKokoro({ installed: false });
  app.locals.kokoro.start = async () => { const e = new Error('missing'); e.code = 'not-installed'; throw e; };
  try {
    const res = await fetch(`${base}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'kokoro', text: 'Hi there, friend.' }) });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, 'not-installed');
  } finally {
    app.locals.kokoro = real;
  }
  real.stop();
  await app.locals.hub.setPressure('problem');
  try {
    const res = await fetch(`${base}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'kokoro', text: 'Hi there, friend.' }) });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).reason, 'low-memory');
    const warm = await fetch(`${base}/engines/kokoro/warm`, { method: 'POST' });
    assert.equal(warm.status, 503);
  } finally {
    await app.locals.hub.setPressure('ok');
  }
  const bad = await fetch(`${base}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'nope', text: 'Hi.' }) });
  assert.equal(bad.status, 400);
});

test('warm answers 202 while Kokoro starts, and voices come from the hub', async () => {
  app.locals.kokoro.stop();
  const warm = await fetch(`${base}/engines/kokoro/warm`, { method: 'POST' });
  assert.equal(warm.status, 202);
  assert.equal((await warm.json()).state, 'starting');
  const voices = await (await fetch(`${base}/engines/kokoro/voices`)).json();
  assert.deepEqual(voices.voices, ['af_heart']);
  const piper = await (await fetch(`${base}/engines/piper/voices`)).json();
  assert.deepEqual(piper.voices, ['en_US-test-medium.onnx']);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.api, 2);
  const events = await (await fetch(`${base}/hub/events`)).json();
  assert.ok(events.events.some((e) => e.type === 'start' && e.engine === 'kokoro'));
});
