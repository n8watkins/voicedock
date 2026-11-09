/**
 * Memory pressure without N8 Tray (plan section 5.5): the hub reads the
 * computer's free memory itself, every 10 s, with the same defaults N8 Tray
 * uses on Windows:
 *
 *   attention  free below 3 GiB for 10 s    (VOICEDOCK_MEMORY_ATTENTION_GIB)
 *   problem    free below 1.5 GiB for 10 s  (VOICEDOCK_MEMORY_PROBLEM_GIB)
 *
 * A better level must hold for 60 s before the hub relaxes, and with 10%
 * hysteresis (back to ok above 3.3 GiB after attention, above 1.65 GiB
 * after problem), so engines don't flap between start and stop.
 *
 * N8 Tray knows more (WSL, every app's tree), so once it has pushed a level
 * (POST /n8/v2/pressure) and its host lease is fresh, its word stands and
 * this monitor only watches. When N8 Tray goes away, the monitor takes over
 * again. VOICEDOCK_MEMORY_WATCH=0 turns the monitor off.
 */

const fs = require("fs");
const path = require("path");
const { freeGiB: readFreeGiB } = require("./procmem");

const RANK = { ok: 0, attention: 1, problem: 2 };
const WORSE_AFTER_MS = 10_000;
const BETTER_AFTER_MS = 60_000;
const LEASE_FRESH_MS = 15_000;

function gibFromEnv(env, name, fallback) {
  const n = Number(env[name]);
  return env[name] != null && String(env[name]).trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

// The level free memory alone says, given the level now (for hysteresis).
function levelFor(free, current, { attentionGiB, problemGiB }) {
  const problemExit = problemGiB * 1.1;
  const attentionExit = attentionGiB * 1.1;
  if (free < problemGiB) return "problem";
  if (current === "problem" && free < problemExit) return "problem";
  if (free < attentionGiB) return "attention";
  if (current !== "ok" && free < attentionExit) return "attention";
  return "ok";
}

// N8 Tray's lease (run/host.json): fresh and hosting VoiceDock.
function hostLeaseFresh({ runDir, now = Date.now, readFile = fs.readFileSync } = {}) {
  if (!runDir) return false;
  try {
    const lease = JSON.parse(readFile(path.join(runDir, "host.json"), "utf8"));
    const beat = Date.parse(lease.heartbeat);
    return Array.isArray(lease.hosting) && lease.hosting.includes("voicedock") && Number.isFinite(beat) && now() - beat < LEASE_FRESH_MS;
  } catch (_) {
    return false;
  }
}

function createPressureMonitor({
  hub,
  env = process.env,
  freeGiB = () => readFreeGiB(),
  leaseFresh = () => false,
  now = Date.now,
  intervalMs = 10_000,
  log = console,
}) {
  const limits = {
    attentionGiB: gibFromEnv(env, "VOICEDOCK_MEMORY_ATTENTION_GIB", 3),
    problemGiB: gibFromEnv(env, "VOICEDOCK_MEMORY_PROBLEM_GIB", 1.5),
  };
  const enabled = env.VOICEDOCK_MEMORY_WATCH !== "0";
  let pushedAt = null;       // last level N8 Tray pushed
  let candidate = null;      // { level, since }: a change waiting out its hold
  let lastFree = null;
  let timer = null;

  // N8 Tray pushed a level: from now on it decides while its lease is fresh.
  function pushed() {
    pushedAt = now();
    candidate = null;
  }

  function source() {
    if (!enabled) return "off";
    return pushedAt != null && leaseFresh() ? "n8tray" : "hub";
  }

  async function tick() {
    if (source() !== "hub") return null;
    let free;
    try { free = freeGiB(); } catch (_) { return null; }
    if (!Number.isFinite(free)) return null;
    lastFree = free;
    const current = hub.pressure();
    const wanted = levelFor(free, current, limits);
    if (wanted === current) { candidate = null; return current; }
    if (!candidate || candidate.level !== wanted) candidate = { level: wanted, since: now() };
    const hold = RANK[wanted] > RANK[current] ? WORSE_AFTER_MS : BETTER_AFTER_MS;
    if (now() - candidate.since < hold) return current;
    candidate = null;
    log.log?.(`[hub] free memory ${free.toFixed(2)} GiB: pressure ${wanted} (read by the hub)`);
    await hub.setPressure(wanted, { source: "hub", freeGiB: Math.round(free * 100) / 100 });
    return wanted;
  }

  function start() {
    if (timer || !enabled) return;
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  function doc() {
    return { source: source(), freeGiB: lastFree == null ? null : Math.round(lastFree * 100) / 100, ...limits };
  }

  return { tick, start, stop, pushed, source, doc };
}

module.exports = { createPressureMonitor, levelFor, hostLeaseFresh };
