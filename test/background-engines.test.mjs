// End-to-end engine routing inside the service worker: a profile's engine
// decides which local server the offscreen player is pointed at, and an engine
// that is down falls back to the browser voice (or stays silent when the
// fallback is off). Runs background.js under a chrome shim with fetch mocked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const online = { 'http://127.0.0.1:7477': true, 'http://127.0.0.1:7478': true };
const calls = { runtime: [], tts: [], hints: [], injected: [], tabMessages: [], created: [] };
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
    speak(text, opts) { calls.tts.push({ text, opts }); },
    // An online Google voice listed first, then on-device voices.
    getVoices: async () => [
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

// The Piper server can start Kokoro on demand when hub.canStart is set.
const hub = { canStart: false, starts: 0 };
globalThis.fetch = async (url, init = {}) => {
  if (url === 'http://127.0.0.1:7477/engines/kokoro/start' && init.method === 'POST') {
    if (!online['http://127.0.0.1:7477']) throw new TypeError('fetch failed');
    if (!hub.canStart) return { ok: false, status: 404, json: async () => ({ error: 'Not found.' }) };
    hub.starts += 1;
    online['http://127.0.0.1:7478'] = true;
    return { ok: true, json: async () => ({ ok: true, state: 'ready' }) };
  }
  const base = url.replace(/\/health$/, '');
  if (!online[base]) throw new TypeError('fetch failed');
  return { ok: true, json: async () => ({ status: 'ok' }) };
};

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
  calls.injected.length = 0;
  calls.tabMessages.length = 0;
  pages.scripted.clear();
  online['http://127.0.0.1:7477'] = true;
  online['http://127.0.0.1:7478'] = true;
  hub.canStart = false;
  hub.starts = 0;
  store.fallback = true;
});

const speakTextMessages = () => calls.runtime.filter((m) => m.type === 'speak-text');

test('a Kokoro profile is sent to the Kokoro server', async () => {
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'kokoro', voice: 'bf_emma', rate: 1.2, volume: 0.8 } });
  assert.deepEqual(res, { ok: true, engine: 'kokoro', fellBack: false });
  const [msg] = speakTextMessages();
  assert.equal(msg.engine, 'kokoro');
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7478/tts');
  assert.equal(msg.voice, 'bf_emma');
  assert.equal(msg.rate, 1.2);
  assert.equal(calls.tts.length, 0);
});

test('a Piper profile (old voice-only shape) is sent to the Piper server', async () => {
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { voice: 'en_US-amy-medium.onnx' } });
  assert.equal(res.engine, 'piper');
  const [msg] = speakTextMessages();
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7477/tts');
  assert.equal(msg.voice, 'en_US-amy-medium.onnx');
});

test('an offline engine falls back to the browser voice and tells the page', async () => {
  online['http://127.0.0.1:7478'] = false;
  online['http://127.0.0.1:7477'] = false; // no Piper server, so nothing can start Kokoro
  // The shortcut reads with the active profile; make it a Kokoro one.
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.equal(speakTextMessages().length, 0, 'nothing is sent to the offline engine');
  assert.equal(calls.tts.length, 1);
  assert.equal(calls.tts[0].text, 'Hello there');
  assert.deepEqual(calls.hints, [{ tabId: 42, message: 'Kokoro is offline. Reading with the Basic voice.' }]);
});

test('a stopped Kokoro is started on demand by the Piper server, then reads', async () => {
  online['http://127.0.0.1:7478'] = false;
  hub.canStart = true;
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.equal(hub.starts, 1);
  const [msg] = speakTextMessages();
  assert.equal(msg.ttsUrl, 'http://127.0.0.1:7478/tts');
  assert.equal(calls.tts.length, 0, 'the Basic voice did not read');
  assert.deepEqual(calls.hints, [{ tabId: 42, message: 'Starting Kokoro, about 5 s' }]);
});

test('a Piper server that cannot start Kokoro leads to the Basic voice', async () => {
  online['http://127.0.0.1:7478'] = false;
  store.profiles = [{ id: 'k', name: 'K', engine: 'kokoro', voice: 'af_heart', rate: 1, volume: 1 }];
  store.activeId = 'k';
  onCommand('read-selection', { id: 42 });
  await settle();
  assert.equal(speakTextMessages().length, 0);
  assert.equal(calls.tts.length, 1);
  assert.equal(calls.hints.at(-1).message, 'Kokoro is offline. Reading with the Basic voice.');
});

test('warm-engine starts Kokoro without reading', async () => {
  online['http://127.0.0.1:7478'] = false;
  hub.canStart = true;
  for (const fn of listeners['runtime.onMessage']) fn({ type: 'warm-engine', engine: 'kokoro' }, {}, () => {});
  await settle();
  assert.equal(hub.starts, 1);
  assert.equal(speakTextMessages().length, 0);
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
  online['http://127.0.0.1:7477'] = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'piper', voice: '' } });
  assert.deepEqual(res, { ok: true, engine: 'browser', fellBack: true });
  assert.equal(calls.tts.length, 1);
});

test('with the fallback off, an offline engine reports an error and stays silent', async () => {
  online['http://127.0.0.1:7478'] = false;
  store.fallback = false;
  const res = await send({ type: 'test-voice', text: 'Hi', settings: { engine: 'kokoro', voice: 'af_heart' } });
  assert.deepEqual(res, { ok: false, engine: null, fellBack: false, error: 'Kokoro is offline' });
  assert.equal(calls.tts.length, 0);
  assert.equal(speakTextMessages().length, 0);
});

test('the Basic voice never touches a server', async () => {
  online['http://127.0.0.1:7477'] = false;
  online['http://127.0.0.1:7478'] = false;
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
  assert.deepEqual(store.favoritesByEngine, { piper: ['en_US-amy-medium.onnx'], kokoro: [] });
  assert.equal(store.fallback, true);
  assert.equal('favorites' in store, false);
});
