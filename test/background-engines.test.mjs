// End-to-end engine routing inside the service worker: every read goes to the
// hub with the profile's engine, an engine the hub can't run falls back to the
// browser voice (or stays silent when the fallback is off), and the heartbeat
// reaches the hub. Runs background.js under a chrome shim with fetch mocked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const calls = { runtime: [], tts: [], hints: [], notes: [], injected: [], tabMessages: [], created: [] };
const ttsVoices = { list: null }; // null: the default list below
// Tabs as the page script sees them: which have the page script running, which
// Chrome lets the extension script (activeTab granted), and their selection.
const pages = { scripted: new Set(), scriptable: new Set([7, 42]), selection: { 42: 'Hello there' } };
const store = { fallback: true };
const listeners = {};

const event = (name) => ({ addListener: (fn) => { (listeners[name] ||= []).push(fn); } });
globalThis.chrome = {
  runtime: {
    lastError: null,
    onInstalled: event('runtime.onInstalled'),
    onStartup: event('runtime.onStartup'),
    onMessage: event('runtime.onMessage'),
    getURL: (p) => 'chrome-extension://test/' + p,
    getContexts: async () => [],
    sendMessage: async (msg) => { calls.runtime.push(msg); return { ok: true }; },
  },
  storage: {
    onChanged: event('storage.onChanged'),
    local: {
      get: async (keys) => {
        if (keys === null) return structuredClone(store);
        const list = [].concat(keys);
        return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
      },
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
    },
  },
  contextMenus: { onClicked: event('contextMenus.onClicked'), removeAll: async () => {}, create: () => {}, update: async () => {} },
  commands: { onCommand: event('commands.onCommand') },
  tts: {
    stop() {}, pause() {}, resume() {},
    speak(text, opts) { calls.tts.push({ text, opts }); if (ttsVoices.failNext) { ttsVoices.failNext = false; opts.onEvent?.({ type: 'error', errorMessage: 'No audio device.' }); } },
    // An online Google voice listed first, then on-device voices.
    getVoices: async () => ttsVoices.list ?? [
      { voiceName: 'Google US English', lang: 'en-US', remote: true },
      { voiceName: 'Microsoft Zira', lang: 'en-US', remote: false },
      { voiceName: 'Microsoft Hedda', lang: 'de-DE', remote: false },
    ],
  },
  tabs: {
    onRemoved: event('tabs.onRemoved'),
    query: async () => [],
    create: async (props) => { calls.created.push(props.url); return { id: 1 }; },
    sendMessage: async (tabId, msg) => {
      if (!pages.scripted.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
      calls.tabMessages.push({ tabId, type: msg.type });
      if (msg.type === 'ping') return { ok: true };
      if (msg.type === 'get-selection') return { text: pages.selection[tabId] || '' };
      if (msg.type === 'show-hint') calls.hints.push({ tabId, message: msg.message });
      if (msg.type === 'show-note') calls.notes.push({ tabId, note: msg.note });
      return undefined;
    },
  },
  scripting: {
    executeScript: async ({ target, files }) => {
      if (!pages.scriptable.has(target.tabId)) throw new Error('Cannot access contents of the page.');
      calls.injected.push({ tabId: target.tabId, files });
      pages.scripted.add(target.tabId);
      return [{}];
    },
  },
  offscreen: { createDocument: async () => {} },
};

// A fake hub: GET /engines reports each engine's state, and it records
// warm-ups and heartbeats.
const hub = { up: true, piper: 'ready', kokoro: 'ready', warms: 0, presence: [], requests: [] };
globalThis.fetch = async (url, init = {}) => {
  hub.requests.push(`${init.method || 'GET'} ${url}`);
  if (!hub.up) throw new TypeError('fetch failed');
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  if (url === 'http://127.0.0.1:7477/engines') {
    const entry = (id) => ({ id, state: hub[id], installed: !['not-installed', 'needs-setup'].includes(hub[id]), coldStart: { estimateMs: 3400 } });
    return json(200, { api: 2, pressure: 'ok', engines: [entry('piper'), entry('kokoro')] });
  }
  if (url === 'http://127.0.0.1:7477/engines/kokoro/warm' && init.method === 'POST') {
    hub.warms += 1;
    return json(202, { outcome: 'ok', state: 'starting' });
  }
  if (url === 'http://127.0.0.1:7477/presence' && init.method === 'POST') {
    hub.presence.push(JSON.parse(init.body));
    return json(200, { ok: true });
  }
  return json(404, { error: 'Not found.' });
};
globalThis.chrome.runtime.getManifest = () => ({ version: '1.2.0' });

await import('../extension/background.js');
const onMessage = listeners['runtime.onMessage'][0];
const onCommand = listeners['commands.onCommand'][0];
const onMenuClick = listeners['contextMenus.onClicked'][0];
const settle = () => new Promise((r) => setTimeout(r, 20));

function send(message, sender = {}) {
  return new Promise((resolve) => {
    const keepOpen = onMessage(message, sender, resolve);
    if (keepOpen !== true) resolve(undefined);
  });
}

async function stop() {
  await send({ type: 'stop-all' });
}

beforeEach(async () => {
  await stop();
  calls.runtime.length = 0;
  calls.tts.length = 0;
  calls.hints.length = 0;
  calls.notes.length = 0;
  ttsVoices.list = null;
  ttsVoices.failNext = false;
  calls.injected.length = 0;
  calls.tabMessages.length = 0;
  pages.scripted.clear();
  Object.assign(hub, { up: true, piper: 'ready', kokoro: 'ready', warms: 0 });
  hub.presence.length = 0;
  hub.requests.length = 0;
  store.fallback = true;
});

const speakTextMessages = () => calls.runtime.filter((m) => m.type === 'speak-text');

test('a Kokoro profile is sent to the hub with its engine', async () => {
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'kokoro', voice: 'bf_emma', rate: 1.2, volume: 0.8 } });
  assert.deepEqual(res, { ok: true, engine: 'kokoro', fellBack: false });
  const [msg] = speakTextMessages();
  assert.equal(msg.engine, 'kokoro');
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7477/tts');
  assert.equal(msg.voice, 'bf_emma');
  assert.equal(msg.rate, 1.2);
  assert.equal(calls.tts.length, 0);
  assert.equal(hub.requests.some((r) => r.includes(':7478')), false, 'never Kokoro\'s own port');
});

