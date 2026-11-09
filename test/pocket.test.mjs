// Pocket TTS behind the hub (servers/piper/pocket.js): setup states, start on
// demand with a fake engine program, what reaches the engine (voice names
// only, no Hugging Face token), idle stop, orphan cleanup, the one-heavy-
// engine rule, and a read streamed through the hub's /tts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const { createInstalls } = require('../servers/piper/hub/installs.js');
const { createPocketLauncher, cachedFile, VOICES, engineEnv } = require('../servers/piper/pocket.js');
const { createHub } = require('../servers/piper/hub/engines.js');
const { loadCatalog } = require('../servers/piper/hub/catalog.js');

const quiet = { log() {}, error() {} };
const launchers = [];
after(() => { for (const l of launchers) l.stop(); });

// A stand-in for `pocket-tts serve`: /health, and /tts answering with the
// form fields it got, so the test sees what reached the engine. It writes
// its environment to env.json first.
const FAKE = `
const http = require('http');
const fs = require('fs');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
fs.writeFileSync('env.json', JSON.stringify({ args: process.argv.slice(2), HF_HOME: process.env.HF_HOME || null, HF_TOKEN: process.env.HF_TOKEN || null }));
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"status":"healthy"}'); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const voice = /name="voice_url"\\r\\n\\r\\n([^\\r]*)/.exec(body)?.[1];
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.write('RIFF');
    setTimeout(() => res.end('voice=' + voice), 20);
  });
}).listen(port, '127.0.0.1');
`;

function setup({ installed = true, model = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vd-pocket-'));
  const installs = createInstalls({ dir, log: quiet });
  const fake = join(dir, 'fake-pocket.cjs');
  writeFileSync(fake, FAKE);
  if (installed) {
    const v = join(dir, 'pocket', '4.0.1');
    mkdirSync(v, { recursive: true });
    writeFileSync(join(v, 'pocket-tts'), '');
    writeFileSync(join(v, 'install.json'), JSON.stringify({ program: 'pocket-tts', version: '4.0.1', installedAt: '2026-11-09T00:00:00Z' }));
    writeFileSync(join(dir, 'pocket', 'state.json'), JSON.stringify({ current: '4.0.1', previous: null }));
  }
  if (model) {
    for (const f of loadCatalog().engines.pocket.versions[0].model.files) {
      const file = cachedFile(installs, f.hf);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'x');
    }
  }
  const clock = { now: Date.UTC(2026, 10, 9, 18, 0, 0) };
  const killed = [];
  const idleStops = [];
  const launcher = createPocketLauncher({
    installs,
    spawnImpl: (_file, args, opts) => spawn(process.execPath, [fake, ...args], opts),
    env: { PATH: process.env.PATH, HF_TOKEN: 'hf_secret', HUGGING_FACE_HUB_TOKEN: 'hf_secret2' },
    log: quiet,
    now: () => clock.now,
    kill: (pid) => killed.push(pid),
    rssOf: async () => 321,
    onIdleStop: (reason) => idleStops.push(reason),
    idleCheckMs: 3_600_000,
  });
  launchers.push(launcher);
  return { dir, installs, launcher, clock, killed, idleStops };
}

test('not installed, then installed without the model, then ready to start', async () => {
  const none = setup({ installed: false, model: false });
  assert.equal((await none.launcher.status()).state, 'not-installed');
  assert.equal(none.launcher.voices(), null);
  await assert.rejects(none.launcher.start(), (err) => err.code === 'not-installed');

  const noModel = setup({ model: false });
  const st = await noModel.launcher.status();
  assert.equal(st.state, 'needs-setup');
  assert.match(st.setup, /engines\.js model pocket/);
  assert.equal(noModel.launcher.voices().voices.length, 26, 'voices list before the model is there');

  const ok = setup();
  const ready = await ok.launcher.status();
  assert.equal(ready.state, 'stopped');
  assert.equal(ready.startsOnDemand, true);
  assert.equal(ready.version, '4.0.1');
});

