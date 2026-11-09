/**
 * Engine installs from the signed catalog, side by side with rollback.
 *
 *   <engines>/<engine>/<version>/      one folder per installed version
 *   <engines>/<engine>/state.json      { current, previous }
 *   <engines>/catalog-state.json       { serial } of the newest catalog used
 *
 * <engines> is servers/engines next to the hub (VOICEDOCK_ENGINES_DIR
 * overrides). An install downloads into a temporary folder, checks the size
 * and SHA-256 against the catalog, unpacks, and only then renames the folder
 * into place and switches "current", keeping the version before it as
 * "previous": rollback switches back without downloading anything. Nothing
 * is ever installed on its own: every step here runs because someone ran
 * `node engines.js ...` or pressed a button that says what it does.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { loadCatalog, engineVersion, programFor, platformKey } = require("./catalog");
const { SERVERS_DIR } = require("./paths");

function enginesDir(env = process.env) {
  return path.resolve(env.VOICEDOCK_ENGINES_DIR || path.join(SERVERS_DIR, "engines"));
}

const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENGINE_RE = /^[a-z][a-z0-9-]{0,31}$/;

function checkIds(engine, version) {
  if (!ENGINE_RE.test(engine)) throw new Error(`Not an engine id: ${engine}`);
  if (version != null && !VERSION_RE.test(version)) throw new Error(`Not a version: ${version}`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function systemTar(platform = process.platform, env = process.env) {
  // Windows 10 1803+ ships bsdtar, which unpacks .zip too. By absolute path,
  // so Git's GNU tar on PATH (no zip support) is never picked up.
  return platform === "win32" ? path.join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
}

function unpack(archive, dest, { platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    execFile(systemTar(platform), ["-xf", archive, "-C", dest], { windowsHide: true, timeout: 120_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`Could not unpack ${path.basename(archive)}: ${String(stderr || err.message).trim()}`));
      else resolve();
    });
  });
}

/**
 * Downloads `url` to `file`, hashing as it goes. Rejects (and removes the
 * file) when the size or SHA-256 differ from what is expected.
 */
async function download(url, file, { sha256, size, fetchImpl = globalThis.fetch, onProgress } = {}) {
  const res = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "voicedock-hub" } });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(file);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk);
      got += buf.length;
      if (size && got > size) throw new Error(`Download is larger than the catalog says (${size} bytes)`);
      hash.update(buf);
      if (!out.write(buf)) await new Promise((r) => out.once("drain", r));
      onProgress?.(got, size);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw err;
  }
  const digest = hash.digest("hex");
  if (size && got !== size) {
    fs.rmSync(file, { force: true });
    throw new Error(`Download size ${got} differs from the catalog's ${size}`);
  }
  if (digest !== sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`Download does not match the catalog's SHA-256 (got ${digest})`);
  }
  return { bytes: got, sha256: digest };
}

