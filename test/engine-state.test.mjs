// The one engine-state vocabulary (extension/src/shared.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  engineDetail, engineInstalled, engineState, engineUsable, fetchEngines, markEngineSeen, startingText,
  STATUS_LABEL, STATUS_SHORT, unavailableReason, voicesUrl,
} from '../extension/src/shared.js';

const hubWith = (engines, api = 2) => ({ reachable: true, api, engines: Object.fromEntries(engines.map((e) => [e.id, e])) });
const DOWN = { reachable: false, api: 0, engines: {} };

test('the hub decides: ready, starting, standby, not installed', () => {
  const hub = hubWith([
    { id: 'piper', state: 'ready', installed: true },
    { id: 'kokoro', state: 'idle', installed: true, coldStart: { estimateMs: 3400 } },
  ]);
  assert.equal(engineState('piper', hub, null), 'ready');
  assert.equal(engineState('kokoro', hub, null), 'standby', 'set up, not running: starts when you read');
  assert.equal(engineState('kokoro', hubWith([{ id: 'kokoro', state: 'starting' }]), null), 'starting');
  assert.equal(engineState('kokoro', hubWith([{ id: 'kokoro', state: 'not-installed' }]), 'x'), 'missing', 'the hub knows better than memory');
  assert.equal(engineState('kokoro', hubWith([{ id: 'kokoro', state: 'needs-setup' }]), null), 'missing');
  assert.equal(engineState('kokoro', hubWith([{ id: 'kokoro', state: 'failed' }]), null), 'stopped');
  assert.equal(engineState('kokoro', hubWith([{ id: 'kokoro', state: 'stopped' }]), null), 'stopped', 'kept off for low memory');
  assert.equal(engineState('kokoro', hubWith([]), null), 'missing', 'an engine the hub does not list');
  assert.equal(engineState('piper', undefined, 'x'), 'checking');
  assert.equal(engineState('browser', undefined, null), 'ready', 'the Basic voice needs no server');
  assert.equal(STATUS_LABEL.stopped, 'Installed but not running');
  assert.equal(STATUS_SHORT.stopped, 'Not running');
  assert.equal(STATUS_LABEL.missing, 'Not installed');
  assert.equal(STATUS_LABEL.standby, 'Starts when you read');
  for (const state of ['ready', 'starting', 'standby']) assert.equal(engineUsable(state), true, state);
  for (const state of ['stopped', 'missing', 'checking']) assert.equal(engineUsable(state), false, state);
});

test('with the hub not running, set-up engines are installed but not running', () => {
  assert.equal(engineState('kokoro', DOWN, '2026-11-03T10:00:00Z'), 'stopped');
  assert.equal(engineState('kokoro', DOWN, undefined), 'missing');
  assert.equal(engineDetail('kokoro', DOWN, 'stopped'), "VoiceDock's local server is not running.");
  assert.equal(engineDetail('kokoro', DOWN, 'missing'), 'Kokoro is not set up on this computer.');
});

test('an older Piper server still reads with Piper; Kokoro needs the update', () => {
  const old = { reachable: true, api: 1, engines: {} };
  assert.equal(engineState('piper', old, null), 'ready');
  assert.equal(engineState('kokoro', old, 'x'), 'stopped');
  assert.equal(engineDetail('kokoro', old, 'stopped'), "Update VoiceDock's local server to read with Kokoro.");
});

test('engineInstalled, reasons and the starting line', () => {
  const hub = hubWith([{ id: 'kokoro', state: 'idle', installed: true, coldStart: { estimateMs: 3400 } }]);
  assert.equal(engineInstalled('kokoro', hub), true);
  assert.equal(engineInstalled('piper', hub), false);
  assert.equal(engineInstalled('kokoro', DOWN), false);
  assert.equal(startingText('kokoro', hub), 'Starting Kokoro, about 3 s');
  assert.equal(startingText('kokoro', DOWN), 'Starting Kokoro, about 5 s', 'the plan estimate until measured');
  assert.equal(unavailableReason('kokoro', 'missing'), 'Kokoro is not set up');
  assert.equal(unavailableReason('piper', 'stopped'), 'Piper is not running');
});

