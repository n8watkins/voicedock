// Fake Piper (7477) and Kokoro (7478) servers for the end-to-end tests. They
// speak the engine API (docs/API.md) with canned voices and a short tone for
// /tts, and each can be switched between running, starting (Kokoro loading
// its model) and stopped (connections are dropped, as when nothing listens).
//
// The extension's host permissions name these exact ports, so the tests need
// them free: CI runners have nothing there; on a machine running real engines,
// run the tests in their own network namespace (npm run test:e2e:isolated).
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

function createEngine({ engine, port, voices, defaultVoice, routes = () => false }) {
  const state = { mode: 'running', ttsRequests: [] };
  const sockets = new Set();
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    if (state.mode === 'stopped') { req.socket.destroy(); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        status: 'ok', engine, version: '1.0.0', pid: 4242, rssMb: engine === 'piper' ? 24.7 : 46.9,
        speaking: false, voices: voices.length,
        ...(engine === 'kokoro' ? { modelLoaded: false, modelLoading: state.mode === 'starting' } : {}),
      });
    }
    if (req.method === 'GET' && url.pathname === '/voices') {
      return json(res, 200, {
        engine, voices, defaultVoice,
        ...(engine === 'piper' ? { sizes: Object.fromEntries(voices.map((v, i) => [v, 63_000_000 + i * 11_000_000])), voiceDir: 'C:\\VoiceDock\\servers\\piper\\piper\\voices' } : {}),
      });
    }
    if (req.method === 'POST' && url.pathname === '/tts') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (_) {}
        state.ttsRequests.push(parsed);
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(toneWav(parsed.text || ''));
      });
      return undefined;
    }
    if (req.method === 'POST' && url.pathname === '/voices/open-folder') return json(res, 200, { ok: true });
    if (routes(req, res, url, json)) return undefined;
    return json(res, 404, { error: 'Not found' });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    engine,
    port,
    state,
    // 'running' | 'starting' (Kokoro's model is loading) | 'stopped'
    set(mode) {
      state.mode = mode;
      if (mode === 'stopped') for (const socket of sockets) socket.destroy();
    },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    }),
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

export async function startFakeEngines() {
  // Kokoro on demand: with hub.onDemand, the fake Piper server reports Kokoro
  // as startable (GET /engines), lists its voices while it is stopped, and
  // starts it on POST /engines/kokoro/start, like servers/piper/kokoro.js.
  const hub = { onDemand: false, starts: 0 };
  let kokoro;
  const hubRoutes = (req, res, url, json) => {
    if (req.method === 'GET' && url.pathname === '/engines') {
      json(res, 200, { engines: [
        { id: 'piper', state: 'ready', voices: PIPER_VOICES.length },
        { id: 'kokoro', state: kokoro.state.mode === 'stopped' ? (hub.onDemand ? 'stopped' : 'not-installed') : 'ready', startsOnDemand: hub.onDemand },
      ] });
      return true;
    }
    if (!hub.onDemand) return false;
    if (req.method === 'GET' && url.pathname === '/engines/kokoro/voices') {
      json(res, 200, { engine: 'kokoro', voices: KOKORO_VOICES, defaultVoice: 'af_heart' });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/engines/kokoro/start') {
      hub.starts += 1;
      setTimeout(() => { kokoro.set('running'); json(res, 200, { ok: true, state: 'ready', owned: true, startedMs: 300 }); }, 300);
      return true;
    }
    return false;
  };
  const piper = createEngine({ engine: 'piper', port: 7477, voices: PIPER_VOICES, defaultVoice: PIPER_VOICES[0], routes: hubRoutes });
  kokoro = createEngine({ engine: 'kokoro', port: 7478, voices: KOKORO_VOICES, defaultVoice: 'af_heart' });
  try {
    await piper.listen();
    await kokoro.listen();
  } catch (err) {
    await piper.close().catch(() => {});
    if (err.code === 'EADDRINUSE') {
      throw new Error('Port 7477 or 7478 is taken (a real Piper or Kokoro?). Run npm run test:e2e:isolated, which gives the tests their own network.');
    }
    throw err;
  }
  return {
    piper,
    kokoro,
    hub,
    reset() { piper.set('running'); kokoro.set('running'); piper.state.ttsRequests.length = 0; kokoro.state.ttsRequests.length = 0; hub.onDemand = false; hub.starts = 0; },
    close: () => Promise.all([piper.close(), kokoro.close()]),
  };
}
