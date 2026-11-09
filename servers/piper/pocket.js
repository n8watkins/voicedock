/**
 * Pocket TTS (Kyutai) on demand, run by the hub.
 *
 * The program is Kyutai's official standalone binary (Rust, no Python, no
 * PyTorch), installed from the signed catalog by `node engines.js install
 * pocket`; its model comes from Hugging Face on `node engines.js model
 * pocket`, into VoiceDock's own folder (servers/engines/pocket/data). No
 * Hugging Face account is needed or used: the hub hides any token from the
 * engine, so it always loads the weights without voice cloning.
 *
 * - Start on demand: the first Pocket read (or a warm-up) starts
 *   `pocket-tts serve` on a free loopback port only the hub knows, and waits
 *   for /health. It runs with int8 weights (--quantize): about half the
 *   memory and faster, with minimal effect on the sound.
 * - Idle stop: the program can't release its model, and it starts again in
 *   about a second, so instead of unloading the hub stops it after 10 idle
 *   minutes (POCKET_STOP_AFTER_SECONDS).
 * - One heavy engine at a time, memory pressure and the no-browser rule are
 *   the hub's (hub/engines.js), as for Kokoro.
 * - Crashes: backoff and "failed" as for Kokoro (hub/crashes.js).
 * - Orphans: the program can't watch its parent, so the hub notes the pid and
 *   port in the data folder and, at its next start, stops a Pocket left
 *   running by a hub that was killed outright.
 * - Voices: the 26 built-in voices, by name. Voice cloning is not offered:
 *   the engine never gets an audio file or a URL from a request.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { createCrashTracker } = require("./hub/crashes");
const { rssMbOf } = require("./hub/procmem");
const { createInstalls, sha256File } = require("./hub/installs");

const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_AFTER_SECONDS = 600;
const MAX_TEXT_CHARS = 4000;
const MEMORY_SAMPLE_MS = 5000;

// The built-in voices (Kyutai's README, in its order). All read English with
// the default model; five come from speakers of other languages.
const VOICES = [
  "alba", "giovanni", "lola", "juergen", "rafael", "estelle", "anna", "azelma", "bill_boerst",
  "caro_davy", "charles", "cosette", "eponine", "eve", "fantine", "george", "jane", "jean",
  "javert", "marius", "mary", "michael", "paul", "peter_yearsley", "stuart_bell", "vera",
];
const DEFAULT_VOICE = "alba";

function stopAfterSeconds(env = process.env) {
  const raw = env.POCKET_STOP_AFTER_SECONDS;
  const n = Number(raw);
  return raw != null && String(raw).trim() !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_STOP_AFTER_SECONDS;
}

function dataDir(installs) {
  return path.join(installs.dir, "pocket", "data");
}

// The engine's environment: VoiceDock's own Hugging Face folder, and no
// token, so the engine downloads (and loads) the weights without voice cloning.
function engineEnv(installs, env = process.env) {
  const out = { ...env, HF_HOME: path.join(dataDir(installs), "hf") };
  for (const key of Object.keys(out)) {
    if (/^(HF_TOKEN|HUGGING_FACE_HUB_TOKEN|HF_TOKEN_PATH|HF_HUB_OFFLINE)$/i.test(key)) delete out[key];
  }
  return out;
}

// "repo/path@revision" from the catalog, to the file in the Hugging Face cache.
function cachedFile(installs, hfRef) {
  const m = /^([^/]+\/[^/]+)\/(.+)@([0-9a-f]{40})$/.exec(hfRef);
  if (!m) throw new Error(`Not a pinned Hugging Face file: ${hfRef}`);
  const [, repo, file, rev] = m;
  return path.join(dataDir(installs), "hf", "hub", `models--${repo.replace("/", "--")}`, "snapshots", rev, ...file.split("/"));
}

function modelFiles(installs) {
  const c = installs.catalog();
  const release = c.engines.pocket.versions.find((v) => v.version === installs.state("pocket").current) || c.engines.pocket.versions[0];
  return release.model;
}

// What is missing for Pocket TTS to read, as plain words, or null.
function missingSetup(installs) {
  let program;
  try {
    program = installs.program("pocket");
  } catch (_) {
    program = null;
  }
  if (!program) return { state: "not-installed", text: "Pocket TTS is not set up: run node engines.js install pocket in servers/piper" };
  try {
    for (const f of modelFiles(installs).files) {
      if (!fs.existsSync(cachedFile(installs, f.hf))) {
        return { state: "needs-setup", text: "Pocket TTS's model is not downloaded yet: run node engines.js model pocket in servers/piper" };
      }
    }
  } catch (err) {
    return { state: "needs-setup", text: err.message };
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function getJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function createPocketLauncher({
  installs = createInstalls(),
  spawnImpl = spawn,
  healthAt = (port, ms = 800) => getJson(`http://${HOST}:${port}/health`, ms),
  fetchImpl = (...args) => fetch(...args),
  pickPort = freePort,
  rssOf = rssMbOf,
  kill = (pid) => process.kill(pid),
  env = process.env,
  log = console,
  now = Date.now,
  startTimeoutMs = START_TIMEOUT_MS,
  pollMs = 150,
  quantize = env.POCKET_QUANTIZE !== "0",
  onIdleStop = () => {},
  idleCheckMs = 30_000,
} = {}) {
  let child = null;
  let port = null;
  let starting = null;
  let startedAt = null;
  let lastStartMs = null;
  let lastUsedAt = null;
  let reading = 0;
  let rssMb = null;
  let memTimer = null;
  let idleTimer = null;
  let orphanChecked = false;
  const crashes = createCrashTracker({ name: "Pocket TTS", now, log });
  const logFile = () => path.join(dataDir(installs), "pocket.log");
  const pidFile = () => path.join(dataDir(installs), "pocket.pid.json");

  function owned() {
    return child !== null && child.exitCode === null && child.signalCode === null;
  }

  // A Pocket TTS a killed hub left behind: it answers /health on the port
  // the hub noted, so stop it (the answer shows the pid is still that engine).
  async function stopOrphan() {
    if (orphanChecked) return;
    orphanChecked = true;
    let note = null;
    try { note = JSON.parse(fs.readFileSync(pidFile(), "utf8")); } catch (_) { return; }
    try { fs.rmSync(pidFile(), { force: true }); } catch (_) {}
    if (!Number.isInteger(note?.pid) || !Number.isInteger(note?.port)) return;
    if (await healthAt(note.port, 400)) {
      try {
        kill(note.pid);
        log.log?.(`[pocket] stopped a Pocket TTS left running by an earlier hub (pid ${note.pid})`);
      } catch (_) {}
    }
  }

  function sampleMemory() {
    if (!owned()) return Promise.resolve(null);
    return rssOf(child.pid).then((mb) => { if (mb != null) rssMb = mb; return rssMb; }).catch(() => rssMb);
  }

  function startTimers() {
    clearInterval(memTimer);
    memTimer = setInterval(() => { sampleMemory(); }, MEMORY_SAMPLE_MS);
    memTimer.unref?.();
    clearInterval(idleTimer);
    idleTimer = setInterval(() => { idleCheck(); }, idleCheckMs);
    idleTimer.unref?.();
  }

  function stopTimers() {
    clearInterval(memTimer);
    clearInterval(idleTimer);
    memTimer = idleTimer = null;
  }

  function idleSeconds() {
    return lastUsedAt == null ? 0 : Math.max(0, (now() - lastUsedAt) / 1000);
  }

  // Stops the engine after its idle time; returns true when it did.
  function idleCheck() {
    const limit = stopAfterSeconds(env);
    if (!owned() || reading > 0 || limit <= 0 || idleSeconds() < limit) return false;
    log.log?.(`[pocket] stopping: no read for ${Math.round(limit / 60)} min`);
    stop();
    onIdleStop(`no read for ${Math.round(limit / 60)} min`);
    return true;
  }

  function launch(program, listenPort) {
    fs.mkdirSync(dataDir(installs), { recursive: true });
    const stdio = ["ignore", "ignore", "ignore"];
    let out = null;
    try {
      out = fs.openSync(logFile(), "a");
      stdio[1] = out;
      stdio[2] = out;
    } catch (_) {}
    const args = ["serve", "--host", HOST, "--port", String(listenPort)];
    if (quantize) args.push("--quantize");
    const proc = spawnImpl(program.file, args, { cwd: dataDir(installs), stdio, windowsHide: true, env: engineEnv(installs, env) });
    if (out !== null) fs.closeSync(out);
    proc.on("error", (err) => log.error?.(`[pocket] could not start: ${err.message}`));
    proc.on("exit", (code, signal) => {
      const unasked = child === proc;
      if (unasked) {
        child = null;
        stopTimers();
        try { fs.rmSync(pidFile(), { force: true }); } catch (_) {}
      }
      if (unasked && code !== 0) crashes.record(`Pocket TTS stopped unexpectedly (${signal || `exit ${code}`})`);
      log.log?.(`[pocket] stopped (${signal || `exit ${code}`})`);
    });
    child = proc;
    port = listenPort;
    startedAt = now();
    lastUsedAt = now();
    rssMb = null;
    try { fs.writeFileSync(pidFile(), JSON.stringify({ pid: proc.pid, port: listenPort, startedAt: new Date(startedAt).toISOString() })); } catch (_) {}
    log.log?.(`[pocket] starting ${program.version} (pid ${proc.pid}, port ${listenPort})`);
    startTimers();
    return proc;
  }

  async function waitUntilHealthy(proc) {
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      if (await healthAt(port, 500)) return true;
      if (proc.exitCode !== null || proc.signalCode !== null) {
        const message = `Pocket TTS exited while starting (see ${logFile()})`;
        if (proc.exitCode === 0) crashes.record(message);
        throw new Error(message);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    stop();
    const message = `Pocket TTS did not answer within ${Math.round(startTimeoutMs / 1000)} s (see ${logFile()})`;
    crashes.record(message);
    throw new Error(message);
  }

  // Resolves to { state: "ready", owned: true, startedMs } once Pocket
  // answers; rejects with err.code "not-installed" or "failed".
  async function start({ manual = false } = {}) {
    if (owned() && !starting && (await healthAt(port, 400))) return { state: "ready", owned: true, startedMs: 0 };
    if (starting) return starting;
    await stopOrphan();
    const missing = missingSetup(installs);
    if (missing) {
      const err = new Error(missing.text);
      err.code = "not-installed";
      throw err;
    }
    if (manual) crashes.reset();
    const wait = crashes.gate();
    const began = Date.now();
    starting = (async () => {
      try {
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const proc = owned() ? child : launch(installs.program("pocket"), await pickPort());
        await waitUntilHealthy(proc);
        const startedMs = Date.now() - began;
        lastStartMs = startedMs;
        lastUsedAt = now();
        sampleMemory();
        log.log?.(`[pocket] ready in ${(startedMs / 1000).toFixed(1)} s`);
        return { state: "ready", owned: true, startedMs };
      } catch (err) {
        err.code = err.code || "failed";
        throw err;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function stop() {
    if (!owned()) return false;
    const proc = child;
    child = null;
    stopTimers();
    crashes.cleanStop();
    try { proc.kill(); } catch (_) {}
    try { fs.rmSync(pidFile(), { force: true }); } catch (_) {}
    return true;
  }

  // Pocket can't release its model without stopping; under memory pressure
  // the hub stops it instead (it starts again in about a second).
  async function unload() {
    return false;
  }

  async function yieldTo(engine) {
    if (engine === "pocket" || !owned() || reading > 0) return false;
    log.log?.(`[pocket] stopping: ${engine} is reading now`);
    return stop();
  }

  async function health(ms = 800) {
    if (!owned() || port == null) return null;
    const h = await healthAt(port, ms);
    if (!h) return null;
    return {
      status: "ok",
      speaking: reading > 0,
      modelLoaded: !starting,
      modelLoading: Boolean(starting),
      rssMb,
      idleSeconds: idleSeconds(),
      idleExitSeconds: stopAfterSeconds(env),
      processes: [{ pid: child.pid, startedAt: new Date(startedAt).toISOString(), parentPid: process.pid, role: "engine", rssMb, cpuPercent: null }],
    };
  }

  // A read: the hub calls begin() before and end() after.
  function begin() {
    reading += 1;
    lastUsedAt = now();
  }

  function end() {
    reading = Math.max(0, reading - 1);
    lastUsedAt = now();
  }

  /**
   * Sends one read to the engine and returns its streaming Response (WAV).
   * Only a built-in voice name reaches the engine, never a path or URL.
   */
  async function tts({ text, voice, signal }) {
    const form = new FormData();
    form.append("text", text);
    form.append("voice_url", VOICES.includes(voice) ? voice : DEFAULT_VOICE);
    return fetchImpl(`http://${HOST}:${port}/tts`, { method: "POST", body: form, signal });
  }

  async function status() {
    const missing = missingSetup(installs);
    const running = owned() && !starting;
    let state = "stopped";
    if (starting) state = "starting";
    else if (running) state = "ready";
    else if (missing) state = missing.state;
    else if (crashes.failed()) state = "failed";
    let version = null;
    try { version = installs.state("pocket").current; } catch (_) {}
    return {
      id: "pocket",
      state,
      owned: owned(),
      pid: owned() ? child.pid : null,
      port: owned() ? port : null,
      startedAt: owned() && startedAt ? new Date(startedAt).toISOString() : null,
      rssMb: owned() ? rssMb : null,
      modelLoaded: running,
      speaking: reading > 0,
      idleSeconds: owned() ? idleSeconds() : null,
      stopAfterSeconds: stopAfterSeconds(env),
      setup: missing ? missing.text : null,
      setupState: missing ? missing.state : null,
      startsOnDemand: !missing && !crashes.failed(),
      lastStartMs,
      modelLoadMs: null,
      lastError: crashes.lastError(),
      restartInSeconds: Math.ceil(crashes.backoffLeftMs() / 1000),
      version,
    };
  }

  function voices() {
    if (missingSetup(installs)?.state === "not-installed") return null;
    return { engine: "pocket", voices: VOICES.slice(), defaultVoice: DEFAULT_VOICE };
  }

  return { start, stop, unload, yieldTo, status, owned, voices, health, begin, end, tts, idleCheck, sampleMemory, rssMb: () => rssMb };
}

