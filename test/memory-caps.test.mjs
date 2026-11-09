// Per-engine memory caps and the hub's own free-memory reading (plan 5.5,
// 5.6): soft caps wait for 30 s and a quiet moment, hard caps act at once;
// pressure from free memory holds 10 s to get worse and 60 s to get better,
// and stands down while N8 Tray pushes levels with a fresh lease.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createHub, softCapMb } = require('../servers/piper/hub/engines.js');
const { createPressureMonitor, levelFor, hostLeaseFresh } = require('../servers/piper/hub/pressure.js');
const { parseTasklistKb, freeGiB } = require('../servers/piper/hub/procmem.js');

const quiet = { log() {}, error() {} };

function heavy(id, rss) {
  const e = { id, running: true, rss, speaking: false, calls: [] };
  Object.assign(e, {
    owned: () => e.running,
    health: async () => (e.running ? { status: 'ok' } : null),
    status: async () => ({ id, state: e.running ? 'ready' : 'stopped', owned: e.running, rssMb: e.running ? e.rss : null, speaking: e.speaking, modelLoaded: e.running, startsOnDemand: true }),
    start: async () => { e.running = true; return { state: 'ready', startedMs: 1 }; },
    stop: () => { const was = e.running; e.running = false; e.calls.push('stop'); return was; },
    unload: async () => false,
    yieldTo: async () => false,
    voices: () => ({ voices: [] }),
  });
  return e;
}

function setup({ env = {}, kokoroMb = 500, pocketMb = 400 } = {}) {
  const clock = { now: Date.UTC(2026, 10, 9, 18) };
  const kokoro = heavy('kokoro', kokoroMb);
  const pocket = heavy('pocket', pocketMb);
  const hub = createHub({
    kokoro, pocket, env, log: quiet, now: () => clock.now,
    readers: { snapshot: () => ({ speaking: false, readers: [], readerRssMb: 0 }) },
    piperVoices: async () => ['a.onnx'], piperInstalled: () => true,
  });
  return { hub, kokoro, pocket, clock };
}

test('soft cap: over it for 30 s, the engine stops at the next quiet moment', async () => {
  const { hub, pocket, clock } = setup({ pocketMb: 1500 });
  assert.deepEqual(hub.caps('pocket'), { softMb: 1400, hardMb: 2100 });
  assert.deepEqual(await hub.checkCaps(), []);
  clock.now += 31_000;
  pocket.speaking = true;
  assert.deepEqual(await hub.checkCaps(), [], 'never mid-sentence');
  pocket.speaking = false;
  assert.deepEqual(await hub.checkCaps(), ['pocket']);
  assert.equal(pocket.running, false);
  const cap = hub.events().find((e) => e.type === 'cap');
  assert.deepEqual([cap.engine, cap.mb, cap.capMb, cap.hard], ['pocket', 1500, 1400, false]);
  assert.equal(hub.capStopMessage('pocket'), null, 'a soft stop cuts off no read');
});

test('dipping back under the soft cap resets the 30 s', async () => {
  const { hub, kokoro, clock } = setup({ kokoroMb: 950 });
  await hub.checkCaps();
  clock.now += 20_000;
  kokoro.rss = 800;
  await hub.checkCaps();
  kokoro.rss = 950;
  clock.now += 20_000;
  assert.deepEqual(await hub.checkCaps(), []);
  assert.equal(kokoro.running, true);
});

test('hard cap: stopped at once, even while speaking, and the read says why', async () => {
  const { hub, kokoro } = setup({ kokoroMb: 1400 });
  kokoro.speaking = true;
  assert.deepEqual(await hub.checkCaps(), ['kokoro']);
  assert.equal(kokoro.running, false);
  assert.match(hub.capStopMessage('kokoro'), /^Kokoro used 1400 MB, over its 1350 MB limit, so VoiceDock stopped it$/);
});

test('caps follow the environment; 0 turns them off', async () => {
  assert.equal(softCapMb('pocket', { VOICEDOCK_POCKET_SOFT_CAP_MB: '600' }), 600);
  assert.equal(softCapMb('kokoro', {}), 900);
  const { hub, pocket } = setup({ env: { VOICEDOCK_POCKET_SOFT_CAP_MB: '0' }, pocketMb: 9000 });
  assert.equal(hub.caps('pocket'), null);
  assert.deepEqual(await hub.checkCaps(), []);
  assert.equal(pocket.running, true);
  assert.equal((await hub.list()).engines.find((e) => e.id === 'pocket').caps, null);
});

