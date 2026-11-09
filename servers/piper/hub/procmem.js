/**
 * Memory of another process (an engine the hub started), without a native
 * module: /proc on Linux, `ps` on macOS, `tasklist` on Windows (its "Mem
 * Usage" is the working set, what Task Manager shows). Resolves to MB, or
 * null when the process is gone or the figure can't be read.
 *
 * Also the computer's free memory, for the hub's own pressure reading when
 * N8 Tray isn't there (hub/pressure.js).
 */

const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");

const round1 = (n) => Math.round(n * 10) / 10;

function run(cmd, args, timeoutMs = 2000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// "12,345 K" in tasklist's CSV, in any locale's digit grouping.
function parseTasklistKb(csvLine) {
  const cells = String(csvLine || "").trim().match(/"([^"]*)"/g);
  if (!cells || cells.length < 5) return null;
  const digits = cells[4].replace(/[^0-9]/g, "");
  return digits ? Number(digits) : null;
}

async function rssMbOf(pid, { platform = process.platform, readFile = fs.readFileSync, exec = run } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "linux") {
    try {
      const m = /^VmRSS:\s+(\d+) kB/m.exec(readFile(`/proc/${pid}/status`, "utf8"));
      return m ? round1(Number(m[1]) / 1024) : null;
    } catch (_) {
      return null;
    }
  }
  if (platform === "win32") {
    const out = await exec("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
    const kb = parseTasklistKb(out?.split(/\r?\n/).find((l) => l.includes(`"${pid}"`)));
    return kb == null ? null : round1(kb / 1024);
  }
  const out = await exec("ps", ["-o", "rss=", "-p", String(pid)]);
  const kb = Number(String(out || "").trim());
  return out && Number.isFinite(kb) && kb > 0 ? round1(kb / 1024) : null;
}

// Free memory in GiB. On Linux MemAvailable (what can be had without
// swapping) rather than MemFree; elsewhere os.freemem(), which on Windows is
// the "Available" figure Task Manager shows.
function freeGiB({ platform = process.platform, readFile = fs.readFileSync, freemem = os.freemem } = {}) {
  if (platform === "linux") {
    try {
      const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFile("/proc/meminfo", "utf8"));
      if (m) return Number(m[1]) / 1024 / 1024;
    } catch (_) {}
  }
  return freemem() / 1024 ** 3;
}

module.exports = { rssMbOf, parseTasklistKb, freeGiB };
