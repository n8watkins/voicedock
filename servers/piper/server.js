/**
 * VoiceDock hub (and Piper server)
 *
 * The front door for every VoiceDock engine, on http://127.0.0.1:7477. The
 * extension talks only to it (docs/API.md in the repo root):
 * GET  /health                  → { status, engine: "piper", api: 2, version, rssMb, readers, ...,
 *                                   listen: "127.0.0.1:7477", exposed: false }
 * GET  /engines                 → every engine with its state, memory and cold-start figures
 * POST /tts  { text, engine?, voice? } → audio/wav from Piper (default) or
 *                                   Kokoro, which the hub starts on demand and proxies
 * GET  /engines/:id/voices      → an engine's voices (Kokoro's without starting it)
 * POST /engines/:id/warm        → start a heavy engine now, without waiting
 * POST /presence                → the extension's heartbeat (hub/engines.js)
 * GET  /hub/events              → recent engine starts, stops and refusals
 * GET  /voices                  → Piper's voices (as before)
 * /n8/v2/*                      → N8 Tray contract v2, with a token (hub/n8tray.js)
 *
 * For one release, the routes the 1.1 extension uses stay:
 * POST /engines/kokoro/start, POST /engines/kokoro/stop (local programs
 * only: the PowerShell N8 Tray's n8voice), and Kokoro keeps
 * answering on its own port 7478.
 *
 * Requires:
 *   piper/piper.exe on Windows, or piper/piper on macOS/Linux
 *   piper/voices/<model>.onnx
 *   piper/voices/<model>.onnx.json
 */

const express = require("express");
const cors    = require("cors");
const fs      = require("fs/promises");
const { createReadStream } = require("fs");
const path    = require("path");
const crypto  = require("crypto");
const { spawn } = require("child_process");
const { version } = require("./package.json");
const { serverRssMb, createReaderTracker } = require("./memory");
const { createKokoroLauncher, KOKORO_HOST, KOKORO_PORT } = require("./kokoro");
const { createHub } = require("./hub/engines");
const { createControlPlane, appVersion } = require("./hub/n8tray");

// ─── Config ───────────────────────────────────────────────────────────────────
const { PORT, HOST, isLoopbackHost, exposureWarning } = require("./config"); // shared with the tray so they agree
const MAX_CHARS  = 8000;        // reasonable limit per request
const KOKORO_MAX_CHARS = 4000;  // Kokoro's own limit
const TIMEOUT_MS = 60_000;      // kill Piper if it hangs
const MANAGED = process.argv.includes("--managed"); // started by N8 Tray

// Paths can be overridden for non-standard installs or macOS/Linux setups.
const DEFAULT_PIPER_BIN = process.platform === "win32"
  ? path.join(__dirname, "piper", "piper.exe")
  : path.join(__dirname, "piper", "piper");
const PIPER_BIN  = process.env.PIPER_BIN || DEFAULT_PIPER_BIN;
const VOICE_DIR  = process.env.VOICE_DIR || path.join(__dirname, "piper", "voices");
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, "output");

// The preferred default voice. When it isn't installed (npm run setup installs
// en_US-amy-medium), the default is the first installed voice instead, so
// "Default voice" always reads with something that is on disk.
const PREFERRED_VOICE = "en_US-ryan-high.onnx";

async function installedVoices() {
  try {
    return (await fs.readdir(VOICE_DIR)).filter(f => f.endsWith(".onnx")).sort();
  } catch (_) {
    return [];
  }
}

function defaultVoiceFrom(voices) {
  return voices.includes(PREFERRED_VOICE) ? PREFERRED_VOICE : (voices[0] || PREFERRED_VOICE);
}

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();
const readers = createReaderTracker();

// ─── Engines: the hub (hub/engines.js) ──────────────────────────────────────
// app.locals.kokoro so tests can swap in a fake launcher; the hub reaches it
// through this forwarder, so a swap applies everywhere.
app.locals.kokoro = createKokoroLauncher();
const kokoro = new Proxy({}, {
  get(_target, prop) {
    const launcher = app.locals.kokoro;
    const value = launcher[prop];
    return typeof value === "function" ? value.bind(launcher) : value;
  },
});
app.locals.hub = createHub({
  kokoro,
  readers,
  piperVoices: installedVoices,
  piperInstalled: () => require("fs").existsSync(PIPER_BIN),
});

