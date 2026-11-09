/**
 * The engine hub: which engines exist, what state each is in, and the policy
 * that decides when a heavy engine runs (the N8 Tray plan, section 5.2).
 *
 * - Start on demand. No engine process runs at hub start. A read (or a warm
 *   request when the popup opens) starts a heavy engine.
 * - One heavy engine at a time. Starting one stops the others once they are
 *   not speaking. Piper has no resident process (one piper.exe per read), and
 *   a Piper read stops an idle Kokoro (kokoro.js yieldTo), so only the engine
 *   in use runs.
 * - Unload, then stop. Kokoro releases its model after 10 idle minutes and
 *   exits after 30 by itself (kokoro.js passes the timers).
 * - No browser, no engines. Once the extension has sent a heartbeat
 *   (POST /presence), N minutes without one (default 5) stop every heavy
 *   engine that is not speaking. A hub that never got a heartbeat (an older
 *   extension) leaves that to the idle timers.
 * - Memory pressure (pushed by N8 Tray, POST /n8/v2/pressure): attention
 *   releases idle models and refuses warm-ups; problem stops every heavy
 *   engine that is not speaking and refuses to start one ("low-memory").
 *
 * The hub works the same with or without N8 Tray. Engines report their state
 * in the contract's vocabulary (ready, idle, starting, failed, not-installed,
 * needs-setup); the extension turns those into its words.
 */

const PRESSURE_LEVELS = ["ok", "attention", "problem"];
const DEFAULT_NO_CLIENT_STOP_SECONDS = 300;
const PRESENCE_CLIENT_WINDOW_MS = 5 * 60_000;
const MAX_EVENTS = 100;

// What first audio costs when nothing has been measured yet on this machine
// (plan section 5.4). Replaced by the measured figures as soon as there are
// some: lastStartMs (process up to /health) plus the model load.
const DESCRIPTORS = {
  piper: { id: "piper", name: "Piper", heavy: false, coldStartEstimateMs: 1000, budgetMs: 2000 },
  kokoro: { id: "kokoro", name: "Kokoro", heavy: true, coldStartEstimateMs: 5000, budgetMs: 8000 },
};
const ENGINE_ORDER = ["piper", "kokoro"];

function noClientStopSeconds(env = process.env) {
  const raw = env.VOICEDOCK_NO_CLIENT_STOP_SECONDS;
  const n = Number(raw);
  return raw != null && String(raw).trim() !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_NO_CLIENT_STOP_SECONDS;
}

function minutesText(seconds) {
  if (seconds == null) return "";
  if (seconds < 60) return "under a minute";
  const m = Math.round(seconds / 60);
  return m === 1 ? "1 min" : `${m} min`;
}

function secondsText(ms) {
  return `about ${Math.max(1, Math.round(ms / 1000))} s`;
}

function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * @param {object} options
 * @param {object} options.kokoro the Kokoro launcher (kokoro.js)
 * @param {object} options.readers the Piper reader tracker (memory.js)
 * @param {() => Promise<string[]>} options.piperVoices installed Piper voices
 * @param {() => boolean} options.piperInstalled whether the piper binary exists
 */
