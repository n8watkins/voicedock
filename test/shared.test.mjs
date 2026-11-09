import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HUB_URL,
  MAX_PROFILES,
  MAX_FAVORITES,
  fmt,
  uuid,
  defaultProfile,
  formatVoiceName,
  qualityFromFilename,
  formatBytes,
  pickDeviceVoice,
  PIPER_SETUP_COMMANDS,
} from '../extension/src/shared.js';

test('constants have expected values', () => {
  assert.equal(HUB_URL, 'http://127.0.0.1:7477');
  assert.equal(MAX_PROFILES, 5);
  assert.equal(MAX_FAVORITES, 5);
});

test('fmt renders one decimal place', () => {
  assert.equal(fmt(1), '1.0');
  assert.equal(fmt(2), '2.0');
  assert.equal(fmt(1.5), '1.5');
  assert.equal(fmt('0.5'), '0.5');
  assert.equal(fmt(0), '0.0');
});

test('uuid returns a non-empty unique string', () => {
  const a = uuid();
  const b = uuid();
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

test('defaultProfile has the expected shape', () => {
  assert.deepEqual(defaultProfile(), {
    id: 'default',
    name: 'Profile 1',
    engine: 'browser',
    voice: '',
    rate: 1.0,
    volume: 1.0,
  });
});

test('defaultProfile returns a fresh object each call', () => {
  const a = defaultProfile();
  const b = defaultProfile();
  assert.notEqual(a, b); // different references
  a.voice = 'changed';
  assert.equal(b.voice, ''); // mutation does not leak
});

test('formatVoiceName parses standard Piper filenames', () => {
  assert.equal(formatVoiceName('en_US-amy-medium.onnx'), 'Amy · Medium');
  assert.equal(formatVoiceName('en_GB-alan-low.onnx'), 'Alan · Low');
});

test('formatVoiceName falls back for empty or odd names', () => {
  assert.equal(formatVoiceName(''), 'Chrome default voice');
  assert.equal(formatVoiceName('', 'None'), 'None');
  assert.equal(formatVoiceName('weirdname.onnx'), 'weirdname');
});

test('qualityFromFilename maps quality tiers', () => {
  assert.equal(qualityFromFilename('en_US-amy-medium.onnx'), 'med');
  assert.equal(qualityFromFilename('en_US-amy-high.onnx'), 'high');
  assert.equal(qualityFromFilename('en_US-amy-low.onnx'), 'low');
  assert.equal(qualityFromFilename('en_US-amy-x_low.onnx'), 'x_low');
  assert.equal(qualityFromFilename('en_US-amy-unknown.onnx'), null);
});

test('formatBytes renders human-readable sizes', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(512), '1 KB'); // rounds
  assert.equal(formatBytes(2_000), '2 KB');
  assert.equal(formatBytes(5_000_000), '5 MB');
  assert.equal(formatBytes(2_500_000_000), '2.5 GB');
});

test('pickDeviceVoice prefers an on-device voice in the language, never an online one', () => {
  const voices = [
    { voiceName: 'Google US English', lang: 'en-US', remote: true },
    { voiceName: 'Hedda', lang: 'de-DE', remote: false },
    { voiceName: 'Daniel', lang: 'en-GB', remote: false },
    { voiceName: 'Samantha', lang: 'en-US', remote: false },
  ];
  assert.equal(pickDeviceVoice(voices, 'en-US'), 'Samantha');
  assert.equal(pickDeviceVoice(voices, 'en-AU'), 'Daniel');
  assert.equal(pickDeviceVoice(voices, 'fr-FR'), 'Hedda');
  assert.equal(pickDeviceVoice([{ voiceName: 'Google US English', lang: 'en-US', remote: true }], 'en-US'), '');
  assert.equal(pickDeviceVoice(undefined), '');
});

test('the Piper setup commands avoid "&&" so they work in Windows PowerShell 5.1', () => {
  assert.ok(PIPER_SETUP_COMMANDS.length >= 3);
  for (const line of PIPER_SETUP_COMMANDS) assert.doesNotMatch(line, /&&/);
  assert.equal(PIPER_SETUP_COMMANDS.at(-1), 'npm run setup');
});