test('a Piper profile (old voice-only shape) is sent to the hub', async () => {
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { voice: 'en_US-amy-medium.onnx' } });
  assert.equal(res.engine, 'piper');
  const [msg] = speakTextMessages();
  assert.equal(msg.engine, 'piper');
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7477/tts');
  assert.equal(msg.voice, 'en_US-amy-medium.onnx');
});

test('with the hub not running, Kokoro falls back to the Basic voice and the page says why', async () => {
  hub.up = false;
  store.engineSeen = { kokoro: '2026-11-09T08:00:00.000Z' };
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.equal(speakTextMessages().length, 0, 'nothing is sent to the hub');
  assert.equal(calls.tts.length, 1);
  assert.equal(calls.tts[0].text, 'Hello there');
  const lastNote = () => calls.notes.filter((n) => n.note).at(-1)?.note;
  assert.deepEqual(lastNote(), { tone: 'warn', text: 'Kokoro is not running. Reading with the Basic voice.', fix: { label: 'How to start', engine: 'kokoro' } });
  assert.deepEqual(calls.notes[0], { tabId: 42, note: null }, 'a new read clears the last note first');

  delete store.engineSeen;
  await stop();
  calls.notes.length = 0;
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.deepEqual(lastNote(), { tone: 'warn', text: 'Kokoro is not set up. Reading with the Basic voice.', fix: { label: 'Set up Kokoro', engine: 'kokoro' } }, 'never set up here');
});

test('a Kokoro on standby reads through the hub, which starts it; the page says how long', async () => {
  hub.kokoro = 'idle';
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  onCommand('read-selection', { id: 42 });
  await settle();
  const [msg] = speakTextMessages();
  assert.equal(msg.engine, 'kokoro');
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7477/tts');
  assert.equal(calls.tts.length, 0, 'the Basic voice did not read');
  assert.deepEqual(calls.hints, [{ tabId: 42, message: 'Starting Kokoro, about 3 s' }]);
  const state = await send({ type: 'get-playback-state' }, { tab: { id: 42 } });
  assert.equal(state.starting, 'kokoro');
  assert.equal(state.startingText, 'Starting Kokoro, about 3 s');
  await send({ type: 'engine-audio', engine: 'kokoro' });
  assert.equal((await send({ type: 'get-playback-state' }, { tab: { id: 42 } })).starting, null, 'first audio: started');
});

test('a Kokoro that is not set up leads to the Basic voice', async () => {
  hub.kokoro = 'not-installed';
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.equal(speakTextMessages().length, 0);
  assert.equal(calls.tts.length, 1);
  assert.equal(calls.notes.at(-1).note.text, 'Kokoro is not set up. Reading with the Basic voice.');
  assert.equal(calls.notes.at(-1).note.fix.label, 'Set up Kokoro');
});