function createInstalls({ dir = enginesDir(), catalogOptions = {}, fetchImpl = globalThis.fetch, platform = process.platform, arch = process.arch, log = console, now = () => new Date() } = {}) {
  const stateFile = (engine) => path.join(dir, engine, "state.json");
  const catalogStateFile = path.join(dir, "catalog-state.json");

  function catalog() {
    const seen = readJson(catalogStateFile, { serial: 0 });
    const c = loadCatalog({ ...catalogOptions, minSerial: seen.serial || 0 });
    if ((seen.serial || 0) < c.serial) writeJsonAtomic(catalogStateFile, { serial: c.serial });
    return c;
  }

  function state(engine) {
    checkIds(engine);
    const s = readJson(stateFile(engine), {});
    return { current: s.current || null, previous: s.previous || null };
  }

  function versionDir(engine, version) {
    checkIds(engine, version);
    return path.join(dir, engine, version);
  }

  function installed(engine) {
    checkIds(engine);
    const base = path.join(dir, engine);
    let names = [];
    try {
      names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory() && VERSION_RE.test(d.name)).map((d) => d.name);
    } catch (_) {}
    return names
      .map((version) => ({ version, ...readJson(path.join(base, version, "install.json"), null) }))
      .filter((v) => v.program)
      .sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)));
  }

  // The current version's program, or null when the engine is not installed
  // (or its folder was removed by hand).
  function program(engine) {
    const { current } = state(engine);
    if (!current) return null;
    const info = readJson(path.join(versionDir(engine, current), "install.json"), null);
    if (!info?.program) return null;
    const file = path.join(versionDir(engine, current), info.program);
    return fs.existsSync(file) ? { version: current, file, dir: versionDir(engine, current), info } : null;
  }

  function setCurrent(engine, version) {
    const s = state(engine);
    if (s.current === version) return s;
    const next = { current: version, previous: s.current };
    writeJsonAtomic(stateFile(engine), next);
    return next;
  }

  /**
   * Installs an engine's program from the catalog (newest version unless
   * one is given) and makes it current. Returns { version, dir, already }.
   */
  async function install(engine, { version, onProgress } = {}) {
    checkIds(engine, version);
    const c = catalog();
    const { engine: entry, release } = engineVersion(c, engine, version);
    const key = platformKey(platform, arch);
    const art = programFor(release, key);
    if (!art) throw new Error(`${entry.name} ${release.version} has no download for this computer (${key || `${platform}-${arch}`})`);
    const target = versionDir(engine, release.version);
    const existing = readJson(path.join(target, "install.json"), null);
    if (existing?.sha256 === art.sha256 && fs.existsSync(path.join(target, existing.program))) {
      setCurrent(engine, release.version);
      return { version: release.version, dir: target, already: true };
    }
    const work = path.join(dir, engine, `.install-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(path.join(work, "unpacked"), { recursive: true });
    try {
      const archive = path.join(work, path.basename(new URL(art.url).pathname));
      log.log?.(`[install] ${entry.name} ${release.version}: downloading ${art.url} (${(art.size / 1e6).toFixed(1)} MB)`);
      await download(art.url, archive, { sha256: art.sha256, size: art.size, fetchImpl, onProgress });
      log.log?.(`[install] SHA-256 matches the signed catalog: ${art.sha256}`);
      await unpack(archive, path.join(work, "unpacked"), { platform });
      const stage = path.join(work, "stage");
      fs.mkdirSync(stage);
      const programName = path.basename(art.program);
      const from = path.join(work, "unpacked", ...art.program.split("/"));
      if (!fs.existsSync(from)) throw new Error(`The archive has no ${art.program}`);
      fs.copyFileSync(from, path.join(stage, programName));
      if (platform !== "win32") fs.chmodSync(path.join(stage, programName), 0o755);
      if (art.license) {
        const lic = path.join(work, "unpacked", ...art.license.split("/"));
        if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(stage, "LICENSE"));
      }
      writeJsonAtomic(path.join(stage, "install.json"), {
        engine, version: release.version, program: programName, sha256: art.sha256, url: art.url,
        platform: key, catalogSerial: c.serial, installedAt: now().toISOString(),
      });
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); // a broken earlier attempt
      fs.renameSync(stage, target);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    setCurrent(engine, release.version);
    log.log?.(`[install] ${entry.name} ${release.version} installed in ${target}`);
    return { version: release.version, dir: target, already: false };
  }

  // Switches to an installed version.
  function use(engine, version) {
    checkIds(engine, version);
    if (!installed(engine).some((v) => v.version === version)) throw new Error(`${engine} ${version} is not installed`);
    return setCurrent(engine, version);
  }

  // Back to the version before the current one.
  function rollback(engine) {
    const s = state(engine);
    if (!s.previous) throw new Error(`No earlier ${engine} version to go back to`);
    return use(engine, s.previous);
  }

  // Removes an installed version that is not current.
  function remove(engine, version) {
    checkIds(engine, version);
    const s = state(engine);
    if (s.current === version) throw new Error(`${engine} ${version} is in use; switch to another version first (or uninstall)`);
    fs.rmSync(versionDir(engine, version), { recursive: true, force: true });
    if (s.previous === version) writeJsonAtomic(stateFile(engine), { current: s.current, previous: null });
  }

  // Removes every version and the engine's data folder.
  function uninstall(engine) {
    checkIds(engine);
    fs.rmSync(path.join(dir, engine), { recursive: true, force: true });
  }

  return { catalog, state, installed, program, install, use, rollback, remove, uninstall, versionDir, dir };
}

// SHA-256 of a file, streamed.
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => hash.update(c)).on("error", reject).on("end", () => resolve(hash.digest("hex")));
  });
}

module.exports = { createInstalls, enginesDir, download, sha256File, unpack, systemTar };