// N8 Tray's control plane comes first: it refuses any request with an Origin,
// so it must not pass through the extension CORS below.
function stopServer(reason) {
  console.log(`[hub] stopping: ${reason}`);
  app.locals.hub.stopAll(reason);
  process.exit(0);
}
app.locals.n8 = createControlPlane({
  hub: app.locals.hub,
  kokoro,
  readers,
  onStop: (reason) => app.locals.onStop(reason),
});
app.locals.onStop = stopServer;
app.use("/n8/v2", app.locals.n8.router);

function isAllowedOrigin(origin) {
  // CLI tools and same-process scripts usually do not send Origin. Browser pages do.
  if (!origin) return true;
  return origin.startsWith("chrome-extension://");
}

function enforceAllowedOrigin(req, res, next) {
  if (isAllowedOrigin(req.get("Origin"))) {
    next();
    return;
  }
  res.status(403).json({ error: "Origin not allowed by the VoiceDock Piper server." });
}

const corsOptions = {
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"]
};
app.use(enforceAllowedOrigin);
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // explicit preflight for DELETE etc.
app.use(express.json({ limit: "1mb" }));

// ─── Health Check ─────────────────────────────────────────────────────────────
// Also reports memory, cheaply: the Node server's RSS plus the piper children
// reading right now (sampled in the background, see memory.js).
const startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

// Where the server listens, from the listening socket itself (so a test or
// embedder's own listen() is reported correctly), and whether that address is
// beyond loopback: the server has no authentication.
function listenInfo(req) {
  const address = req.socket.server?.address?.();
  const host = address && typeof address === "object" ? address.address : HOST;
  const port = address && typeof address === "object" ? address.port : PORT;
  const shown = host.includes(":") ? `[${host}]` : host;
  return { listen: `${shown}:${port}`, exposed: !isLoopbackHost(host) };
}

app.get("/health", (req, res) => {
  const memory = readers.snapshot();
  const rssMb = serverRssMb();
  res.json({
    status: "ok",
    engine: "piper",
    api: 2, // the hub: /engines lists every engine and /tts reaches each
    version,
    appVersion: appVersion(),
    managed: MANAGED,
    pid: process.pid,
    startedAt,
    rssMb,
    totalRssMb: Math.round((rssMb + memory.readerRssMb) * 10) / 10,
    ...memory,
    ...listenInfo(req),
  });
});

// ─── Engines ─────────────────────────────────────────────────────────────────
app.get("/engines", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(await app.locals.hub.list());
});

app.get("/hub/events", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ events: app.locals.hub.events() });
});

// The extension's heartbeat: on browser start, every minute (chrome.alarms),
// when the popup opens and on every read. { extensionVersion, activeEngine,
// reading }. When it stops for long enough, engines stop (hub/engines.js).
app.post("/presence", (req, res) => {
  res.json({ ok: true, presence: app.locals.hub.presence(req.get("Origin"), req.body || {}) });
});

const ERROR_STATUS = { "not-installed": 409, "low-memory": 503, failed: 503, unknown: 404 };
function engineError(res, err, name) {
  const reason = ERROR_STATUS[err.code] ? err.code : "failed";
  const error =
    reason === "not-installed" ? `${name} is not set up.` :
    reason === "low-memory"    ? `Memory is low, so ${name} does not start now.` :
    reason === "unknown"       ? "Unknown engine." :
                                 `${name} did not start.`;
  res.status(ERROR_STATUS[reason]).json({ error, reason, details: err.message });
}

app.post("/engines/:id/warm", async (req, res) => {
  const result = await app.locals.hub.warm(req.params.id);
  const status = result.outcome === "refused" ? (ERROR_STATUS[result.reason] || 409) : result.outcome === "ok" ? 202 : 200;
  res.status(status).json(result);
});

// An engine's voices. Kokoro's come from its voices file while it is
// stopped, so the extension can list them before the first read starts it.
app.get("/engines/:id/voices", async (req, res, next) => {
  const { id } = req.params;
  if (id === "piper") return listPiperVoices(req, res);
  if (id !== "kokoro") return next();
  try {
    const list = app.locals.kokoro.voices();
    if (!list) return res.status(404).json({ error: "Kokoro is not set up." });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: "Could not read Kokoro's voices.", details: err.message });
  }
});

