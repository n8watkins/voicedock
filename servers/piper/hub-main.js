/**
 * The entry point of the single-file hub (tools/build-hub.mjs bundles it and
 * builds one executable per OS, so nobody needs Node installed):
 *
 *   voicedock-hub                     run the hub (as node server.js does)
 *   voicedock-hub --managed           run it, started by N8 Tray
 *   voicedock-hub manifest install    write N8 Tray's manifest for this executable
 *   voicedock-hub manifest print      print it
 *   voicedock-hub engines <command>   the engine installer (engines.js)
 *
 * The executable lives in servers/piper, next to server.js, and finds Piper,
 * Kokoro, the catalog and installed engines where the source hub does.
 */
const path = require("path");

const [command, sub] = process.argv.slice(2);
if (command === "manifest") {
  const { PORT } = require("./config");
  const { buildManifest, installManifest } = require("./hub/n8tray");
  const program = `piper/${path.basename(process.execPath)}`;
  if (sub === "install") console.log(`N8 Tray manifest written: ${installManifest({ port: PORT, program })}`);
  else process.stdout.write(JSON.stringify(buildManifest({ port: PORT, program }), null, 2) + "\n");
} else if (command === "engines") {
  process.argv.splice(2, 1);
  require("./engines");
} else {
  require("./server").main();
}
