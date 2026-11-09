#!/usr/bin/env node
/**
 * Installs VoiceDock's N8 Tray manifest (contract v2) for this user, so N8
 * Tray finds the hub:
 *
 *   node n8tray-manifest.js install     write <modules>/voicedock.json
 *   node n8tray-manifest.js uninstall   remove it
 *   node n8tray-manifest.js print       print it (CI checks it with n8tray-contract)
 *
 * The modules folder is %LOCALAPPDATA%\N8Tray\modules on Windows,
 * ~/Library/Application Support/N8Tray/modules on macOS and
 * ~/.local/share/n8tray/modules on Linux; N8TRAY_MODULES_DIR overrides it.
 * `npm run setup` runs install.
 */
const { PORT } = require("./config");
const { buildManifest, installManifest, uninstallManifest, modulesDir } = require("./hub/n8tray");

const command = process.argv[2] || "print";
if (command === "install") {
  console.log(`N8 Tray manifest written: ${installManifest({ port: PORT })}`);
} else if (command === "uninstall") {
  const file = uninstallManifest();
  console.log(file ? `N8 Tray manifest removed: ${file}` : `No manifest in ${modulesDir()}`);
} else if (command === "print") {
  process.stdout.write(JSON.stringify(buildManifest({ port: PORT }), null, 2) + "\n");
} else {
  console.error("Usage: node n8tray-manifest.js install | uninstall | print");
  process.exit(2);
}
