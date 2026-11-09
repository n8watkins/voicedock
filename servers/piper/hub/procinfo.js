/**
 * The hub's own process facts for the N8 Tray status document (contract v2,
 * resources): when this process started, its memory and its CPU share.
 *
 * Start time: on Linux it comes from /proc (the kernel's own figure, which is
 * what N8 Tray compares against); elsewhere from Node's uptime, which is
 * within a few milliseconds of the OS creation time.
 */

const fs = require("fs");
const os = require("os");

const MB = 1024 * 1024;
const round1 = (n) => Math.round(n * 10) / 10;

function isoMs(ms) {
  return new Date(ms).toISOString();
}

// /proc/self/stat field 22 is the start time in clock ticks after boot, and
// /proc/stat's btime is the boot time in seconds. Ticks are 100 per second on
// every Linux Node supports (USER_HZ).
function linuxStartMs(readFile = fs.readFileSync) {
  try {
    const stat = readFile("/proc/self/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    const btime = Number(/^btime (\d+)$/m.exec(readFile("/proc/stat", "utf8"))?.[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    return btime * 1000 + ticks * 10;
  } catch (_) {
    return null;
  }
}

function selfStartMs({ platform = process.platform, now = Date.now, uptime = process.uptime } = {}) {
  const fromProc = platform === "linux" ? linuxStartMs() : null;
  return fromProc ?? Math.round(now() - uptime() * 1000);
}

/**
 * CPU share of the whole machine since the previous call, like Task Manager:
 * all logical cores together are 100. null on the first call.
 */
function createCpuMeter({ cpuUsage = process.cpuUsage, hrtime = process.hrtime.bigint, cores = os.cpus().length || 1 } = {}) {
  let prev = null;
  return function sample() {
    const usage = cpuUsage();
    const at = hrtime();
    const cpuMicros = usage.user + usage.system;
    const result = prev
      ? round1(Math.max(0, (cpuMicros - prev.cpuMicros) / (Number(at - prev.at) / 1000) / cores * 100))
      : null;
    prev = { cpuMicros, at };
    return result;
  };
}

function selfMemory() {
  const rssMb = round1(process.memoryUsage().rss / MB);
  return { rssMb };
}

module.exports = { isoMs, selfStartMs, linuxStartMs, createCpuMeter, selfMemory };
