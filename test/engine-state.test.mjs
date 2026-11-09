// The one engine-state vocabulary (extension/src/shared.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineState, markEngineSeen, probeEngine, STATUS_LABEL, STATUS_SHORT } from '../extension/src/shared.js';

test('engine states: ready, starting, installed but not running, not installed, checking', () => {
  assert.equal(engineState('piper', { status: 'ok' }, null), 'ready');
  assert.equal(engineState('kokoro', { status: 'ok', modelLoading: true }, null), 'starting');
  assert.equal(engineState('kokoro', { status: 'ok', modelLoaded: false }, null), 'ready', 'an unloaded model is still ready');
  assert.equal(engineState('kokoro', null, '2026-11-03T10:00:00Z'), 'stopped', 'answered before, not now');
  assert.equal(engineState('kokoro', null, undefined), 'missing', 'never answered');
  assert.equal(engineState('piper', undefined, 'x'), 'checking');
  assert.equal(engineState('browser', null, null), 'ready', 'the Basic voice needs no server');
  assert.equal(STATUS_LABEL.stopped, 'Installed but not running');
  assert.equal(STATUS_SHORT.stopped, 'Not running');
  assert.equal(STATUS_LABEL.missing, 'Not installed');
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

test('probeEngine returns /health JSON, a stand-in for non-JSON, or null', async () => {
  const ok = (body) => async () => ({ ok: true, json: async () => body });
  assert.deepEqual(await probeEngine('piper', { fetchImpl: ok({ status: 'ok', engine: 'piper' }) }), { status: 'ok', engine: 'piper' });
  assert.deepEqual(await probeEngine('piper', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('x'); } }) }), { status: 'ok' });
  assert.equal(await probeEngine('piper', { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await probeEngine('piper', { fetchImpl: async () => { throw new Error('refused'); } }), null);
  assert.equal(await probeEngine('browser', { fetchImpl: ok({}) }), null, 'no server to ask');
  let url = '';
  await probeEngine('kokoro', { fetchImpl: async (u) => { url = u; return { ok: false }; } });
  assert.equal(url, 'http://127.0.0.1:7478/health');
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
