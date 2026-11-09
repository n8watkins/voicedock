// The setup steps the settings page shows (extension/src/setup.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOs, NOT_RUNNING_HELP, OS_IDS, SETUP_FACTS, SETUP_STEPS, setupSteps } from '../extension/src/setup.js';

test('every engine has numbered steps for every OS, Windows first', () => {
  assert.deepEqual(OS_IDS, ['windows', 'macos', 'linux']);
  for (const engine of ['piper', 'kokoro']) {
    for (const os of OS_IDS) {
      const steps = setupSteps(engine, os);
      assert.ok(steps.length >= 3, `${engine} ${os}`);
      for (const step of steps) {
        assert.ok(step.title && step.title.length <= 30, `${engine} ${os}: short title "${step.title}"`);
        assert.ok(step.what && step.what.length <= 80, `${engine} ${os}: one-line what "${step.what}"`);
        for (const line of step.commands || []) assert.doesNotMatch(line, /&&/, 'one command per line, for PowerShell 5.1');
      }
    }
    assert.ok(SETUP_FACTS[engine].worked);
    for (const os of OS_IDS) assert.ok(NOT_RUNNING_HELP[engine].fix[os]);
  }
});

test('Windows uses PowerShell and backslashes; macOS and Linux use the shell scripts', () => {
  const win = setupSteps('kokoro', 'windows').flatMap((s) => s.commands || []).join('\n');
  assert.match(win, /setup\.ps1/);
  assert.match(win, /install\.ps1 \| iex/);
  assert.match(win, /voicedock\\servers\\kokoro/);
  for (const os of ['macos', 'linux']) {
    const lines = setupSteps('kokoro', os).flatMap((s) => s.commands || []).join('\n');
    assert.match(lines, /\.\/setup\.sh/);
    assert.match(lines, /install\.sh \| sh/);
  }
  assert.match(setupSteps('piper', 'windows').flatMap((s) => s.commands || []).join('\n'), /winget install/);
  assert.equal(setupSteps('nope', 'windows').length, 0);
  assert.ok(SETUP_STEPS.piper.macos);
});

test('detectOs reads the platform, defaulting to Windows', () => {
  assert.equal(detectOs({ userAgentData: { platform: 'Windows' } }), 'windows');
  assert.equal(detectOs({ userAgentData: { platform: 'macOS' } }), 'macos');
  assert.equal(detectOs({ platform: 'MacIntel' }), 'macos');
  assert.equal(detectOs({ platform: 'Linux x86_64' }), 'linux');
  assert.equal(detectOs({ userAgent: 'Mozilla/5.0 (X11; CrOS x86_64)' }), 'linux');
  assert.equal(detectOs({}), 'windows');
});