test('starts on demand on a private port, with int8 weights and no Hugging Face token', async () => {
  const { launcher, dir } = setup();
  const result = await launcher.start();
  assert.equal(result.state, 'ready');
  const st = await launcher.status();
  assert.equal(st.state, 'ready');
  assert.equal(st.owned, true);
  const env = JSON.parse(readFileSync(join(dir, 'pocket', 'data', 'env.json'), 'utf8'));
  assert.deepEqual(env.args.slice(0, 3), ['serve', '--host', '127.0.0.1']);
  assert.ok(env.args.includes('--quantize'));
  assert.equal(Number(env.args[env.args.indexOf('--port') + 1]), st.port);
  assert.equal(env.HF_HOME, join(dir, 'pocket', 'data', 'hf'));
  assert.equal(env.HF_TOKEN, null, 'the token never reaches the engine, so it never loads cloning weights');
  assert.equal(engineEnv({ dir }, { HUGGING_FACE_HUB_TOKEN: 'x', PATH: 'p' }).HUGGING_FACE_HUB_TOKEN, undefined);
  assert.ok(existsSync(join(dir, 'pocket', 'data', 'pocket.pid.json')));
  const h = await launcher.health();
  assert.equal(h.processes[0].role, 'engine');
  assert.equal(launcher.stop(), true);
  assert.equal(existsSync(join(dir, 'pocket', 'data', 'pocket.pid.json')), false);
});

test('only a built-in voice name reaches the engine', async () => {
  const { launcher } = setup();
  await launcher.start();
  const read = async (voice) => Buffer.from(await (await launcher.tts({ text: 'Hi.', voice })).arrayBuffer()).toString();
  assert.equal(await read('marius'), 'RIFFvoice=marius');
  assert.equal(await read('https://example.com/someone.wav'), 'RIFFvoice=alba');
  assert.equal(await read('/etc/passwd'), 'RIFFvoice=alba');
  assert.equal(VOICES.length, 26);
  assert.deepEqual([...VOICES].sort(), loadCatalog().engines.pocket.versions[0].model.voices.map((v) => v.id).sort(), 'the catalog pins every voice');
});

test('stops after 10 idle minutes, never while reading', async () => {
  const { launcher, clock, idleStops } = setup();
  await launcher.start();
  launcher.begin();
  clock.now += 11 * 60_000;
  assert.equal(launcher.idleCheck(), false, 'reading');
  launcher.end();
  clock.now += 9 * 60_000;
  assert.equal(launcher.idleCheck(), false, '9 idle minutes');
  clock.now += 2 * 60_000;
  assert.equal(launcher.idleCheck(), true);
  assert.equal(launcher.owned(), false);
  assert.deepEqual(idleStops, ['no read for 10 min']);
});

test('a Pocket TTS left running by a killed hub is stopped at the next start', async () => {
  const { launcher, dir, killed } = setup();
  const orphan = createServer((req, res) => res.end('{"status":"healthy"}'));
  await new Promise((r) => orphan.listen(0, '127.0.0.1', r));
  mkdirSync(join(dir, 'pocket', 'data'), { recursive: true });
  writeFileSync(join(dir, 'pocket', 'data', 'pocket.pid.json'), JSON.stringify({ pid: 999999, port: orphan.address().port }));
  try {
    await launcher.start();
    assert.deepEqual(killed, [999999]);
  } finally {
    orphan.close();
  }
});

