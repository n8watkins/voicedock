// A fake VoiceDock hub (7477) for the end-to-end tests. It speaks the hub API
// (docs/API.md) with canned voices and a short tone for /tts, and Piper and
// Kokoro can each be put in any state the real hub reports.
//
// The extension's host permission names this exact port, so the tests need it
// free: CI runners have nothing there; on a machine running a real hub, run
// the tests in their own network namespace (npm run test:e2e:isolated).
import http from 'node:http';

export const PIPER_VOICES = [
  'en_US-ryan-high.onnx',
  'en_US-amy-medium.onnx',
  'en_GB-cori-high.onnx',
  'en_GB-alan-medium.onnx',
  'es_ES-davefx-medium.onnx',
];
export const KOKORO_VOICES = ['af_heart', 'af_bella', 'bm_george', 'ef_dora', 'ff_siwis', 'am_adam'];

// A mono 16-bit WAV: a soft 220 Hz tone, about 60 ms per word (capped), so
// reads take a moment but tests stay fast.
export function toneWav(text, sampleRate = 16000) {
  const words = Math.max(1, String(text).trim().split(/\s+/).length);
  const seconds = Math.min(2.5, 0.25 + words * 0.06);
  const samples = Math.round(sampleRate * seconds);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.05;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// A fake VoiceDock hub on 7477 (docs/API.md): GET /engines with each
// engine's state, POST /tts for Piper and Kokoro, the voice lists, warm-ups
// and heartbeats. Nothing listens on Kokoro's own port: the extension only
// ever talks to the hub.
//
//   engines.piper.set('running' | 'stopped')   stopped: the whole hub is down
//   engines.kokoro.set(mode), where mode is
//     'running'  ready, model loaded           'starting' starting
//     'standby'  set up, not running: starts on the first read or a warm-up
//     'off'      set up, but kept off (Installed but not running)
//     'stopped'  not set up (Not installed)
//   engines.<id>.state.ttsRequests   the reads that reached that engine
//   engines.hub.starts               warm-ups and cold reads that started Kokoro
//   engines.hub.presence             heartbeats received
export async function startFakeEngines() {
  const piper = { state: { mode: 'running', ttsRequests: [] }, set(mode) { piper.state.mode = mode; if (mode === 'stopped') dropAll(); } };
  const kokoro = { state: { mode: 'running', ttsRequests: [] }, set(mode) { kokoro.state.mode = mode; } };
  const hub = { starts: 0, presence: [], onDemand: false };
  const sockets = new Set();
  const dropAll = () => { for (const socket of sockets) socket.destroy(); };

  const KOKORO_STATE = { running: 'ready', starting: 'starting', standby: 'idle', off: 'stopped', stopped: 'not-installed' };
  const kokoroEntry = () => {
    const state = KOKORO_STATE[kokoro.state.mode] || 'not-installed';
    const installed = state !== 'not-installed';
    return {
      id: 'kokoro', name: 'Kokoro', heavy: true, state, installed, running: state === 'ready',
      startsOnDemand: state === 'idle', speaking: false, voices: installed ? KOKORO_VOICES.length : null,
      rssMb: state === 'ready' ? 612 : null, modelLoaded: state === 'ready',
      detail: {
        ready: 'Model loaded, unloads in 9 min',
        starting: 'Starting, about 3 s',
        idle: 'Starts when you read, about 3 s',
        stopped: 'Memory is low, so Kokoro stays off for now',
        'not-installed': "Kokoro's Python environment is missing: run setup.ps1 (Windows) or setup.sh",
      }[state],
      setup: installed ? null : "Kokoro's Python environment is missing: run setup.ps1 (Windows) or setup.sh",
      coldStart: { estimateMs: 3400, budgetMs: 8000, processMs: 600, modelLoadMs: 1800 },
    };
  };
  const piperEntry = () => ({
    id: 'piper', name: 'Piper', heavy: false, state: 'ready', installed: true, running: true, startsOnDemand: false,
    speaking: false, voices: PIPER_VOICES.length, rssMb: 0, detail: `${PIPER_VOICES.length} voices, no process while idle`,
    setup: null, coldStart: { estimateMs: 1000, budgetMs: 2000 },
  });
  // A cold Kokoro starts in 300 ms here.
  const startKokoro = () => {
    if (kokoro.state.mode !== 'standby') return Promise.resolve();
    hub.starts += 1;
    kokoro.state.mode = 'starting';
    return new Promise((resolve) => setTimeout(() => { kokoro.state.mode = 'running'; resolve(); }, 300));
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });

  const server = http.createServer(async (req, res) => {
    if (piper.state.mode === 'stopped') { req.socket.destroy(); return; }
    const url = new URL(req.url, 'http://127.0.0.1:7477');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /health') {
      return json(res, 200, { status: 'ok', engine: 'piper', api: 2, version: '1.0.0', pid: 4242, rssMb: 24.7, speaking: false });
    }
    if (route === 'GET /engines') {
      return json(res, 200, { api: 2, pressure: 'ok', presence: { lastSeenAt: null, clients: hub.presence.length ? 1 : 0 }, engines: [piperEntry(), kokoroEntry()] });
    }
    if (route === 'GET /voices' || route === 'GET /engines/piper/voices') {
      return json(res, 200, {
        engine: 'piper', voices: PIPER_VOICES, defaultVoice: PIPER_VOICES[0],
        sizes: Object.fromEntries(PIPER_VOICES.map((v, i) => [v, 63_000_000 + i * 11_000_000])), voiceDir: 'C:\\VoiceDock\\servers\\piper\\piper\\voices',
      });
    }
    if (route === 'GET /engines/kokoro/voices') {
      if (kokoroEntry().state === 'not-installed') return json(res, 404, { error: 'Kokoro is not set up.' });
      return json(res, 200, { engine: 'kokoro', voices: KOKORO_VOICES, defaultVoice: 'af_heart' });
    }
    if (route === 'POST /engines/kokoro/warm') {
      const entry = kokoroEntry();
      if (entry.state === 'not-installed') return json(res, 409, { outcome: 'refused', reason: 'not-installed' });
      if (entry.state !== 'idle') return json(res, 200, { outcome: 'already', state: entry.state });
      startKokoro();
      return json(res, 202, { outcome: 'ok', state: 'starting', expectedMs: 3400 });
    }
    if (route === 'POST /presence') {
      hub.presence.push(await readBody(req));
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /tts') {
      const body = await readBody(req);
      const engine = body.engine || 'piper';
      if (engine === 'kokoro') {
        const state = kokoroEntry().state;
        if (state === 'not-installed') return json(res, 409, { error: 'Kokoro is not set up.', reason: 'not-installed' });
        if (state === 'stopped') return json(res, 503, { error: 'Memory is low, so Kokoro does not start now.', reason: 'low-memory' });
        await startKokoro();
      }
      (engine === 'kokoro' ? kokoro : piper).state.ttsRequests.push(body);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(toneWav(body.text || ''));
    }
    if (route === 'POST /voices/open-folder') return json(res, 200, { ok: true });
    return json(res, 404, { error: 'Not found' });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(7477, '127.0.0.1', () => resolve());
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      throw new Error('Port 7477 is taken (a real VoiceDock hub?). Run npm run test:e2e:isolated, which gives the tests their own network.');
    }
    throw err;
  }
  return {
    piper,
    kokoro,
    hub,
    reset() {
      piper.state.mode = 'running';
      kokoro.state.mode = 'running';
      piper.state.ttsRequests.length = 0;
      kokoro.state.ttsRequests.length = 0;
      hub.starts = 0;
      hub.presence.length = 0;
    },
    close: () => new Promise((resolve) => { dropAll(); server.close(() => resolve()); }),
  };
}
