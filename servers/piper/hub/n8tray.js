/**
 * N8 Tray contract v2 for the VoiceDock hub (spec: n8watkins/n8tray,
 * spec/contract-v2.md, pinned at v0.1.0).
 *
 * - The manifest (voicedock.json in the per-user modules folder) says how N8
 *   Tray starts, stops and reads the hub. `node n8tray-manifest.js install`
 *   writes it; `npm run setup` and the Windows deploy run that.
 * - The token: 64 hex characters in <run>/voicedock.token, written at every
 *   start before the hub serves, readable by this user only.
 * - The control plane, /n8/v2/*: status, actions (stop, engine.start,
 *   engine.stop) and memory pressure. Every request needs the token; any
 *   Origin header or a Host other than 127.0.0.1/localhost with this port is
 *   refused, so neither a web page nor DNS rebinding can reach it.
 *
 * The data plane the extension uses (/tts, /engines, /presence, ...) is the
 * hub's own and needs no token (server.js).
 */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const express = require("express");
const { isoMs, selfStartMs, createCpuMeter, selfMemory } = require("./procinfo");

const APP_ID = "voicedock";
const SERVERS_DIR = path.resolve(__dirname, "..", "..");
const STATUS_INTERVAL_SECONDS = 5;

// The version N8 Tray shows: the VoiceDock release this checkout is.
function appVersion() {
  for (const file of [path.join(SERVERS_DIR, "..", "package.json"), path.join(__dirname, "..", "package.json")]) {
    try {
      const { version } = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof version === "string") return version;
    } catch (_) {}
  }
  return "0.0.0";
}

// ─── Folders (spec section 2) ─────────────────────────────────────────────
function runDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.N8TRAY_RUN_DIR) return env.N8TRAY_RUN_DIR;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(base, "N8Tray", "run");
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "N8Tray", "run");
  return env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, "n8tray") : null;
}

function modulesDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.N8TRAY_MODULES_DIR) return env.N8TRAY_MODULES_DIR;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(base, "N8Tray", "modules");
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "N8Tray", "modules");
  const data = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(data, "n8tray", "modules");
}

// The runtime folder is this user's only. Whoever creates it first sets that:
// mode 0700, or on Windows an ACL with only this user and SYSTEM.
function ensureRunDir(dir, { platform = process.platform, env = process.env } = {}) {
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform === "win32" && env.USERNAME) {
    try {
      execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${env.USERNAME}:(OI)(CI)F`, "/grant:r", "SYSTEM:(OI)(CI)F"], {
        windowsHide: true, stdio: "ignore", timeout: 5000,
      });
    } catch (_) {}
  }
  return dir;
}

function writeAtomic(file, text, mode) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

// ─── The manifest (spec section 3) ─────────────────────────────────────────
function buildManifest({ port = 7477, installDir = SERVERS_DIR, version = appVersion(), platform = process.platform } = {}) {
  const piperExe = platform === "win32" ? "piper/piper/piper.exe" : "piper/piper/piper";
  return {
    contract: 2,
    id: APP_ID,
    name: "VoiceDock",
    version,
    group: "Audio",
    description: "Local voices for the VoiceDock extension: the engine hub, Piper and Kokoro.",
    icon: "piper/tray/assets/online.png",
    installDir,
    platforms: ["windows", "macos", "linux"],
    status: { type: "http", url: `http://127.0.0.1:${port}/n8/v2/status`, intervalSeconds: 3, timeoutMs: 300 },
    run: {
      interpreter: "node",
      script: "piper/server.js",
      args: ["--managed"],
      cwd: "piper",
      stop: { type: "http", graceSeconds: 10 },
    },
    actions: [
      { id: "engine.start", label: "Start {component}", type: "http", component: true },
      { id: "engine.stop", label: "Stop {component}", type: "http", component: true },
    ],
    requires: [
      { check: "browser", why: "The VoiceDock extension reads pages aloud in the browser." },
      { check: "uv", for: ["kokoro"], why: "Runs Kokoro, the Python voice engine." },
    ],
    lifecycle: {
      demand: { processes: ["chrome", "msedge", "brave", "vivaldi"], stopAfterMinutes: 10 },
      features: ["pressure", "presence"],
    },
    resources: {
      budget: { warnMb: 900, maxMb: 1600, cpuWarnPercent: 40, sustainSeconds: 60 },
      hardCapMb: 2500,
    },
    open: { logs: "piper/logs", folder: "piper" },
    owns: [
      { program: piperExe },
      { program: "kokoro/.venv/**/python*", argsContain: "server.py" },
    ],
    menu: [
      { label: "Engine events", type: "open-url", url: `http://127.0.0.1:${port}/hub/events` },
      { label: "Open voices folder", type: "open-path", path: "piper/piper/voices" },
    ],
    trayIcon: "hide-when-hosted",
    autoStartDefault: true,
  };
}