// ─── The hub's policy with Pocket TTS ─────────────────────────────────────
function fakeHeavy(id) {
  const k = { id, running: false, calls: [] };
  Object.assign(k, {
    owned: () => k.running,
    health: async () => (k.running ? { status: 'ok', speaking: false, modelLoaded: true } : null),
    status: async () => ({ id, state: k.running ? 'ready' : 'stopped', owned: k.running, modelLoaded: k.running, speaking: false, startsOnDemand: true, lastStartMs: 500, setup: null, voices: () => null }),
    start: async () => { k.calls.push('start'); k.running = true; return { state: 'ready', owned: true, startedMs: 500 }; },
    stop: () => { k.calls.push('stop'); const was = k.running; k.running = false; return was; },
    unload: async () => false,
    yieldTo: async () => { if (!k.running) return false; k.running = false; k.calls.push('yield'); return true; },
    voices: () => ({ engine: id, voices: ['alba'], defaultVoice: 'alba' }),
  });
  return k;
}

function hubWith() {
  const kokoro = fakeHeavy('kokoro');
  const pocket = fakeHeavy('pocket');
  const hub = createHub({
    kokoro, pocket,
    readers: { snapshot: () => ({ speaking: false, readers: [], readerRssMb: 0, lastReaderPeakRssMb: null }) },
    piperVoices: async () => ['en_US-ryan-high.onnx'], piperInstalled: () => true, env: {}, log: quiet,
  });
  return { hub, kokoro, pocket };
}

test('one heavy engine at a time: Pocket starting stops Kokoro, and back', async () => {
  const { hub, kokoro, pocket } = hubWith();
  await hub.ensure('kokoro');
  await hub.ensure('pocket');
  assert.equal(kokoro.running, false);
  assert.equal(pocket.running, true);
  await hub.ensure('kokoro');
  assert.equal(pocket.running, false);
  assert.deepEqual(hub.events().filter((e) => e.type === 'stop').map((e) => [e.engine, e.reason]), [
    ['kokoro', 'Pocket TTS became active'],
    ['pocket', 'Kokoro became active'],
  ]);
});

test('a Piper read stops a quiet Pocket TTS; memory pressure stops it rather than unloading', async () => {
  const { hub, pocket } = hubWith();
  await hub.ensure('pocket');
  assert.equal(await hub.yieldFor('piper'), true);
  assert.equal(pocket.running, false);
  await hub.ensure('pocket');
  await hub.setPressure('attention');
  assert.equal(pocket.running, false, 'it cannot unload, so it stops');
  await hub.setPressure('problem');
  await assert.rejects(hub.ensure('pocket'), (err) => err.code === 'low-memory' && /Pocket TTS/.test(err.message));
});

test('the engine list shows Pocket TTS with its state and cold start', async () => {
  const { hub } = hubWith();
  let entry = (await hub.list()).engines.find((e) => e.id === 'pocket');
  assert.equal(entry.state, 'idle');
  assert.match(entry.detail, /Starts when you read, about 1 s/);
  await hub.ensure('pocket');
  entry = (await hub.list()).engines.find((e) => e.id === 'pocket');
  assert.equal(entry.state, 'ready');
  assert.equal(entry.coldStart.estimateMs, 1100);
});

// ─── Through the hub's HTTP API ────────────────────────────────────────────
test('a Pocket read streams through the hub; unknown voices are refused', async () => {
  process.env.VOICEDOCK_ENGINES_DIR = mkdtempSync(join(tmpdir(), 'vd-pocket-hub-'));
  const { app } = require('../servers/piper/server.js');
  const s = setup();
  app.locals.pocket = s.launcher;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'chrome-extension://abc' }, body: JSON.stringify(body) });
  try {
    const res = await post({ engine: 'pocket', voice: 'jean', text: 'Hello there.' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.equal(await res.text(), 'RIFFvoice=jean');
    assert.equal((await post({ engine: 'pocket', voice: 'C:\\voice.wav', text: 'Hi' })).status, 400);
    const voices = await (await fetch(`${base}/engines/pocket/voices`)).json();
    assert.equal(voices.voices.length, 26);
    assert.equal(voices.defaultVoice, 'alba');
    const events = (await (await fetch(`${base}/hub/events`)).json()).events;
    assert.ok(events.some((e) => e.type === 'ready' && e.engine === 'pocket'));
  } finally {
    s.launcher.stop();
    server.close();
  }
});