// The 1.1 extension's routes, for one release.
app.post("/engines/kokoro/start", async (_req, res) => {
  try {
    const result = await app.locals.hub.ensure("kokoro");
    res.json({ ok: true, state: result.state, owned: app.locals.kokoro.owned?.() ?? result.owned, startedMs: result.startedMs });
  } catch (err) {
    engineError(res, err, "Kokoro");
  }
});

// The PowerShell N8 Tray's n8voice (frozen until the Tauri tray replaces it)
// stops Kokoro here, for one release. Stopping is not the data plane's
// business (contract section 9), so only a local program may: any request
// with an Origin (a web page, any extension) is refused. N8 Tray's own way is
// POST /n8/v2/actions/engine.stop, with the token.
app.post("/engines/kokoro/stop", async (req, res) => {
  if (req.get("Origin") !== undefined) {
    return res.status(403).json({ error: "Only N8 Tray stops engines." });
  }
  res.json({ ok: true, stopped: await app.locals.hub.stopEngine("kokoro", "asked by the PowerShell N8 Tray") });
});

// ─── Validation Helpers ───────────────────────────────────────────────────────
function validateText(text) {
  if (!text || typeof text !== "string") {
    return "Missing or invalid 'text' field.";
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "Text must not be empty.";
  }
  if (trimmed.length > MAX_CHARS) {
    return `Text is too long (${trimmed.length} chars). Maximum is ${MAX_CHARS}.`;
  }
  return null; // valid
}