// ─── Free memory without N8 Tray ─────────────────────────────────────────
test('levels from free memory, with 10% hysteresis on the way back', () => {
  const limits = { attentionGiB: 3, problemGiB: 1.5 };
  assert.equal(levelFor(8, 'ok', limits), 'ok');
  assert.equal(levelFor(2.9, 'ok', limits), 'attention');
  assert.equal(levelFor(1.4, 'ok', limits), 'problem');
  assert.equal(levelFor(1.6, 'problem', limits), 'problem', 'under 1.65 stays problem');
  assert.equal(levelFor(1.7, 'problem', limits), 'attention');
  assert.equal(levelFor(3.2, 'attention', limits), 'attention', 'under 3.3 stays attention');
  assert.equal(levelFor(3.4, 'attention', limits), 'ok');
});

test('the hub reads free memory: 10 s to get worse, 60 s to get better', async () => {
  const { hub, kokoro, clock } = setup();
  let free = 8;
  const monitor = createPressureMonitor({ hub, freeGiB: () => free, now: () => clock.now, log: quiet, env: {} });
  assert.equal(await monitor.tick(), 'ok');
  free = 2.5;
  assert.equal(await monitor.tick(), 'ok', 'just dropped');
  clock.now += 10_000;
  assert.equal(await monitor.tick(), 'attention');
  assert.equal(kokoro.running, true, 'attention unloads Kokoro, it does not stop it');
  free = 1.2;
  await monitor.tick();
  clock.now += 10_000;
  assert.equal(await monitor.tick(), 'problem');
  assert.equal(kokoro.running, false, 'problem stops engines that are not speaking');
  await assert.rejects(hub.ensure('pocket').then(() => hub.ensure('kokoro')), (err) => err.code === 'low-memory');
  free = 6;
  await monitor.tick();
  clock.now += 59_000;
  assert.equal(await monitor.tick(), 'problem', 'not yet 60 s');
  clock.now += 2_000;
  assert.equal(await monitor.tick(), 'ok');
  const pressure = hub.events().filter((e) => e.type === 'pressure');
  assert.deepEqual(pressure.map((e) => [e.level, e.source]), [['attention', 'hub'], ['problem', 'hub'], ['ok', 'hub']]);
  assert.equal(monitor.doc().source, 'hub');
  assert.equal(monitor.doc().freeGiB, 6);
});

test('N8 Tray pushing levels with a fresh lease takes over; a stale lease hands back', async () => {
  const { hub, clock } = setup();
  let fresh = true;
  const monitor = createPressureMonitor({ hub, freeGiB: () => 1, now: () => clock.now, leaseFresh: () => fresh, log: quiet, env: {} });
  monitor.pushed();
  assert.equal(monitor.source(), 'n8tray');
  clock.now += 20_000;
  assert.equal(await monitor.tick(), null);
  assert.equal(hub.pressure(), 'ok');
  fresh = false;
  assert.equal(monitor.source(), 'hub');
  await monitor.tick();
  clock.now += 10_000;
  assert.equal(await monitor.tick(), 'problem');
  assert.equal(createPressureMonitor({ hub, env: { VOICEDOCK_MEMORY_WATCH: '0' } }).source(), 'off');
});

test('the host lease is fresh only while it lists VoiceDock and beats', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'vd-lease-'));
  const now = () => Date.parse('2026-11-09T18:00:10Z');
  assert.equal(hostLeaseFresh({ runDir, now }), false, 'no lease');
  writeFileSync(join(runDir, 'host.json'), JSON.stringify({ heartbeat: '2026-11-09T18:00:00Z', hosting: ['voicedock'] }));
  assert.equal(hostLeaseFresh({ runDir, now }), true);
  writeFileSync(join(runDir, 'host.json'), JSON.stringify({ heartbeat: '2026-11-09T17:59:00Z', hosting: ['voicedock'] }));
  assert.equal(hostLeaseFresh({ runDir, now }), false, 'stale');
  writeFileSync(join(runDir, 'host.json'), JSON.stringify({ heartbeat: '2026-11-09T18:00:00Z', hosting: ['n8commentary'] }));
  assert.equal(hostLeaseFresh({ runDir, now }), false, 'not hosting VoiceDock');
});

test('memory readings: tasklist in any digit grouping, MemAvailable on Linux', () => {
  assert.equal(parseTasklistKb('"pocket-tts.exe","4242","Console","1","412,345 K"'), 412345);
  assert.equal(parseTasklistKb('"pocket-tts.exe","4242","Console","1","412.345 K"'), 412345);
  assert.equal(parseTasklistKb('INFO: No tasks are running'), null);
  const meminfo = 'MemTotal:       32000000 kB\nMemFree:          500000 kB\nMemAvailable:    4194304 kB\n';
  assert.equal(freeGiB({ platform: 'linux', readFile: () => meminfo }), 4);
  assert.equal(freeGiB({ platform: 'win32', freemem: () => 2 * 1024 ** 3 }), 2);
});
