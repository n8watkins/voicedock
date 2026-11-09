/**
 * Crash bookkeeping for an engine the hub starts (Kokoro, Pocket TTS).
 *
 * An engine that exits on its own with an error, or while starting, counts as
 * a crash. The next start waits 1, 2, 4 ... 60 s after repeated crashes, and
 * after 5 crashes in 10 minutes the engine is "failed" until it is started by
 * hand (N8 Tray's engine.start) or the hub restarts.
 */

const CRASH_WINDOW_MS = 10 * 60_000;
const CRASHES_TO_FAIL = 5;
const MAX_BACKOFF_MS = 60_000;
// A start waits out a backoff this short; a longer one is refused instead,
// so a read never hangs on a crashing engine.
const MAX_BACKOFF_WAIT_MS = 4_000;

// Backoff before the next start after `consecutive` crashes in a row:
// none after the first, then 1, 2, 4 ... 60 s.
function crashBackoffMs(consecutive) {
  if (consecutive < 2) return 0;
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (consecutive - 2));
}

function createCrashTracker({ name, now = Date.now, log = console } = {}) {
  let crashes = [];
  let consecutive = 0;
  let lastCrashAt = null;
  let lastError = null;
  let failed = false;

  function record(reason) {
    const t = now();
    lastCrashAt = t;
    lastError = reason;
    consecutive += 1;
    crashes = crashes.filter((c) => t - c < CRASH_WINDOW_MS).concat(t);
    if (crashes.length >= CRASHES_TO_FAIL && !failed) {
      failed = true;
      log.error?.(`[${name.toLowerCase()}] failed: ${crashes.length} crashes in 10 minutes; it starts again only when asked by hand`);
    }
  }

  function backoffLeftMs() {
    if (lastCrashAt == null) return 0;
    return Math.max(0, lastCrashAt + crashBackoffMs(consecutive) - now());
  }

  // Asked by hand: forget the streak and the failed state.
  function reset() {
    failed = false;
    crashes = [];
    consecutive = 0;
    lastCrashAt = null;
  }

  // A run that ended without crashing ends the streak.
  function cleanStop() {
    consecutive = 0;
  }

  // Throws a coded error when a start must not happen now; resolves to the
  // milliseconds to wait first otherwise.
  function gate() {
    if (failed) {
      const err = new Error(`${name} keeps crashing (${lastError}); start it by hand to try again`);
      err.code = "failed";
      throw err;
    }
    const wait = backoffLeftMs();
    if (wait > MAX_BACKOFF_WAIT_MS) {
      const err = new Error(`${name} crashed; it can start again in ${Math.ceil(wait / 1000)} s`);
      err.code = "failed";
      throw err;
    }
    return wait;
  }

  return {
    record, reset, cleanStop, gate, backoffLeftMs,
    failed: () => failed,
    lastError: () => lastError,
  };
}

module.exports = { createCrashTracker, crashBackoffMs, CRASH_WINDOW_MS, CRASHES_TO_FAIL, MAX_BACKOFF_WAIT_MS };
