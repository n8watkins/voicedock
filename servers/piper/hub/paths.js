/**
 * Where the hub's files are, the same whether it runs from source (this file
 * is in servers/piper/hub) or as one bundled file or single executable in
 * servers/piper (where every module sees that folder as __dirname).
 */
const path = require("path");

const PIPER_DIR = path.basename(__dirname) === "hub" ? path.dirname(__dirname) : __dirname;
const SERVERS_DIR = path.dirname(PIPER_DIR);

module.exports = { PIPER_DIR, SERVERS_DIR };
