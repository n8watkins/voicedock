/**
 * The signed engine catalog (servers/catalog/engines.json): every download
 * VoiceDock installs, pinned by SHA-256, signed with the VoiceDock catalog
 * key in minisign's format. Nothing is installed from a catalog whose
 * signature does not check out, and a catalog older than one already used
 * (a lower "serial") is refused, so an old catalog with an old download
 * can't be replayed.
 */

const fs = require("fs");
const path = require("path");
const minisign = require("./minisign");
const { SERVERS_DIR } = require("./paths");

const CATALOG_DIR = path.join(SERVERS_DIR, "catalog");

// The catalog key, built in: a catalog file can't bring its own key.
const PUBLIC_KEY = "untrusted comment: minisign public key E80F2A202F080226\nRWQmAggvICoP6J5loWwdHtKHW/oL8wbMBl4m1i/TCtcTVC3MD478jctm\n";

// This computer as a catalog platform key: windows-x64, macos-arm64, ...
function platformKey(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

/**
 * Reads and verifies a catalog. Returns the parsed catalog with
 * `trustedComment`. Throws when the signature is missing or wrong, or when
 * `minSerial` is higher than the catalog's serial.
 */
function loadCatalog({ dir = CATALOG_DIR, publicKey = PUBLIC_KEY, minSerial = 0, readFile = fs.readFileSync } = {}) {
  const file = path.join(dir, "engines.json");
  const data = readFile(file);
  let signature;
  try {
    signature = readFile(`${file}.minisig`, "utf8");
  } catch (_) {
    throw new Error("The engine catalog has no signature (engines.json.minisig)");
  }
  let trustedComment;
  try {
    ({ trustedComment } = minisign.verify(Buffer.from(data), signature, publicKey));
  } catch (err) {
    throw new Error(`The engine catalog's signature is not valid: ${err.message}`);
  }
  const catalog = JSON.parse(Buffer.from(data).toString("utf8"));
  if (!Number.isInteger(catalog.serial) || !trustedComment.includes(`serial:${catalog.serial} `)) {
    throw new Error("The engine catalog's serial does not match its signature");
  }
  if (catalog.serial < minSerial) {
    throw new Error(`The engine catalog is older (serial ${catalog.serial}) than one already used (serial ${minSerial})`);
  }
  return { ...catalog, trustedComment };
}

// An engine's entry for one version (newest first in the catalog when no
// version is given).
function engineVersion(catalog, engine, version) {
  const entry = catalog.engines?.[engine];
  if (!entry) throw new Error(`The catalog has no engine "${engine}"`);
  const found = version ? entry.versions.find((v) => v.version === version) : entry.versions[0];
  if (!found) throw new Error(`The catalog has no ${entry.name} ${version}`);
  return { engine: entry, release: found };
}

// The program download for this computer, or null where there is none.
function programFor(release, key = platformKey()) {
  return (key && release.program?.[key]) || null;
}

module.exports = { loadCatalog, engineVersion, programFor, platformKey, PUBLIC_KEY, CATALOG_DIR };