function isSafeVoiceFilename(name) {
  return (
    typeof name === "string" &&
    name === path.basename(name) &&
    name.endsWith(".onnx") &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

async function validateVoiceFile(name) {
  if (!isSafeVoiceFilename(name)) {
    return "Voice must be a .onnx filename.";
  }

  try {
    await fs.access(path.join(VOICE_DIR, name));
  } catch (_) {
    return `Voice model not found: ${name}`;
  }

  try {
    await fs.access(path.join(VOICE_DIR, name + ".json"));
  } catch (_) {
    return `Voice config not found: ${name}.json`;
  }

  return null;
}

// ─── Piper Runner ─────────────────────────────────────────────────────────────
// C10 fix: uses a `settled` flag so the timeout handler and the `close` event
// can both run without a second reject() call on an already-settled Promise.
//
// S1 fix: Piper reads text from stdin - there is no --input-file flag.
// Passing an unrecognised flag caused Piper to silently wait for stdin forever,
// hitting our 60 s timeout on every request. Also corrected --output-file →
// --output_file (underscore) to match Piper's actual CLI.
function runPiper({ text, outputPath, voiceModel }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--model",       path.join(VOICE_DIR, voiceModel),
      "--output_file", outputPath          // underscore, not hyphen
    ];

    let proc;
    try {
      // windowsHide stops piper.exe from popping a console window on each request.
      proc = spawn(PIPER_BIN, args, { windowsHide: true });
    } catch (err) {
      return reject(new Error(`Failed to spawn Piper: ${err.message}`));
    }
    readers.add(proc, voiceModel);

    // Feed text via stdin and close the pipe so Piper knows input is complete
    proc.stdin.write(text, "utf8");
    proc.stdin.end();

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    // C10: guard flag prevents double-settle when both timeout and close fire
    let settled = false;
    const settle = (fn, ...args) => {
      if (settled) return;
      settled = true;
      fn(...args);
    };

    // Timeout guard
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      settle(reject, new Error("Piper process timed out."));
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        settle(resolve);
      } else {
        settle(reject, new Error(`Piper exited with code ${code}. Stderr: ${stderr.trim()}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      settle(reject, new Error(`Piper process error: ${err.message}`));
    });
  });
}

// ─── POST /tts ────────────────────────────────────────────────────────────────
// Kokoro: started on demand, then the request is passed to its own server.
async function kokoroTts(req, res) {
  const text = req.body?.text;
  const error = validateText(text);
  if (error) return res.status(400).json({ error });
  if (text.trim().length > KOKORO_MAX_CHARS) {
    return res.status(400).json({ error: `Text is too long (${text.trim().length} chars). Maximum is ${KOKORO_MAX_CHARS}.` });
  }
  const hub = app.locals.hub;
  hub.activity();
  try {
    await hub.ensure("kokoro");
  } catch (err) {
    return engineError(res, err, "Kokoro");
  }
  const body = { text: text.trim() };
  for (const key of ["voice", "lang"]) if (typeof req.body[key] === "string" && req.body[key].trim()) body[key] = req.body[key].trim();
  if (Number.isFinite(Number(req.body.speed))) body.speed = Number(req.body.speed);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  // The extension aborts a prefetch when the user stops: pass that on.
  res.on("close", () => { if (!res.writableFinished) ctrl.abort(); });
  hub.beginRead("kokoro");
  try {
    const upstream = await fetch(`http://${KOKORO_HOST}:${KOKORO_PORT}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const audio = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(audio);
  } catch (err) {
    if (!res.headersSent && !ctrl.signal.aborted) {
      res.status(502).json({ error: "Kokoro did not answer.", reason: "failed", details: err.message });
    } else if (!res.headersSent) {
      res.status(504).json({ error: "Kokoro took too long.", reason: "failed" });
    }
  } finally {
    clearTimeout(timer);
    hub.endRead("kokoro");
  }
}

app.post("/tts", async (req, res) => {
  const engine = req.body?.engine ?? "piper";
  if (engine === "kokoro") return kokoroTts(req, res);
  if (engine !== "piper") return res.status(400).json({ error: `Unknown engine: ${engine}` });
  app.locals.hub.activity();
  const text  = req.body?.text;
  const voice = (req.body?.voice && req.body.voice.trim()) || defaultVoiceFrom(await installedVoices());

  // Validate text
  const validationError = validateText(text);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const safeVoice = voice.trim();
  const voiceError = await validateVoiceFile(safeVoice);
  if (voiceError) {
    return res.status(400).json({ error: voiceError });
  }

  // Only the engine in use runs: a Piper read stops an idle Kokoro this
  // server started. Not awaited, so the read never waits on it.
  app.locals.kokoro.yieldTo("piper").catch(() => {});

  app.locals.hub.beginRead("piper");
  res.on("close", () => app.locals.hub.endRead("piper"));

  const cleanText  = text.trim();
  const id         = crypto.randomUUID();
  const outputPath = path.join(OUTPUT_DIR, `${id}.wav`);

  const cleanup = () => Promise.allSettled([
    fs.rm(outputPath, { force: true })
  ]);

  try {
    // Ensure output directory exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Run Piper - text is passed via stdin (S1 fix)
    await runPiper({ text: cleanText, outputPath, voiceModel: safeVoice });

    // Stream the WAV back
    // S2 fix: replaced sendFile (broken on Windows with root:"/") with a plain
    // createReadStream pipe - works on all platforms without path quirks.
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");

    const stream = createReadStream(outputPath);

    stream.on("error", async (err) => {
      console.error("[/tts] stream error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream audio file." });
      }
      await cleanup();
    });

    stream.on("close", async () => {
      await cleanup();
    });

    stream.pipe(res);

  } catch (err) {
    await cleanup();

    console.error("[/tts] Error:", err.message);

    if (res.headersSent) return;

    // Give useful errors for common setup problems
    if (err.message.includes("spawn") || err.message.includes("ENOENT")) {
      return res.status(500).json({
        error: "Piper executable not found.",
        details: `Expected at: ${PIPER_BIN}`,
        hint: "Download Piper from https://github.com/rhasspy/piper/releases and place the executable in the piper/ folder, or set PIPER_BIN."
      });
    }

    res.status(500).json({
      error: "TTS generation failed.",
      details: err.message
    });
  }
});

// ─── GET /voices  (list available voice models + sizes) ──────────────────────
app.get("/voices", (req, res) => listPiperVoices(req, res));
async function listPiperVoices(_req, res) {
  try {
    const voices = await installedVoices();

    // Stat each .onnx file for real on-disk size
    const sizes = {};
    await Promise.all(voices.map(async (f) => {
      try {
        const stat = await fs.stat(path.join(VOICE_DIR, f));
        sizes[f] = stat.size;
      } catch { sizes[f] = 0; }
    }));

    res.json({ engine: "piper", voices, defaultVoice: defaultVoiceFrom(voices), sizes, voiceDir: VOICE_DIR });
  } catch (_) {
    res.json({ engine: "piper", voices: [], defaultVoice: PREFERRED_VOICE, sizes: {}, voiceDir: VOICE_DIR });
  }
}

