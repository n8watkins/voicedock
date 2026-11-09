#!/usr/bin/env node
/**
 * Installs voice engines from the signed catalog, one step at a time:
 *
 *   node engines.js list                     what is installed, current and previous
 *   node engines.js catalog                  check the catalog's signature, list its downloads
 *   node engines.js install <engine> [ver]   download, check SHA-256, install side by side
 *   node engines.js model pocket             download Pocket TTS's model (about 222 MB), check it
 *   node engines.js verify pocket            check every downloaded Pocket file against the catalog
 *   node engines.js use <engine> <version>   switch to another installed version
 *   node engines.js rollback <engine>        back to the version before
 *   node engines.js remove <engine> <ver>    delete a version that is not in use
 *   node engines.js uninstall <engine>       delete every version and its data
 *
 * Each command does only what it says, and says what it did.
 */
const { createInstalls } = require("./hub/installs");
const { platformKey } = require("./hub/catalog");
const readline = require("readline");

const installs = createInstalls();
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const [command, engine, version] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// Engines whose model comes with terms (Pocket TTS: CC-BY-4.0, and no
// cloning a voice without consent) ask before installing.
async function acceptTerms(id) {
  const entry = installs.catalog().engines[id];
  const terms = entry?.license?.terms;
  if (!terms) return;
  console.log(`${entry.name} by ${entry.by}. Program: ${entry.license.program}. Model: ${entry.license.model} (${entry.license.modelCard}).`);
  console.log(`Voices: ${entry.license.voices}`);
  console.log(`Terms: ${terms}`);
  if (flags.has("--accept-terms")) return;
  if (!process.stdin.isTTY) throw new Error("Add --accept-terms to accept the terms above");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question("Type yes to accept and install: ", r));
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") throw new Error("Not installed: the terms were not accepted");
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0)} MB`;
}

async function main() {
  if (command === "list") {
    for (const id of Object.keys(installs.catalog().engines)) {
      const s = installs.state(id);
      const versions = installs.installed(id).map((v) => v.version);
      console.log(`${id}: ${versions.length ? `installed ${versions.join(", ")}; current ${s.current || "none"}${s.previous ? `; previous ${s.previous}` : ""}` : "not installed from the catalog"}`);
    }
    return;
  }
  if (command === "catalog") {
    const c = installs.catalog();
    console.log(`Catalog serial ${c.serial}, issued ${c.issuedAt}: signature OK (${c.trustedComment})`);
    const key = platformKey();
    for (const [id, e] of Object.entries(c.engines)) {
      for (const r of e.versions) {
        const p = r.program?.[key];
        console.log(`  ${id} ${r.version}: ${p ? `${p.url} (${mb(p.size)}, sha256 ${p.sha256})` : "no program download for this computer"}`);
        for (const f of r.files || []) console.log(`    ${f.id}: ${f.url} (${mb(f.size)}, sha256 ${f.sha256})`);
        for (const f of r.model?.files || []) console.log(`    ${f.id}: hf://${f.hf} (${mb(f.size)}, sha256 ${f.sha256})`);
      }
    }
    return;
  }
  if (!engine) throw new Error("Name an engine, for example: node engines.js install pocket");
  if (command === "install") {
    await acceptTerms(engine);
    let last = 0;
    const result = await installs.install(engine, {
      version,
      onProgress: (got, size) => {
        const pct = size ? Math.floor((got / size) * 10) * 10 : 0;
        if (pct > last) { last = pct; process.stdout.write(`  ${pct}%${pct === 100 ? "\n" : ""}`); }
      },
    });
    console.log(result.already ? `${engine} ${result.version} was already installed; it is current.` : `${engine} ${result.version} is installed and current.`);
    if (engine === "pocket") console.log("Next: node engines.js model pocket (downloads its voice model, about 222 MB)");
    return;
  }
  if (command === "model" && engine === "pocket") {
    const { downloadModel } = require("./pocket");
    await downloadModel({ installs });
    console.log("Pocket TTS is set up. VoiceDock starts it the first time you read with a Pocket voice.");
    return;
  }
  if (command === "verify" && engine === "pocket") {
    const { verifyModel } = require("./pocket");
    const results = await verifyModel({ installs });
    let bad = 0;
    for (const r of results.filter((x) => x.present)) {
      console.log(`  ${r.id}: ${r.ok ? "OK" : "DIFFERS from the catalog"}`);
      if (!r.ok) bad += 1;
    }
    console.log(`${results.filter((x) => x.present).length} files checked, ${results.filter((x) => !x.present).length} not downloaded yet (voices arrive on first use).`);
    if (bad) throw new Error(`${bad} file(s) differ: run node engines.js uninstall pocket, then set it up again`);
    return;
  }
  if (command === "use") {
    if (!version) throw new Error("Name the version: node engines.js use <engine> <version>");
    installs.use(engine, version);
    console.log(`${engine} ${version} is current. Restart VoiceDock's server, or wait for the engine to stop, to use it.`);
    return;
  }
  if (command === "rollback") {
    const s = installs.rollback(engine);
    console.log(`${engine} ${s.current} is current again (${s.previous} stays installed).`);
    return;
  }
  if (command === "remove") {
    if (!version) throw new Error("Name the version: node engines.js remove <engine> <version>");
    installs.remove(engine, version);
    console.log(`${engine} ${version} removed.`);
    return;
  }
  if (command === "uninstall") {
    installs.uninstall(engine);
    console.log(`${engine} removed, with its downloaded model.`);
    return;
  }
  throw new Error(`Unknown command: ${command || "(none)"}. See the top of engines.js.`);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