test('warm-engine asks the hub to start Kokoro without reading, and checks in', async () => {
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  for (const fn of listeners['runtime.onMessage']) fn({ type: 'warm-engine', engine: 'kokoro' }, {}, () => {});
  await settle();
  assert.equal(hub.warms, 1);
  assert.equal(speakTextMessages().length, 0);
  assert.deepEqual(hub.presence, [{ extensionVersion: '1.2.0', activeEngine: 'kokoro', reading: false }]);
});

test('every read with a local engine sends a heartbeat; the Basic voice never touches the hub', async () => {
  store.profiles = [{ id: 'p', name: 'P', engine: 'piper', voice: 'en_US-amy-medium.onnx', rate: 1, volume: 1 }];
  store.activeId = 'p';
  await send({ type: 'test-voice', text: 'Hi', settings: store.profiles[0] });
  await settle();
  assert.deepEqual(hub.presence.at(-1), { extensionVersion: '1.2.0', activeEngine: 'piper', reading: true });

  hub.requests.length = 0;
  store.profiles = [{ id: 'b', name: 'B', engine: 'browser', voice: '', rate: 1, volume: 1 }];
  store.activeId = 'b';
  for (const fn of listeners['runtime.onMessage']) fn({ type: 'presence' }, {}, () => {});
  await send({ type: 'test-voice', text: 'Hi', settings: store.profiles[0] });
  await settle();
  assert.deepEqual(hub.requests, [], 'nobody on a local engine: no heartbeat, no checks');
});

test('the shortcut adds the page script to the tab it was pressed on, then reads its selection', async () => {
  store.profiles = [{ id: 'p', name: 'P', engine: 'piper', voice: 'en_US-amy-medium.onnx', rate: 1, volume: 1 }];
  store.activeId = 'p';
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.deepEqual(calls.injected, [{ tabId: 42, files: ['dist/page.js'] }]);
  const [msg] = speakTextMessages();
  assert.equal(msg.text, 'Hello there');
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7477/tts');
});

test('a page that already has the page script is not injected again', async () => {
  pages.scripted.add(42);
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.deepEqual(calls.injected, []);
  assert.ok(calls.tabMessages.some((m) => m.tabId === 42 && m.type === 'get-selection'));
});

test('the shortcut on a page Chrome does not let extensions script does nothing', async () => {
  onCommand('read-selection', { id: 99 });
  await settle();
  assert.deepEqual(calls.injected, []);
  assert.equal(calls.tts.length, 0);
  assert.equal(speakTextMessages().length, 0);
});

test('the right-click menu adds the player bar to that page, and playback state goes only there', async () => {
  store.profiles = [{ id: 'p', name: 'P', engine: 'piper', voice: 'en_US-amy-medium.onnx', rate: 1, volume: 1 }];
  store.activeId = 'p';
  await onMenuClick({ menuItemId: 'read-selection', selectionText: 'Read me' }, { id: 7 });
  await settle();
  assert.deepEqual(calls.injected, [{ tabId: 7, files: ['dist/page.js'] }]);
  assert.equal(speakTextMessages()[0].text, 'Read me');
  const stateTabs = new Set(calls.tabMessages.filter((m) => m.type === 'playback-state').map((m) => m.tabId));
  assert.deepEqual([...stateTabs], [7]);
});

test('reading still works from the menu on a page the player bar cannot be added to', async () => {
  store.profiles = [{ id: 'p', name: 'P', engine: 'piper', voice: 'en_US-amy-medium.onnx', rate: 1, volume: 1 }];
  store.activeId = 'p';
  await onMenuClick({ menuItemId: 'read-selection', selectionText: 'Read me' }, { id: 99 });
  await settle();
  assert.deepEqual(calls.injected, []);
  assert.equal(speakTextMessages()[0].text, 'Read me');
});

test('the Test button reports a fallback', async () => {
  hub.up = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'piper', voice: '' } });
  assert.deepEqual(res, { ok: true, engine: 'browser', fellBack: true });
  assert.equal(calls.tts.length, 1);
});

test('with the fallback off, an engine that cannot run reports an error and stays silent', async () => {
  hub.kokoro = 'failed';
  store.fallback = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'kokoro', voice: 'af_heart' } });
  assert.deepEqual(res, { ok: false, engine: null, fellBack: false, error: 'Kokoro is not running' });
  assert.equal(calls.tts.length, 0);
  assert.equal(speakTextMessages().length, 0);
});

test('the Basic voice never touches a server', async () => {
  hub.up = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'browser' } });
  assert.deepEqual(res, { ok: true, engine: 'browser', fellBack: false });
  assert.equal(calls.tts.length, 1);
});

test('the Basic voice reads with an on-device voice, not an online one', async () => {
  await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'browser' } });
  assert.equal(calls.tts[0].opts.voiceName, 'Microsoft Zira');
});

