// The popup's voice catalog (extension/src/voices.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVoiceCatalog, filterVoices, languagesIn, rowForProfile } from '../extension/src/voices.js';

const rows = buildVoiceCatalog({
  piper: ['en_US-ryan-high.onnx', 'es_ES-davefx-medium.onnx'],
  kokoro: ['af_heart', 'ff_siwis'],
  browser: [
    { voiceName: 'Microsoft Zira - English (United States)', lang: 'en-US', remote: false },
    { voiceName: 'Google US English', lang: 'en-US', remote: true },
  ],
});

test('every engine is in one list, with friendly names and no online voices', () => {
  assert.deepEqual(rows.map((r) => `${r.engine}:${r.name}`), [
    'piper:Ryan', 'piper:Davefx', 'kokoro:Heart', 'kokoro:Siwis', 'browser:Automatic', 'browser:Microsoft Zira',
  ]);
  assert.equal(rows[0].meta, 'US English');
  assert.equal(rows[0].tag, 'High');
  assert.equal(rows[2].meta, 'US English · female');
  assert.equal(rows[5].meta, 'US English');
  assert.deepEqual(languagesIn(rows), ['English', 'French', 'Spanish']);
});

test('search and the language filter', () => {
  assert.deepEqual(filterVoices(rows, { query: 'kokoro' }).map((r) => r.name), ['Heart', 'Siwis']);
  assert.deepEqual(filterVoices(rows, { query: 'zira' }).map((r) => r.name), ['Microsoft Zira']);
  assert.deepEqual(filterVoices(rows, { language: 'Spanish' }).map((r) => r.name), ['Davefx', 'Automatic']);
});

test('the profile’s current voice, or a stand-in while its engine is away', () => {
  assert.equal(rowForProfile(rows, { engine: 'kokoro', voice: 'af_heart' }).name, 'Heart');
  assert.equal(rowForProfile(rows, { engine: 'piper', voice: '' }, { piper: 'en_US-ryan-high.onnx' }).name, 'Ryan');
  assert.equal(rowForProfile([], { engine: 'kokoro', voice: 'bm_george' }).name, 'George');
  assert.equal(rowForProfile([], { engine: 'piper', voice: '' }).name, 'Default voice');
  assert.equal(rowForProfile(rows, { engine: 'browser', voice: '' }).name, 'Automatic');
});