// ─── POST /voices/open-folder  (reveal voices directory in file manager) ──────
app.post("/voices/open-folder", (_req, res) => {
  const command =
    process.platform === "win32"  ? "explorer.exe" :
    process.platform === "darwin" ? "open" :
                                    "xdg-open";
  const child = spawn(command, [VOICE_DIR], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", (err) => {
    console.warn("[/voices/open-folder] Failed to open folder:", err.message);
  });
  child.unref();
  res.json({ ok: true });
});

// ─── DELETE /voices/:name  (remove an installed voice) ───────────────────────
app.delete("/voices/:name", async (req, res) => {
  const name = req.params.name;
  if (!isSafeVoiceFilename(name)) {
    return res.status(400).json({ error: "Voice name must end in .onnx" });
  }
  const onnxPath = path.join(VOICE_DIR, name);
  const jsonPath  = onnxPath + ".json";
  try {
    // allSettled ensures both files are always attempted regardless of whether
    // one fails, avoiding a partial delete. force:true suppresses ENOENT so a
    // missing sidecar is never an error. We then surface any real errors (e.g.
    // EPERM) explicitly rather than swallowing them as the old code did.
    const results = await Promise.allSettled([
      fs.rm(onnxPath, { force: true }),
      fs.rm(jsonPath, { force: true })
    ]);
    const errors = results
      .filter(r => r.status === "rejected")
      .map(r => r.reason?.message || String(r.reason));
    if (errors.length > 0) {
      return res.status(500).json({ error: "Delete failed: " + errors.join("; ") });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Unknown routes: JSON 404, like every other error ────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Body-parser failures (malformed JSON, oversized body) as JSON too, not the
// default HTML error page.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const error =
    err.type === "entity.parse.failed" ? "Invalid request body." :
    err.type === "entity.too.large"    ? "Request body is too large." :
                                         "Server error.";
  res.status(status).json({ error, details: err.message });
});

// ─── Startup: clean stale WAV files from a previous crashed session ───────────
async function cleanOutputDir() {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const files = await fs.readdir(OUTPUT_DIR);
    const wavs  = files.filter(f => f.endsWith(".wav"));
    await Promise.allSettled(
      wavs.map(f => fs.rm(path.join(OUTPUT_DIR, f), { force: true }))
    );
    if (wavs.length > 0) {
      console.log(`[startup] Cleaned ${wavs.length} stale WAV file(s).`);
    }
  } catch (_) {}
}

// ─── Start Server ─────────────────────────────────────────────────────────────
async function start() {
  await cleanOutputDir();
  const defaultVoice = defaultVoiceFrom(await installedVoices());
  // The token is written before the hub serves (contract v2, section 9).
  let runFolder = null;
  try {
    runFolder = app.locals.n8.prepare();
  } catch (err) {
    console.warn(`[n8tray] control plane off: ${err.message}`);
  }
  app.locals.n8.startSampling();
  app.locals.hub.start();
  return app.listen(PORT, HOST, () => {
    console.log(`\n🔊 VoiceDock hub v${version}${MANAGED ? " (started by N8 Tray)" : ""}`);
    console.log(`   Running at http://${HOST}:${PORT}`);
    console.log(`   Health:  GET  http://${HOST}:${PORT}/health`);
    console.log(`   TTS:     POST http://${HOST}:${PORT}/tts`);
    console.log(`   Voices:  GET  http://${HOST}:${PORT}/voices`);
    console.log(`\n   Piper bin: ${PIPER_BIN}`);
    console.log(`   Voice dir: ${VOICE_DIR}`);
    console.log(`   Default voice: ${defaultVoice}`);
    console.log(`   N8 Tray:   ${runFolder ? `/n8/v2 (token in ${runFolder})` : "off (no runtime folder)"}`);
    console.log(`\n   Press Ctrl+C to stop.\n`);
    const warning = exposureWarning(HOST, PORT);
    if (warning) console.warn(warning + "\n");
  });
}

// Started directly (node server.js, the tray, n8piper): listen. Required by the
// tests: export the app without listening.
if (require.main === module) {
  start();
  // Stop the Kokoro this server started with it. (Killed outright, Kokoro
  // notices its parent is gone and exits within a few seconds by itself.)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => stopServer(signal));
  }
  process.on("exit", () => app.locals.kokoro.stop());
}

module.exports = { app, isAllowedOrigin };