function createHub({
  kokoro,
  readers,
  piperVoices,
  piperInstalled,
  env = process.env,
  now = Date.now,
  log = console,
  checkIntervalMs = 30_000,
}) {
  const heavy = { kokoro };
  const inflight = { piper: 0, kokoro: 0 };
  const pendingStop = new Set(); // heavy engines to stop once their reads finish
  const clients = new Map();     // extension origin -> { lastSeenAt, version, activeEngine, reading }
  const events = [];
  let armed = false;             // a heartbeat arrived at least once
  let lastClientAt = null;       // last heartbeat or read, ms
  let silenceHandled = false;    // the no-client stop ran for this silence
  let pressure = "ok";
  let activeEngine = null;
  let timer = null;
  const stopAfterNoClientMs = noClientStopSeconds(env) * 1000;

  function event(type, engine, data = {}) {
    events.push({ at: new Date(now()).toISOString(), type, engine, ...data });
    if (events.length > MAX_EVENTS) events.shift();
  }

  // ─── Clients ─────────────────────────────────────────────────────────────
  function presence(origin, body = {}) {
    const t = now();
    const key = origin || "local";
    const engine = typeof body.activeEngine === "string" && /^[a-z0-9-]{1,32}$/.test(body.activeEngine)
      ? body.activeEngine : null;
    clients.set(key, {
      lastSeenAt: t,
      version: typeof body.extensionVersion === "string" ? body.extensionVersion.slice(0, 32) : null,
      activeEngine: engine,
      reading: body.reading === true,
    });
    if (!armed) event("presence-first", null, { version: clients.get(key).version });
    armed = true;
    lastClientAt = t;
    silenceHandled = false;
    if (engine) activeEngine = engine;
    return presenceDoc();
  }

  // A read or warm-up also shows a client is there.
  function activity() {
    lastClientAt = now();
    silenceHandled = false;
  }

  function presenceDoc() {
    const t = now();
    const live = [...clients.values()].filter((c) => t - c.lastSeenAt < PRESENCE_CLIENT_WINDOW_MS);
    const newest = [...clients.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    const doc = {
      lastSeenAt: newest ? new Date(newest.lastSeenAt).toISOString() : null,
      clients: live.length,
    };
    if (activeEngine) doc.activeEngine = activeEngine;
    if (newest?.version) doc.extensionVersion = newest.version;
    return doc;
  }

  // ─── Reads and starts ────────────────────────────────────────────────────
  function speaking(id, status) {
    if (inflight[id] > 0) return true;
    return status?.speaking === true;
  }

  async function stopEngine(id, reason) {
    const launcher = heavy[id];
    if (!launcher || !launcher.owned()) return false;
    const stopped = launcher.stop();
    if (stopped) {
      event("stop", id, { reason });
      log.log?.(`[hub] stopped ${id}: ${reason}`);
    }
    return stopped;
  }

  // Stops the other heavy engines, now if they are quiet, else after their
  // reads finish.
  async function yieldHeavyTo(id) {
    for (const other of Object.keys(heavy)) {
      if (other === id || !heavy[other].owned()) continue;
      const status = await heavy[other].status();
      if (speaking(other, status)) pendingStop.add(other);
      else await stopEngine(other, `${DESCRIPTORS[id].name} became active`);
    }
  }

  // Makes an engine ready for a read: starts a heavy one on demand. Rejects
  // with err.code "not-installed", "low-memory" or "failed".
  async function ensure(id, { manual = false } = {}) {
    if (!DESCRIPTORS[id]) throw codedError("unknown", `Unknown engine: ${id}`);
    if (!DESCRIPTORS[id].heavy) {
      if (!piperInstalled() || (await piperVoices()).length === 0) {
        throw codedError("not-installed", "Piper is not set up.");
      }
      return { state: "ready", startedMs: 0 };
    }
    const launcher = heavy[id];
    const running = await launcher.health(400);
    if (running) return { state: "ready", startedMs: 0 };
    if (pressure === "problem") {
      event("refused", id, { reason: "low-memory" });
      throw codedError("low-memory", "Memory is low, so VoiceDock does not start Kokoro now.");
    }
    await yieldHeavyTo(id);
    event("start", id, { manual });
    try {
      const result = await launcher.start({ manual });
      event("ready", id, { startedMs: result.startedMs });
      return result;
    } catch (err) {
      event("start-failed", id, { code: err.code, message: err.message });
      throw err;
    }
  }

  function beginRead(id) {
    activity();
    inflight[id] = (inflight[id] || 0) + 1;
    activeEngine = id;
  }

  function endRead(id) {
    inflight[id] = Math.max(0, (inflight[id] || 0) - 1);
    if (inflight[id] === 0 && pendingStop.has(id)) {
      pendingStop.delete(id);
      stopEngine(id, "another engine became active").catch(() => {});
    }
  }

  // Starts a heavy engine without waiting (the popup opened on a Kokoro
  // profile). Resolves to { outcome, state, expectedMs }.
  async function warm(id) {
    activity();
    if (!DESCRIPTORS[id]) return { outcome: "refused", reason: "unknown", message: `Unknown engine: ${id}` };
    if (!DESCRIPTORS[id].heavy) return { outcome: "already", state: "ready" };
    const status = await heavy[id].status();
    if (status.state === "ready" || status.state === "starting") {
      return { outcome: "already", state: status.state, expectedMs: status.state === "starting" ? expectedColdMs(id, status) : 0 };
    }
    if (status.state === "not-installed") return { outcome: "refused", reason: "not-installed", message: status.setup };
    if (pressure !== "ok") {
      event("refused", id, { reason: "low-memory", warm: true });
      return { outcome: "refused", reason: "low-memory", message: "Memory is low, so VoiceDock does not warm engines now." };
    }
    if (status.state === "failed") return { outcome: "refused", reason: "failed", message: status.lastError };
    ensure(id).catch(() => {});
    return { outcome: "ok", state: "starting", expectedMs: expectedColdMs(id, status) };
  }

  function expectedColdMs(id, status) {
    const d = DESCRIPTORS[id];
    if (!d.heavy) return d.coldStartEstimateMs;
    const processMs = status?.lastStartMs;
    const loadMs = status?.modelLoadMs;
    if (processMs == null && loadMs == null) return d.coldStartEstimateMs;
    return (processMs ?? 600) + (loadMs ?? 2500) + 1000; // plus the first sentence
  }

  // ─── Memory pressure ─────────────────────────────────────────────────────
  async function setPressure(level) {
    if (!PRESSURE_LEVELS.includes(level)) throw codedError("invalid", `Unknown pressure level: ${level}`);
    const previous = pressure;
    pressure = level;
    if (level !== previous) {
      event("pressure", null, { level });
      log.log?.(`[hub] memory pressure: ${level}`);
    }
    for (const id of Object.keys(heavy)) {
      const launcher = heavy[id];
      if (level === "ok" || !launcher.owned()) continue;
      const status = await launcher.status();
      if (speaking(id, status)) continue;
      if (level === "problem") await stopEngine(id, "memory is low");
      else if (status.modelLoaded && (await launcher.unload())) event("unload", id, { reason: "memory pressure" });
    }
    return pressure;
  }

  // ─── The no-browser rule ─────────────────────────────────────────────────
  async function tick() {
    if (!armed || silenceHandled || stopAfterNoClientMs <= 0 || lastClientAt == null) return false;
    if (now() - lastClientAt < stopAfterNoClientMs) return false;
    silenceHandled = true;
    let stopped = false;
    for (const id of Object.keys(heavy)) {
      if (!heavy[id].owned()) continue;
      const status = await heavy[id].status();
      if (speaking(id, status)) { silenceHandled = false; continue; } // try again next tick
      stopped = (await stopEngine(id, `no browser heartbeat for ${Math.round(stopAfterNoClientMs / 60_000)} min`)) || stopped;
    }
    return stopped;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { tick().catch(() => {}); }, checkIntervalMs);
    if (timer.unref) timer.unref();
  }

  function stopTimers() {
    clearInterval(timer);
    timer = null;
  }

  function stopAll(reason) {
    for (const id of Object.keys(heavy)) {
      if (heavy[id].owned()) {
        heavy[id].stop();
        event("stop", id, { reason });
      }
    }
  }

  // ─── Engine list (GET /engines) ──────────────────────────────────────────
  async function piperEntry() {
    const d = DESCRIPTORS.piper;
    const installed = piperInstalled();
    const voices = installed ? await piperVoices() : [];
    const snap = readers.snapshot();
    let state = "ready";
    let detail = `${voices.length} ${voices.length === 1 ? "voice" : "voices"}, no process while idle`;
    if (!installed) { state = "not-installed"; detail = "Piper is not set up: run npm run setup in servers/piper"; }
    else if (voices.length === 0) { state = "needs-setup"; detail = "Piper has no voices yet: run npm run setup in servers/piper"; }
    if (installed && voices.length && snap.speaking) detail = `Reading, ${voices.length} voices`;
    return {
      id: d.id,
      name: d.name,
      heavy: false,
      state,
      installed: installed && voices.length > 0,
      running: true, // nothing to start: the hub runs piper.exe per read
      startsOnDemand: false,
      speaking: snap.speaking,
      voices: voices.length,
      rssMb: snap.readerRssMb || 0,
      peakRssMb: snap.lastReaderPeakRssMb,
      detail,
      setup: state === "ready" ? null : detail,
      coldStart: { estimateMs: d.coldStartEstimateMs, budgetMs: d.budgetMs },
    };
  }

  async function kokoroEntry() {
    const d = DESCRIPTORS.kokoro;
    const st = await kokoro.status();
    const h = st.health;
    const expectedMs = expectedColdMs("kokoro", st);
    let state;
    let detail;
    if (st.state === "starting") {
      state = "starting";
      detail = `Starting, ${secondsText(expectedMs)}`;
    } else if (st.state === "ready" && st.modelLoaded) {
      state = "ready";
      const left = h?.idleUnloadSeconds > 0 && !st.speaking ? Math.max(0, h.idleUnloadSeconds - (h.idleSeconds || 0)) : null;
      detail = st.speaking ? "Reading" : left != null ? `Model loaded, unloads in ${minutesText(left)}` : "Model loaded";
    } else if (st.state === "ready") {
      state = "idle";
      detail = "Running, model released: the next read loads it again";
    } else if (st.state === "failed") {
      state = "failed";
      detail = st.lastError || "Kokoro keeps crashing";
    } else if (st.state === "not-installed") {
      state = st.setupState || "not-installed";
      detail = st.setup;
    } else {
      // Installed, not running: the hub starts it on the first read.
      state = pressure === "problem" ? "stopped" : "idle";
      detail = pressure === "problem"
        ? "Memory is low, so Kokoro stays off for now"
        : `Starts when you read, ${secondsText(expectedMs)}`;
    }
    const running = Boolean(h);
    const stopsIn = running && h?.idleExitSeconds > 0 && !st.speaking
      ? Math.max(0, h.idleExitSeconds - (h.idleSeconds || 0)) : null;
    return {
      id: d.id,
      name: d.name,
      heavy: true,
      state,
      installed: st.state !== "not-installed",
      running,
      owned: st.owned,
      startsOnDemand: st.startsOnDemand && pressure !== "problem",
      speaking: st.speaking,
      voices: h?.voices ?? null,
      pid: st.pid,
      rssMb: st.rssMb,
      modelLoaded: st.modelLoaded,
      detail,
      setup: st.setup,
      lastError: st.lastError,
      stopsInSeconds: stopsIn,
      coldStart: {
        estimateMs: expectedMs,
        budgetMs: d.budgetMs,
        processMs: st.lastStartMs,
        modelLoadMs: st.modelLoadMs,
      },
    };
  }

  async function list() {
    const engines = await Promise.all([piperEntry(), kokoroEntry()]);
    return {
      api: 2,
      pressure,
      presence: presenceDoc(),
      policy: {
        oneHeavyEngine: true,
        noClientStopSeconds: stopAfterNoClientMs / 1000,
        heartbeatArmed: armed,
      },
      engines,
    };
  }

  return {
    list, ensure, warm, beginRead, endRead, presence, activity, presenceDoc, setPressure, tick,
    start, stopTimers, stopAll, stopEngine, expectedColdMs,
    events: () => events.slice(),
    pressure: () => pressure,
    order: ENGINE_ORDER,
    descriptors: DESCRIPTORS,
  };
}

module.exports = { createHub, noClientStopSeconds, DESCRIPTORS, ENGINE_ORDER, PRESSURE_LEVELS };