function installManifest(options = {}) {
  const dir = options.modulesDir || modulesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${APP_ID}.json`);
  writeAtomic(file, JSON.stringify(buildManifest(options), null, 2) + "\n");
  return file;
}

function uninstallManifest(options = {}) {
  const file = path.join(options.modulesDir || modulesDir(), `${APP_ID}.json`);
  try {
    fs.rmSync(file);
    return file;
  } catch (_) {
    return null;
  }
}

// ─── Status document (spec section 4) ─────────────────────────────────────
const NAMES = { ready: "ready", idle: "sleeping", starting: "starting", failed: "failed", "not-installed": "not set up", "needs-setup": "needs setup", stopped: "off", busy: "busy" };

function summaryFor(components) {
  // The engine in use first: ready, then starting, then the rest.
  const rank = { ready: 0, starting: 1, failed: 2, idle: 3, stopped: 4, "needs-setup": 5, "not-installed": 6 };
  const parts = [...components]
    .sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9))
    .map((c) => `${c.name} ${NAMES[c.state] || c.state}`);
  return parts.join(", ").slice(0, 120);
}

/**
 * The control plane. hub: hub/engines.js. kokoro: the launcher, for its
 * processes. readers: the Piper reader tracker. onStop: ends the process.
 */
function createControlPlane({ hub, kokoro, readers, onStop, now = Date.now, version = appVersion() }) {
  const startedMs = selfStartMs();
  const cpu = createCpuMeter();
  let token = null;
  let resources = null;
  let components = null;
  let sampler = null;

  // Writes a fresh token to <run>/voicedock.token. Returns the run folder, or
  // null where there is none (Linux without XDG_RUNTIME_DIR): then the
  // control plane stays off and the hub runs standalone.
  function prepare({ dir = runDir() } = {}) {
    if (!dir) return null;
    ensureRunDir(dir);
    const next = crypto.randomBytes(32).toString("hex");
    writeAtomic(path.join(dir, `${APP_ID}.token`), next, 0o600);
    token = next;
    return dir;
  }

  async function sample() {
    const processes = [{
      pid: process.pid,
      startedAt: isoMs(startedMs),
      parentPid: process.ppid || 0,
      role: "hub",
      component: null,
      exe: "piper/server.js",
      ...selfMemory(),
      cpuPercent: cpu(),
    }];
    // Kokoro reports its own processes (Node cannot read another process's
    // start time and CPU cheaply on Windows); only one this hub started.
    if (kokoro.owned()) {
      const h = await kokoro.health(1000);
      for (const p of h?.processes || []) {
        if (!Number.isInteger(p.pid) || p.pid === process.pid) continue;
        const entry = {
          pid: p.pid, startedAt: p.startedAt, parentPid: p.parentPid ?? 0, role: p.role === "helper" ? "helper" : "engine",
          component: "kokoro", rssMb: p.rssMb ?? 0, cpuPercent: p.cpuPercent ?? null,
        };
        if (p.privateMb != null) entry.privateMb = p.privateMb;
        if (p.role !== "helper") entry.model = { loaded: h.modelLoaded === true };
        processes.push(entry);
      }
    }
    for (const r of readers.snapshot().readers) {
      if (!r.startedAt) continue;
      processes.push({
        pid: r.pid, startedAt: r.startedAt, parentPid: process.pid, role: "worker",
        component: "piper", exe: "piper", rssMb: r.rssMb ?? 0, cpuPercent: null,
      });
    }
    resources = { sampledAt: new Date(now()).toISOString(), intervalSeconds: STATUS_INTERVAL_SECONDS, processes };
    components = await engineComponents();
    return resources;
  }

  async function engineComponents() {
    const { engines } = await hub.list();
    return engines.map((e) => {
      const c = { id: e.id, name: e.name, state: e.state };
      if (e.detail) c.detail = String(e.detail).slice(0, 300);
      return c;
    });
  }

  function startSampling() {
    if (sampler) return;
    sample().catch(() => {});
    sampler = setInterval(() => { sample().catch(() => {}); }, STATUS_INTERVAL_SECONDS * 1000);
    if (sampler.unref) sampler.unref();
  }

  function stopSampling() {
    clearInterval(sampler);
    sampler = null;
  }

  // Built from the last sample (every 5 s, and after every action), so a
  // status request never waits on an engine (spec 5.1).
  async function statusDocument() {
    if (!resources || !components) await sample();
    const failed = components.filter((c) => c.state === "failed");
    const doc = {
      contract: 2,
      id: APP_ID,
      version,
      updatedAt: new Date(now()).toISOString(),
      pid: process.pid,
      pidStartedAt: isoMs(startedMs),
      features: ["pressure", "presence"],
      state: failed.length ? "degraded" : "ready",
      summary: summaryFor(components),
      components,
      presence: hub.presenceDoc(),
      resources,
      jobs: [],
    };
    if (failed.length) doc.detail = failed.map((c) => `${c.name}: ${c.detail || "failed"}`).join("; ").slice(0, 300);
    return doc;
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────
  function guard(req, res, next) {
    if (req.get("Origin") !== undefined) return res.status(403).json({ error: "Requests with an Origin are refused." });
    const port = req.socket.localPort;
    const host = String(req.get("Host") || "").toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return res.status(403).json({ error: "Wrong Host." });
    }
    if (!token) return res.status(503).json({ error: "No runtime folder, so the control plane is off." });
    const match = /^Bearer ([0-9a-f]{64})$/.exec(req.get("Authorization") || "");
    if (!match || !crypto.timingSafeEqual(Buffer.from(match[1]), Buffer.from(token))) {
      return res.status(401).json({ error: "Missing or wrong token." });
    }
    next();
  }

  const COMPONENTS = ["piper", "kokoro"];

  async function engineStart(component) {
    if (component === "piper") {
      try {
        await hub.ensure("piper");
        return { outcome: "already", message: "Piper needs no process: it runs per read." };
      } catch (err) {
        return { outcome: "refused", message: err.message };
      }
    }
    const before = await kokoro.health(400);
    if (before) return { outcome: "already", message: "Kokoro is running." };
    try {
      const result = await hub.ensure(component, { manual: true });
      return { outcome: "ok", message: `Kokoro is ready (${(result.startedMs / 1000).toFixed(1)} s).` };
    } catch (err) {
      const refused = err.code === "not-installed" || err.code === "low-memory";
      return { outcome: refused ? "refused" : "failed", message: err.message };
    }
  }

  async function engineStop(component) {
    if (component === "piper") return { outcome: "already", message: "Piper has no process while idle." };
    if (kokoro.owned()) {
      await hub.stopEngine("kokoro", "asked by N8 Tray");
      return { outcome: "ok" };
    }
    if (await kokoro.health(400)) return { outcome: "refused", message: "This Kokoro was started outside VoiceDock, so VoiceDock leaves it alone." };
    return { outcome: "already", message: "Kokoro is not running." };
  }

  const router = express.Router();
  router.use(guard);
  router.use(express.json({ limit: "16kb" }));

  router.get("/status", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await statusDocument());
  });

  router.post("/actions/:id", async (req, res) => {
    const id = req.params.id;
    if (id === "stop") {
      res.json({ outcome: "ok", message: "Stopping." });
      res.on("finish", () => onStop("asked by N8 Tray"));
      return;
    }
    if (id !== "engine.start" && id !== "engine.stop") return res.status(404).json({ error: `Unknown action: ${id}` });
    const component = req.body?.component;
    if (!COMPONENTS.includes(component)) return res.status(400).json({ error: "Unknown or missing component." });
    const result = id === "engine.start" ? await engineStart(component) : await engineStop(component);
    await sample().catch(() => {});
    res.json(result);
  });

  router.post("/pressure", async (req, res) => {
    const level = req.body?.level;
    try {
      await hub.setPressure(level);
      await sample().catch(() => {});
      res.json({ outcome: "ok" });
    } catch (_) {
      res.status(400).json({ error: "level must be ok, attention or problem." });
    }
  });

  router.use((_req, res) => res.status(404).json({ error: "Not found." }));
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => res.status(400).json({ error: "Invalid request body." }));

  return { router, prepare, statusDocument, sample, startSampling, stopSampling, hasToken: () => token !== null };
}

module.exports = {
  APP_ID, runDir, modulesDir, ensureRunDir, buildManifest, installManifest, uninstallManifest,
  createControlPlane, appVersion, summaryFor,
};
