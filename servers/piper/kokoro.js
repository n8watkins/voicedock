/**
 * Kokoro on demand, run by the Piper server.
 *
 * The Piper server is always on while VoiceDock is (N8 Tray or the VoiceDock
 * tray keeps it up), and it is cheap: about 35 MB, with no Piper process
 * while idle. Kokoro is heavy (300-700 MB while its model is loaded), so it
 * runs only while it is used:
 *
 * - Start on demand. The extension asks POST /engines/kokoro/start when a
 *   Kokoro read finds port 7478 silent; this module starts Kokoro from its
 *   uv environment (servers/kokoro/.venv, made by setup.ps1 or setup.sh) and
 *   answers once Kokoro's /health does.
 * - Unload, then stop. Kokoro releases its model after 10 idle minutes (its
 *   own KOKORO_IDLE_UNLOAD_SECONDS) and exits after 30 (KOKORO_IDLE_EXIT_SECONDS,
 *   set here), so an unused engine costs nothing.
 * - Only the engine in use runs. A Piper read stops a Kokoro this server
 *   started, unless it is speaking.
 * - It never outlives this server: Kokoro gets KOKORO_PARENT_PID and exits
 *   when this process is gone, even when this one is killed outright.
 *
 * A Kokoro someone else started (a systemd unit, a terminal) is left alone:
 * it is reported as running and never stopped from here.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const KOKORO_PORT = Number(process.env.KOKORO_PORT || 7478);
const KOKORO_HOST = "127.0.0.1";
const START_TIMEOUT_MS = 25_000;
const DEFAULT_STOP_AFTER_SECONDS = 1800;

function kokoroDir() {
  return path.resolve(process.env.KOKORO_DIR || path.join(__dirname, "..", "kokoro"));
}

// The interpreter in Kokoro's uv environment. Started directly (not through
// `uv run`) so the process this server owns is the server itself: stopping it
// stops Kokoro, with no launcher left behind.
function kokoroPython(dir = kokoroDir(), platform = process.platform) {
  return platform === "win32"
    ? path.join(dir, ".venv", "Scripts", "python.exe")
    : path.join(dir, ".venv", "bin", "python");
}

function stopAfterSeconds(env = process.env) {
  const n = Number(env.KOKORO_STOP_AFTER_SECONDS);
  return Number.isFinite(n) && n >= 0 && String(env.KOKORO_STOP_AFTER_SECONDS).trim() !== ""
    ? n
    : DEFAULT_STOP_AFTER_SECONDS;
}

// What is missing for Kokoro to run, as plain words for the extension, or
// null when it is set up.
function missingSetup({ dir = kokoroDir(), exists = fs.existsSync, platform = process.platform } = {}) {
  if (!exists(path.join(dir, "server.py"))) return "Kokoro's folder was not found next to the Piper server";
  if (!exists(kokoroPython(dir, platform))) return "Kokoro's Python environment is missing: run setup.ps1 (Windows) or setup.sh";
  for (const file of ["kokoro-v1.0.onnx", "voices-v1.0.bin"]) {
    if (!exists(path.join(dir, "models", file))) return `Kokoro's model file ${file} is missing: run setup.ps1 (Windows) or setup.sh`;
  }
  return null;
}

// Kokoro's voice ids from its voices file without starting Kokoro.
// voices-v1.0.bin is a NumPy .npz archive, a zip with one "<voice>.npy" member
// per voice, so the zip's central directory lists the voices: read the end
// record, then the directory (a few KB), never the 27 MB of voice data.
function readVoiceNames(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557); // end record (22 B) + max comment
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    const dir = Buffer.alloc(dirSize);
    fs.readSync(fd, dir, 0, dirSize, dirOffset);
    const names = [];
    let at = 0;
    for (let n = 0; n < count && at + 46 <= dir.length; n++) {
      if (dir.readUInt32LE(at) !== 0x02014b50) throw new Error("bad zip directory");
      const nameLen = dir.readUInt16LE(at + 28);
      const extraLen = dir.readUInt16LE(at + 30);
      const commentLen = dir.readUInt16LE(at + 32);
      const name = dir.toString("utf8", at + 46, at + 46 + nameLen);
      if (name.endsWith(".npy")) names.push(name.slice(0, -4));
      at += 46 + nameLen + extraLen + commentLen;
    }
    return names.sort();
  } finally {
    fs.closeSync(fd);
  }
}

async function kokoroHealth(timeoutMs = 800) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${KOKORO_HOST}:${KOKORO_PORT}/health`, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function createKokoroLauncher({
  health = kokoroHealth,
  spawnImpl = spawn,
  setup = () => missingSetup(),
  dir = kokoroDir,
  python = () => kokoroPython(),
  logFile = path.join(__dirname, "logs", "kokoro.log"),
  startTimeoutMs = START_TIMEOUT_MS,
  pollMs = 250,
  env = process.env,
  log = console,
} = {}) {
  let child = null;      // the Kokoro process this server started, while it runs
  let starting = null;   // the in-flight start, shared by concurrent callers
  let startedAt = null;

  function owned() {
    return child !== null && child.exitCode === null && child.signalCode === null;
  }

  function launch() {
    const stdio = ["ignore", "ignore", "ignore"];
    let out = null;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      out = fs.openSync(logFile, "a");
      stdio[1] = out;
      stdio[2] = out;
    } catch (_) {}
    const proc = spawnImpl(python(), ["server.py"], {
      cwd: dir(),
      stdio,
      windowsHide: true,
      env: {
        ...env,
        PYTHONUNBUFFERED: "1",
        KOKORO_PORT: String(KOKORO_PORT),
        KOKORO_IDLE_EXIT_SECONDS: String(stopAfterSeconds(env)),
        KOKORO_PARENT_PID: String(process.pid),
      },
    });
    if (out !== null) fs.closeSync(out);
    proc.on("error", (err) => log.error?.(`[kokoro] could not start: ${err.message}`));
    proc.on("exit", (code, signal) => {
      if (child === proc) child = null;
      log.log?.(`[kokoro] stopped (${signal || `exit ${code}`})`);
    });
    child = proc;
    startedAt = Date.now();
    log.log?.(`[kokoro] starting (pid ${proc.pid})`);
    return proc;
  }

  async function waitUntilHealthy(proc) {
    const deadline = Date.now() + startTimeoutMs;
    while (Date.now() < deadline) {
      const h = await health();
      if (h) return h;
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`Kokoro exited while starting (see ${logFile})`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    stop();
    throw new Error(`Kokoro did not answer within ${Math.round(startTimeoutMs / 1000)} s (see ${logFile})`);
  }

  // Resolves to { state: "ready", owned, health, startedMs } once Kokoro
  // answers. Rejects with an Error whose `code` is "not-installed" when setup
  // is missing, or "failed" when it would not start.
  async function start() {
    const running = await health();
    if (running) return { state: "ready", owned: owned(), health: running, startedMs: 0 };
    if (starting) return starting;
    const missing = setup();
    if (missing) {
      const err = new Error(missing);
      err.code = "not-installed";
      throw err;
    }
    const began = Date.now();
    starting = (async () => {
      try {
        const proc = owned() ? child : launch();
        const h = await waitUntilHealthy(proc);
        const startedMs = Date.now() - began;
        log.log?.(`[kokoro] ready in ${(startedMs / 1000).toFixed(1)} s`);
        return { state: "ready", owned: true, health: h, startedMs };
      } catch (err) {
        err.code = err.code || "failed";
        throw err;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  // Stops the Kokoro this server started. Returns true when one was stopped.
  function stop() {
    if (!owned()) return false;
    const proc = child;
    child = null;
    try { proc.kill(); } catch (_) {}
    return true;
  }

  // A Piper read is about to start: stop our idle Kokoro, so only the engine
  // in use runs. One that is speaking (another tab, a sample) is left alone.
  async function yieldTo(engine) {
    if (engine === "kokoro" || !owned()) return false;
    const h = await health(300);
    if (h && (h.speaking || h.modelLoading)) return false;
    log.log?.(`[kokoro] stopping: ${engine} is reading now`);
    return stop();
  }

  // For GET /engines.
  async function status() {
    const h = await health();
    const missing = setup();
    let state = "stopped";
    if (starting) state = "starting";
    else if (h) state = h.modelLoading ? "starting" : "ready";
    else if (missing) state = "not-installed";
    return {
      id: "kokoro",
      state,
      owned: owned(),
      pid: owned() ? child.pid : (h?.pid ?? null),
      startedAt: owned() && startedAt ? new Date(startedAt).toISOString() : null,
      rssMb: h?.rssMb ?? null,
      modelLoaded: h?.modelLoaded ?? false,
      stopAfterSeconds: stopAfterSeconds(env),
      setup: missing,
      startsOnDemand: !missing,
    };
  }

  // Kokoro's voices while it is stopped, so the extension can list them
  // before the first read starts it. Null when it is not set up.
  let voiceCache = null;
  function voices() {
    if (setup()) return null;
    if (!voiceCache) voiceCache = readVoiceNames(path.join(dir(), "models", "voices-v1.0.bin"));
    return { engine: "kokoro", voices: voiceCache, defaultVoice: "af_heart" };
  }

  return { start, stop, yieldTo, status, owned, voices };
}

module.exports = { createKokoroLauncher, missingSetup, kokoroPython, stopAfterSeconds, kokoroDir, readVoiceNames };
