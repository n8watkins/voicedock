// Kokoro on demand (servers/piper/kokoro.js) and the Piper server's /engines
// routes. A fake spawn and a fake /health stand in for the real Kokoro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createKokoroLauncher, missingSetup, kokoroPython, stopAfterSeconds, readVoiceNames } = require('../servers/piper/kokoro.js');

function fakeProcess() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = 0;
  proc.kill = () => {
    proc.killed += 1;
    proc.signalCode = 'SIGTERM';
    proc.emit('exit', null, 'SIGTERM');
  };
  return proc;
}

function harness({ healthyAfter = 2, setup = null, speaking = false } = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'voicedock-kokoro-'));
  const calls = { spawn: [], health: 0 };
  let proc = null;
  const launcher = createKokoroLauncher({
    health: async () => {
      calls.health += 1;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) return null;
      return calls.health > healthyAfter ? { status: 'ok', engine: 'kokoro', speaking, modelLoading: false, rssMb: 12 } : null;
    },
    spawnImpl: (file, args, options) => {
      calls.spawn.push({ file, args, options });
      proc = fakeProcess();
      return proc;
    },
    setup: () => setup,
    dir: () => '/opt/voicedock/servers/kokoro',
    python: () => '/opt/voicedock/servers/kokoro/.venv/bin/python',
    logFile: join(logDir, 'kokoro.log'),
    pollMs: 1,
    startTimeoutMs: 500,
    env: { KOKORO_STOP_AFTER_SECONDS: '900' },
    log: {},
  });
  return { launcher, calls, proc: () => proc, cleanup: () => rmSync(logDir, { recursive: true, force: true }) };
}

test('start launches Kokoro from its uv environment and waits for /health', async () => {
  const h = harness();
  const result = await h.launcher.start();
  assert.equal(result.state, 'ready');
  assert.equal(result.owned, true);
  assert.equal(h.calls.spawn.length, 1);
  const { file, args, options } = h.calls.spawn[0];
  assert.equal(file, '/opt/voicedock/servers/kokoro/.venv/bin/python');
  assert.deepEqual(args, ['server.py']);
  assert.equal(options.cwd, '/opt/voicedock/servers/kokoro');
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.KOKORO_IDLE_EXIT_SECONDS, '900');
  assert.equal(options.env.KOKORO_PARENT_PID, String(process.pid));
  h.cleanup();
});

test('concurrent starts share one launch', async () => {
  const h = harness({ healthyAfter: 4 });
  const [a, b] = await Promise.all([h.launcher.start(), h.launcher.start()]);
  assert.equal(a.state, 'ready');
  assert.equal(b.state, 'ready');
  assert.equal(h.calls.spawn.length, 1);
  h.cleanup();
});

test('a Kokoro that already answers is not started again, and not owned', async () => {
  const h = harness({ healthyAfter: 0 });
  await h.launcher.start();
  const again = await h.launcher.start();
  assert.equal(again.startedMs, 0);
  assert.equal(h.calls.spawn.length, 1);
  h.cleanup();
});

test('start refuses with not-installed when setup is missing', async () => {
  const h = harness({ setup: "Kokoro's Python environment is missing" });
  await assert.rejects(h.launcher.start(), (err) => err.code === 'not-installed');
  assert.equal(h.calls.spawn.length, 0);
  const status = await h.launcher.status();
  assert.equal(status.state, 'not-installed');
  assert.equal(status.startsOnDemand, false);
  h.cleanup();
});

test('a start that never answers fails and stops the process', async () => {
  const h = harness({ healthyAfter: 1e9 });
  await assert.rejects(h.launcher.start(), (err) => err.code === 'failed' && /did not answer/.test(err.message));
  assert.equal(h.proc().killed, 1);
  assert.equal(h.launcher.owned(), false);
  h.cleanup();
});

test('a Piper read stops an idle Kokoro this server started', async () => {
  const h = harness();
  await h.launcher.start();
  assert.equal(await h.launcher.yieldTo('kokoro'), false);
  assert.equal(await h.launcher.yieldTo('piper'), true);
  assert.equal(h.proc().killed, 1);
  assert.equal(h.launcher.owned(), false);
  h.cleanup();
});

test('a Piper read leaves a speaking Kokoro alone', async () => {
  const h = harness({ speaking: true });
  await h.launcher.start();
  assert.equal(await h.launcher.yieldTo('piper'), false);
  assert.equal(h.proc().killed, 0);
  h.cleanup();
});

test('status reports ready, owned, and the stop-after period', async () => {
  const h = harness();
  assert.equal((await h.launcher.status()).state, 'stopped');
  await h.launcher.start();
  const status = await h.launcher.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.owned, true);
  assert.equal(status.pid, 4242);
  assert.equal(status.stopAfterSeconds, 900);
  assert.equal(h.launcher.stop(), true);
  assert.equal(h.launcher.stop(), false);
  h.cleanup();
});