test('a new install opens the Get started page; an update does not', async () => {
  calls.created.length = 0;
  for (const fn of listeners['runtime.onInstalled']) fn({ reason: 'update' });
  await settle();
  assert.deepEqual(calls.created, []);
  for (const fn of listeners['runtime.onInstalled']) fn({ reason: 'install' });
  await settle();
  assert.deepEqual(calls.created, ['chrome-extension://test/options.html#welcome']);
});

test('install runs the settings migration', async () => {
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, {
    profiles: [{ id: 'x', name: 'X', voice: 'en_US-amy-medium.onnx', rate: 1, volume: 1 }],
    favorites: ['en_US-amy-medium.onnx'],
    fallbackToBrowser: true,
  });
  for (const fn of listeners['runtime.onInstalled']) fn({ reason: 'update' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.profiles[0].engine, 'piper');
  assert.deepEqual(store.favoritesByEngine, { piper: ['en_US-amy-medium.onnx'], kokoro: [], pocket: [] });
  assert.equal(store.fallback, true);
  assert.equal('favorites' in store, false);
});

// ─── Notes on the page (the player bar's error states) ──────────────────────
async function readKokoroFromTab() {
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  pages.selection[42] = 'First sentence is here. Second sentence is here. Third sentence is here.';
  onCommand('read-selection', { id: 42 });
  await settle();
}

test('Kokoro stops mid-read: the Basic voice reads on from that sentence, and the note says so', async () => {
  await readKokoroFromTab();
  assert.equal(speakTextMessages().length, 1);
  await send({ type: 'playback-error', engine: 'kokoro', reason: 'failed', index: 1, error: 'Kokoro did not answer.' });
  await settle();
  assert.deepEqual(calls.tts.map((t) => t.text), ['Second sentence is here.'], 'on from sentence 2, not from the top');
  assert.deepEqual(calls.notes.at(-1), { tabId: 42, note: { tone: 'warn', text: 'Kokoro stopped. Reading on with the Basic voice.', fix: { label: 'How to start', engine: 'kokoro' } } });
  pages.selection[42] = 'Hello there';
});

test('low memory mid-read says why and offers no fix to chase', async () => {
  await readKokoroFromTab();
  await send({ type: 'playback-error', engine: 'kokoro', reason: 'low-memory', index: 2, error: 'Memory is low.' });
  await settle();
  assert.deepEqual(calls.notes.at(-1).note, { tone: 'warn', text: 'Memory is low, so Kokoro stopped. Reading on with the Basic voice.', fix: null });
  pages.selection[42] = 'Hello there';
});

test('with the fallback off, a failed engine leaves a red note and nothing reads', async () => {
  store.fallback = false;
  await readKokoroFromTab();
  await send({ type: 'playback-error', engine: 'kokoro', reason: 'failed', index: 1, error: 'x' });
  await settle();
  assert.equal(calls.tts.length, 0);
  assert.deepEqual(calls.notes.at(-1).note, { tone: 'err', text: 'Kokoro stopped while reading, and the Basic voice fallback is off.', fix: { label: 'How to start', engine: 'kokoro' } });

  hub.kokoro = 'not-installed';
  await stop();
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.deepEqual(calls.notes.at(-1).note, { tone: 'err', text: 'Kokoro is not set up, and the Basic voice fallback is off.', fix: { label: 'Set up Kokoro', engine: 'kokoro' } });
  pages.selection[42] = 'Hello there';
});

test('a chrome.tts error always leaves a note', async () => {
  store.profiles = [{ id: 'b', name: 'B', engine: 'browser', voice: '', rate: 1, volume: 1 }];
  store.activeId = 'b';
  ttsVoices.failNext = true;
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.deepEqual(calls.notes.at(-1).note, { tone: 'err', text: 'The Basic voice could not read this: No audio device.', fix: null });
});

test('no system voice and no engine: nothing to read with, and the note offers Piper', async () => {
  hub.up = false;
  ttsVoices.list = [];
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.equal(calls.tts.length, 0);
  assert.deepEqual(calls.notes.at(-1).note, { tone: 'err', text: 'Nothing to read with. This computer has no built-in voice, and no engine is ready.', fix: { label: 'Set up Piper', engine: 'piper' } });
  const state = await send({ type: 'get-playback-state' }, { tab: { id: 42 } });
  assert.equal(state.isPlaying, false, 'not stuck "playing" silence');
});

test("a note's fix opens that engine's guided setup", async () => {
  calls.created.length = 0;
  await send({ type: 'open-setup', engine: 'kokoro' });
  await send({ type: 'open-setup', engine: '../evil' });
  assert.deepEqual(calls.created, ['chrome-extension://test/options.html#engines:kokoro', 'chrome-extension://test/options.html#engines']);
});
