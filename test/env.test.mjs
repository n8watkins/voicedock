// tools/env.mjs: VOICEDOCK_* settings, with the old names still accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envSetting } from '../tools/env.mjs';

test('VOICEDOCK_* wins, the old name still works with a note, and unset is undefined', () => {
  const notes = [];
  const warn = (m) => notes.push(m);
  assert.equal(envSetting('WINDOWS_USER', { VOICEDOCK_WINDOWS_USER: 'a', PIPER_TTS_WINDOWS_USER: 'b' }, warn), 'a'); // legacy-name
  assert.equal(notes.length, 0);
  assert.equal(envSetting('WINDOWS_USER', { PIPER_TTS_WINDOWS_USER: 'b' }, warn), 'b'); // legacy-name
  assert.match(notes[0], /old name of VOICEDOCK_WINDOWS_USER/);
  assert.equal(envSetting('WINDOWS_USER', { VOICEDOCK_WINDOWS_USER: '' }, warn), undefined);
  assert.equal(envSetting('CHROME_PATH', {}, warn), undefined);
});