test('missingSetup names the first missing piece', () => {
  const present = new Set([
    '/k/server.py',
    '/k/.venv/Scripts/python.exe',
    '/k/models/kokoro-v1.0.onnx',
  ]);
  const exists = (p) => present.has(p.replaceAll('\\', '/'));
  assert.match(missingSetup({ dir: '/k', exists, platform: 'win32' }), /voices-v1\.0\.bin/);
  present.add('/k/models/voices-v1.0.bin');
  assert.equal(missingSetup({ dir: '/k', exists, platform: 'win32' }), null);
  assert.match(missingSetup({ dir: '/k', exists, platform: 'linux' }), /Python environment/);
});

test('kokoroPython and stopAfterSeconds', () => {
  assert.match(kokoroPython('/k', 'win32').replaceAll('\\', '/'), /\.venv\/Scripts\/python\.exe$/);
  assert.match(kokoroPython('/k', 'linux'), /\.venv\/bin\/python$/);
  assert.equal(stopAfterSeconds({}), 1800);
  assert.equal(stopAfterSeconds({ KOKORO_STOP_AFTER_SECONDS: '0' }), 0);
  assert.equal(stopAfterSeconds({ KOKORO_STOP_AFTER_SECONDS: 'soon' }), 1800);
});

test('the 1.1 routes: the extension starts Kokoro, and only a local program (the PowerShell tray) stops it', async () => {
  const { app } = require('../servers/piper/server.js');
  const real = app.locals.kokoro;
  const events = [];
  let running = false;
  app.locals.kokoro = {
    health: async () => (running ? { status: 'ok', speaking: false } : null),
    owned: () => running,
    status: async () => ({ id: 'kokoro', state: running ? 'ready' : 'stopped', startsOnDemand: true, owned: running }),
    start: async () => { events.push('start'); running = true; return { state: 'ready', owned: true, startedMs: 3100 }; },
    stop: () => { events.push('stop'); const was = running; running = false; return was; },
    yieldTo: async () => false,
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const engines = await (await fetch(`${base}/engines`)).json();
    assert.deepEqual(engines.engines.map((e) => e.id), ['piper', 'kokoro']);
    assert.equal(engines.engines[1].state, 'idle', 'set up and stopped: starts when you read');
    const started = await fetch(`${base}/engines/kokoro/start`, { method: 'POST' });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { ok: true, state: 'ready', owned: true, startedMs: 3100 });
    const fromExtension = await fetch(`${base}/engines/kokoro/stop`, { method: 'POST', headers: { Origin: 'chrome-extension://abcdefghijklmnop' } });
    assert.equal(fromExtension.status, 403, 'no extension or page may stop an engine');
    assert.deepEqual(events, ['start']);
    const fromTray = await (await fetch(`${base}/engines/kokoro/stop`, { method: 'POST' })).json();
    assert.equal(fromTray.stopped, true, 'the PowerShell tray (no Origin) still can');
    assert.deepEqual(events, ['start', 'stop']);

    running = false;
    app.locals.kokoro.start = async () => { const e = new Error('no venv'); e.code = 'not-installed'; throw e; };
    const refused = await fetch(`${base}/engines/kokoro/start`, { method: 'POST' });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).reason, 'not-installed');

    const page = await fetch(`${base}/engines/kokoro/start`, { method: 'POST', headers: { Origin: 'https://example.com' } });
    assert.equal(page.status, 403);
  } finally {
    server.close();
    app.locals.kokoro = real;
  }
});

test('readVoiceNames lists the voices from the .npz index without loading them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voicedock-npz-'));
  const file = join(dir, 'voices-v1.0.bin');
  // Same layout as the real voices file: a zip with one <voice>.npy per voice.
  execFileSync('python3', ['-c', `import zipfile,sys
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for v in ["bm_george", "af_heart", "ef_dora"]: z.writestr(v + ".npy", b"x" * 100)
    z.writestr("README.txt", b"not a voice")`, file]);
  assert.deepEqual(readVoiceNames(file), ['af_heart', 'bm_george', 'ef_dora']);
  rmSync(dir, { recursive: true, force: true });
});

test('GET /engines/kokoro/voices answers without starting Kokoro', async () => {
  const { app } = require('../servers/piper/server.js');
  const real = app.locals.kokoro;
  app.locals.kokoro = { ...real, voices: () => ({ engine: 'kokoro', voices: ['af_heart'], defaultVoice: 'af_heart' }) };
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/engines/kokoro/voices`)).json(), { engine: 'kokoro', voices: ['af_heart'], defaultVoice: 'af_heart' });
    app.locals.kokoro.voices = () => null;
    assert.equal((await fetch(`${base}/engines/kokoro/voices`)).status, 404);
  } finally {
    server.close();
    app.locals.kokoro = real;
  }
});

test('the model load time is remembered after Kokoro stops, for the next estimate', async () => {
  const h = harness();
  const launcher = h.launcher;
  await launcher.start();
  const fakeHealth = { status: 'ok', modelLoaded: true, modelLoadMs: 1450 };
  assert.equal((await launcher.status(fakeHealth)).modelLoadMs, 1450);
  launcher.stop();
  assert.equal((await launcher.status(null)).modelLoadMs, 1450, 'still known while stopped');
  h.cleanup();
});
