// tools/check-names.mjs: the old product name fails the build unless a line
// marks itself as a back-compat exception.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOldNames } from '../tools/check-names.mjs';

const OLD = ['Piper', 'TTS'].join(' ');

test('every spelling of the old name is caught', () => {
  for (const text of [OLD, 'piper-tts', 'PIPER_TTS_WINDOWS_USER', 'PiperTtsLocalServer', 'com.n8.pipertts.tray']) { // legacy-name
    assert.equal(findOldNames('x.js', `a\n${text}\n`).length, 1, text);
  }
  assert.deepEqual(findOldNames('x.js', 'Piper reads fast. Kokoro TTS server.'), [], 'the engine names alone are fine');
});

test('a marked back-compat line passes, and the hit names the file and line', () => {
  assert.deepEqual(findOldNames('x.ps1', `"${OLD} Tray.lnk" # legacy-name`), []);
  assert.deepEqual(findOldNames('a/b.md', `ok\n${OLD} here`), [{ path: 'a/b.md', line: 2, text: `${OLD} here` }]);
});