test('voices are listed through the hub, so listing never starts Kokoro', () => {
  assert.equal(voicesUrl('kokoro'), 'http://127.0.0.1:7477/engines/kokoro/voices');
  assert.equal(voicesUrl('piper'), 'http://127.0.0.1:7477/voices');
  assert.equal(voicesUrl('browser'), null);
});

test('fetchEngines reads GET /engines, an old hub, or a hub that is down', async () => {
  let url = '';
  const ok = async (u) => { url = u; return { ok: true, json: async () => ({ api: 2, pressure: 'ok', engines: [{ id: 'piper', state: 'ready' }, { id: 'kokoro', state: 'idle' }] }) }; };
  const hub = await fetchEngines({ fetchImpl: ok });
  assert.equal(url, 'http://127.0.0.1:7477/engines');
  assert.equal(hub.reachable, true);
  assert.equal(hub.api, 2);
  assert.deepEqual(Object.keys(hub.engines), ['piper', 'kokoro']);
  const old = await fetchEngines({ fetchImpl: async () => ({ ok: true, json: async () => ({ engines: [{ id: 'kokoro', state: 'stopped' }] }) }) });
  assert.equal(old.api, 1);
  assert.deepEqual(await fetchEngines({ fetchImpl: async () => ({ ok: false }) }), { reachable: true, api: 1, engines: {} });
  assert.deepEqual(await fetchEngines({ fetchImpl: async () => { throw new TypeError('down'); } }), DOWN);
});

test('markEngineSeen writes at most once a day per engine', () => {
  const day1 = new Date('2026-11-09T08:00:00Z');
  const first = markEngineSeen(undefined, 'kokoro', day1);
  assert.deepEqual(first, { kokoro: '2026-11-09T08:00:00.000Z' });
  assert.equal(markEngineSeen(first, 'kokoro', new Date('2026-11-09T20:00:00Z')), null);
  const next = markEngineSeen(first, 'piper', day1);
  assert.deepEqual(Object.keys(next).sort(), ['kokoro', 'piper']);
  assert.equal(markEngineSeen(first, 'kokoro', new Date('2026-11-10T01:00:00Z')).kokoro, '2026-11-10T01:00:00.000Z');
});

test('Piper voice names read as people say them', async () => {
  const { piperVoiceDetails, describeLocale } = await import('../extension/src/shared.js');
  assert.deepEqual(piperVoiceDetails('en_US-ryan-high.onnx'), { name: 'Ryan', language: 'US English', baseLanguage: 'English', quality: 'High' });
  assert.equal(piperVoiceDetails('en_US-libritts_r-medium.onnx').name, 'LibriTTS R');
  assert.equal(piperVoiceDetails('de_DE-thorsten-x_low.onnx').quality, 'Extra low');
  assert.equal(piperVoiceDetails('es_MX-claude-high.onnx').language, 'Spanish (Mexico)');
  assert.equal(piperVoiceDetails('nonsense'), null);
  assert.deepEqual(describeLocale('fr-FR'), { language: 'French (France)', baseLanguage: 'French' });
  assert.deepEqual(describeLocale('en-GB'), { language: 'UK English', baseLanguage: 'English' });
});

test('text splits into sentences: short fragments join, long ones break at a comma', async () => {
  const { splitSentences, sentenceLabel } = await import('../extension/src/shared.js');
  assert.deepEqual(splitSentences('For most of history, reading was done out loud. Silent reading was rare!  Now   it is coming back?'),
    ['For most of history, reading was done out loud.', 'Silent reading was rare!', 'Now it is coming back?']);
  assert.deepEqual(splitSentences('Dr. Smith went home. He slept.'), ['Dr. Smith went home. He slept.']);
  assert.deepEqual(splitSentences('No trailing period here'), ['No trailing period here']);
  assert.deepEqual(splitSentences('"Quoted." Then a longer second sentence follows here.'), ['"Quoted." Then a longer second sentence follows here.']);
  assert.deepEqual(splitSentences(''), []);
  const long = `${'word '.repeat(50)}, ${'more '.repeat(60)}end.`;
  const parts = splitSentences(long);
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 320), parts.map((p) => p.length).join());
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' ').trim());
  assert.equal(sentenceLabel({ current: 3, total: 6 }), 'Sentence 3 of 6');
  assert.equal(sentenceLabel({ current: 0, total: 6 }), 'Starting');
  assert.equal(sentenceLabel({ current: 1, total: 1 }), 'One sentence');
});