/**
 * The model step (`node engines.js model pocket`): runs the installed
 * program once, which downloads the weights, tokenizer and the default voice
 * into VoiceDock's folder, then checks each against the signed catalog's
 * SHA-256. A file that differs is deleted.
 */
async function downloadModel({ installs = createInstalls(), env = process.env, log = console, spawnImpl = spawn } = {}) {
  const program = installs.program("pocket");
  if (!program) throw new Error("Install Pocket TTS first: node engines.js install pocket");
  fs.mkdirSync(dataDir(installs), { recursive: true });
  const wav = path.join(os.tmpdir(), `voicedock-pocket-${process.pid}.wav`);
  log.log?.(`Running ${program.file} generate (downloads about 222 MB from Hugging Face into ${path.join(dataDir(installs), "hf")})`);
  await new Promise((resolve, reject) => {
    const proc = spawnImpl(program.file, ["generate", "--text", "Pocket TTS is ready.", "--output-path", wav, "--quantize"], {
      cwd: dataDir(installs), env: engineEnv(installs, env), stdio: ["ignore", "inherit", "inherit"], windowsHide: true,
    });
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pocket-tts generate exited with ${code}`))));
  });
  fs.rmSync(wav, { force: true });
  const model = modelFiles(installs);
  const check = [...model.files, model.voices.find((v) => v.id === DEFAULT_VOICE)];
  for (const f of check) {
    const file = cachedFile(installs, f.hf);
    if (!fs.existsSync(file)) throw new Error(`Expected ${f.hf} after the download, but it is not there`);
    const got = await sha256File(file);
    if (got !== f.sha256) {
      fs.rmSync(file, { force: true });
      throw new Error(`${f.hf} does not match the signed catalog (got ${got}); it was deleted`);
    }
    log.log?.(`  ${f.id}: SHA-256 matches the signed catalog`);
  }
  return { files: check.length };
}

// Checks every Pocket file already downloaded (voices arrive on first use).
async function verifyModel({ installs = createInstalls() } = {}) {
  const model = modelFiles(installs);
  const results = [];
  for (const f of [...model.files, ...model.voices]) {
    const file = cachedFile(installs, f.hf);
    if (!fs.existsSync(file)) { results.push({ id: f.id, present: false }); continue; }
    results.push({ id: f.id, present: true, ok: (await sha256File(file)) === f.sha256 });
  }
  return results;
}

module.exports = {
  createPocketLauncher, downloadModel, verifyModel, missingSetup, engineEnv, cachedFile, stopAfterSeconds,
  VOICES, DEFAULT_VOICE, MAX_TEXT_CHARS,
};
