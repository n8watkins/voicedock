# VoiceDock engine API

VoiceDock's engines sit behind one local server, the **hub**, on `http://127.0.0.1:7477`.
The extension talks only to the hub: it lists every engine and its state (`GET /engines`), and every read goes to the hub's `POST /tts`, which reads with Piper itself or starts Kokoro on demand and passes the request on.
So a new engine never needs a new host permission in the extension.

| Server | Code | Default address | Runs on |
| --- | --- | --- | --- |
| Hub and Piper | `servers/piper` (Node.js, Express, `piper.exe` per read) | `http://127.0.0.1:7477` | Windows, macOS, Linux |
| Kokoro | `servers/kokoro` (Python, stdlib `http.server`, `kokoro-onnx`), started by the hub | `http://127.0.0.1:7478` | Windows, macOS, Linux (uv) |

Kokoro's own port keeps answering for one release, for the 1.1 extension, which reads from it directly.

Override the port with `PORT` / `HOST` (Piper) or `KOKORO_PORT` / `KOKORO_HOST` (Kokoro).
The extension expects the defaults.

## Conventions

- **Loopback only.** Both servers bind `127.0.0.1` by default, never `0.0.0.0`.
  They have no authentication, so a non-loopback `HOST` / `KOKORO_HOST` logs a warning at startup and `/health` reports `"exposed": true`.
- **Origin check.** A request with no `Origin` header (curl, scripts, native apps) or with a `chrome-extension://` origin is allowed.
  Any other browser origin gets `403` on every route, including the `OPTIONS` preflight, so a web page can't use your local engine.
- **CORS.** For an allowed extension origin the server echoes it in `Access-Control-Allow-Origin` (with `Vary: Origin`).
  Preflight answers allow `GET, POST, OPTIONS` (Piper also allows `DELETE`) and the `Content-Type` header.
  The extension lists the hub's address in `host_permissions`, so it works even with an older server that sends no CORS headers.
- **JSON everywhere except audio.** Every response that isn't audio is JSON, including errors and unknown routes.
- **Body limit.** Request bodies are limited to 1 MB.

## `GET /health`

`200` when the server is up and ready to synthesize (Kokoro may still need to load its model on the next `/tts`).

```json
{
  "status": "ok", "engine": "piper", "version": "1.0.0", "pid": 5120,
  "startedAt": "2026-11-02T18:00:00Z", "rssMb": 22.4, "totalRssMb": 108.6,
  "speaking": true, "readers": [{ "pid": 7788, "voice": "en_US-ryan-high.onnx", "rssMb": 86.2 }],
  "readerRssMb": 86.2, "activeVoice": "en_US-ryan-high.onnx",
  "lastVoice": "en_US-ryan-high.onnx", "lastSpeakAt": "2026-11-02T18:05:19Z", "lastReaderPeakRssMb": 91.0,
  "listen": "127.0.0.1:7477", "exposed": false
}
```

```json
{
  "status": "ok", "engine": "kokoro", "version": "1.1.0", "voices": 54,
  "modelLoaded": false, "modelLoading": false, "speaking": false, "rssMb": 46.9, "pid": 4242,
  "startedAt": "2026-11-02T18:00:00Z", "modelLoadedAt": "2026-11-02T18:05:12Z",
  "modelUnloadedAt": "2026-11-02T18:15:20Z", "lastSpeakAt": "2026-11-02T18:05:19Z",
  "idleSeconds": 640, "idleUnloadSeconds": 600, "idleExitSeconds": 1800,
  "listen": "127.0.0.1:7478", "exposed": false
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `status` | `"ok"` | Always `"ok"` on `200`. |
| `engine` | `"piper"` or `"kokoro"` | Which engine answered. |
| `version` | string | The server's own version (the servers are versioned separately from the extension). |
| `pid`, `startedAt` | number, ISO 8601 UTC string | The server's process id and when it started. |
| `rssMb` | number or null | The server process's resident memory in MB. For Piper this is the Node server alone; for Kokoro it includes the model when loaded (the working set on Windows; null when neither psutil nor Linux's /proc is available). |
| `speaking` | boolean | A `/tts` request is being synthesized right now. Kokoro runs one synthesis at a time, so for Kokoro this also covers requests waiting their turn. |
| `lastSpeakAt` | ISO 8601 UTC string or null | When the last `/tts` synthesis started (`null`: none since start). |
| `voices` | number | Kokoro only: how many voices are available. |
| `modelLoaded` | boolean | Kokoro only: whether the model is in memory right now. `false` is normal: the model loads on the first `/tts` request (adding 1-3 s to it) and is released after an idle period. Checking `/health` never loads it. |
| `modelLoading` | boolean | Kokoro only: the model is being loaded right now (the first `/tts` after a release). `/health` keeps answering while it loads. |
| `modelLoadedAt`, `modelUnloadedAt` | ISO 8601 UTC string or null | Kokoro only: when the model was last loaded and released (`null`: not since start). |
| `idleSeconds` | number | Kokoro only: seconds since the last `/tts` finished (since start if none; `0` while speaking). |
| `idleUnloadSeconds` | number | Kokoro only: the configured idle period before the model is released (`0` = never). |
| `readers` | array | Piper only: the `piper` processes reading right now, each `{ pid, voice, rssMb }`. Piper starts one per chunk; it loads the voice (60-150 MB) and exits when the chunk is done. `rssMb` is sampled in the background about once a second, so it is `null` for the first quarter second. |
| `readerRssMb`, `totalRssMb` | number | Piper only: the readers' memory summed, and the server plus the readers. |
| `activeVoice`, `lastVoice` | string or null | Piper only: the voice being read now (the newest reader), and the last voice read. |
| `listen` | string | The address and port the server listens on, for example `127.0.0.1:7477`. |
| `exposed` | boolean | `true` when the server listens beyond loopback (anything other than `127.0.0.0/8`, `::1` or `localhost`). The servers have no authentication, so anything that can reach the address can use them. |
| `lastReaderPeakRssMb` | number or null | Piper only: the highest memory the last finished reader reached, so a short read still shows what it cost. |

All of these are cheap to compute, so trays can poll `/health` for live memory without loading anything.
Servers older than these fields answer with only `status`, `engine` and `version` (plus `voices` for Kokoro), so clients treat every other field as optional.

Clients should treat any non-`200` response, a timeout (the extension uses 2.5 s), or a connection error as "offline".

## `GET /voices`

```json
{
  "engine": "piper",
  "voices": ["en_US-amy-medium.onnx", "en_US-ryan-high.onnx"],
  "defaultVoice": "en_US-ryan-high.onnx",
  "sizes": { "en_US-amy-medium.onnx": 63201294 },
  "voiceDir": "C:\\...\\servers\\piper\\piper\\voices"
}
```

```json
{ "engine": "kokoro", "voices": ["af_alloy", "af_heart", "bm_george"], "defaultVoice": "af_heart" }
```

| Field | Type | Notes |
| --- | --- | --- |
| `engine` | string | Which engine answered. |
| `voices` | string[] | Voice ids to pass as `voice` to `/tts`. Piper ids are `.onnx` filenames; Kokoro ids look like `af_heart` (language letter, gender letter, name). |
| `defaultVoice` | string | The voice `/tts` uses when `voice` is omitted. For Piper it may not be installed. |
| `sizes`, `voiceDir` | object, string | Piper only: file sizes in bytes and the folder that holds the voices. |

## `POST /tts`

Request body (JSON):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | yes | Trimmed; must not be empty. Piper accepts up to 8000 characters, Kokoro up to 4000. The extension sends chunks of at most 350. |
| `voice` | string | no | A voice id from `/voices`. Defaults to `defaultVoice`. |
| `speed` | number | no | Kokoro only, clamped to 0.5-2.0. The extension leaves it out and changes speed during playback instead, so the live speed control works the same for both engines. |
| `lang` | string | no | Kokoro only. Defaults to the voice's language (from its first letter). |

Success: `200` with `Content-Type: audio/wav` and the WAV bytes (Piper: the voice's native rate, usually 22.05 kHz; Kokoro: 16-bit PCM, 24 kHz mono).
Responses are `Cache-Control: no-store`.

## Errors

```json
{ "error": "Voice not found: zz_nobody" }
```

```json
{ "error": "TTS generation failed.", "details": "Piper exited with code 1. Stderr: ..." }
```

| Field | Type | Notes |
| --- | --- | --- |
| `error` | string | One human-readable sentence, safe to show to a user. |
| `details` | string | Optional: the underlying cause, for logs. |
| `hint` | string | Optional (Piper): what to do about a setup problem, such as a missing `piper.exe`. |

| Status | When |
| --- | --- |
| `400` | Invalid body, empty or too-long text, unknown or unsafe voice. |
| `403` | The request's `Origin` is not allowed. |
| `404` | Unknown route (`{"error":"Not found."}`). |
| `413` | Body over 1 MB. |
| `500` | Synthesis failed, or the engine binary or model is missing. |

## Piper-only routes

These manage installed voice files and are used by the extension's Voices tab.
Kokoro's voices live in a single bundled file, so it has no equivalents.

| Method | Path | Does |
| --- | --- | --- |
| `DELETE` | `/voices/:name` | Deletes `name` (a `.onnx` filename) and its `.onnx.json` config. |
| `POST` | `/voices/open-folder` | Opens the voices folder in the OS file manager. |

## The hub: engines

The hub decides when each engine runs (`servers/piper/hub/engines.js`):

- **On demand.** No engine process runs at hub start. A Kokoro read, or `POST /engines/kokoro/warm` when the popup opens on a Kokoro profile, starts Kokoro.
- **One heavy engine at a time.** Starting one stops the others once they are not speaking. Piper has no resident process (one `piper` per read), and a Piper read stops an idle Kokoro the hub started.
- **Unload, then stop.** Kokoro releases its model after 10 idle minutes (`KOKORO_IDLE_UNLOAD_SECONDS`) and exits after 30 (`KOKORO_STOP_AFTER_SECONDS`).
- **No browser, no engines.** Once the extension has sent a heartbeat, 5 minutes without one (`VOICEDOCK_NO_CLIENT_STOP_SECONDS`) stop every engine that is not speaking.
- **Crashes.** A crashed Kokoro starts again on the next read, after 1, 2, 4 ... 60 s when it keeps crashing, and is `failed` after 5 crashes in 10 minutes until it is started by hand.
- **Memory pressure** (pushed by N8 Tray): `attention` releases idle models and refuses warm-ups; `problem` stops engines that are not speaking and refuses to start Kokoro (`503`, `"reason": "low-memory"`).

Same origin rule as every route.

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/engines` | `{ api: 2, pressure, presence, policy, engines: [...] }`. Each engine: `id`, `name`, `heavy`, `state`, `installed`, `running`, `startsOnDemand`, `speaking`, `voices`, `rssMb`, `detail` (one line for people), `setup` (what is missing, or null), `coldStart` (`estimateMs` to first audio, `budgetMs`, and Kokoro's measured `processMs` and `modelLoadMs`). Kokoro also has `owned`, `pid`, `modelLoaded`, `lastError` and `stopsInSeconds`. |
| `POST` | `/tts` | As above, plus `engine`: `"piper"` (default) or `"kokoro"`. A Kokoro read starts Kokoro if needed and waits for it. `409` with `"reason": "not-installed"`, `503` with `"reason": "low-memory"` or `"failed"`. |
| `POST` | `/engines/:id/warm` | Starts a heavy engine without waiting: `202 {"outcome": "ok", "state": "starting", "expectedMs"}`, `200 {"outcome": "already"}`, or `409`/`503` with `"outcome": "refused"` and a `reason`. |
| `GET` | `/engines/:id/voices` | An engine's voices. Kokoro's come from its voices file, so this never starts it; `404` when it isn't set up. |
| `POST` | `/presence` | The extension's heartbeat: `{ "extensionVersion", "activeEngine", "reading" }`. Sent on browser start, every minute, when the popup opens and on every read. |
| `GET` | `/hub/events` | The last 100 engine events: starts with their time to ready, stops with the reason, refusals, pressure changes. |
| `POST` | `/engines/kokoro/start`, `/engines/kokoro/stop` | The 1.1 extension's routes, kept for one release. |

| `state` | Means | The extension shows |
| --- | --- | --- |
| `ready` | Can read now (Kokoro: running with its model loaded) | Ready |
| `idle` | Set up and not running, or running with its model released: starts on the next read | Starts when you read |
| `starting` | Starting, or loading its model | Starting |
| `stopped` | Set up, but kept off for now (low memory) | Installed but not running |
| `failed` | Keeps crashing; `detail` says why | Installed but not running |
| `not-installed`, `needs-setup` | Not set up, or partly (`setup` says what is missing) | Not installed |

## N8 Tray: contract v2

The hub follows the [N8 Tray contract v2](https://github.com/n8watkins/n8tray/blob/v0.1.0/spec/contract-v2.md), so N8 Tray can start, stop and measure it (`servers/piper/hub/n8tray.js`):

- **Manifest.** `node servers/piper/n8tray-manifest.js install` writes `voicedock.json` to the per-user modules folder (`%LOCALAPPDATA%\N8Tray\modules` on Windows); `npm run setup` runs it.
- **Token.** At every start the hub writes 64 random hex characters to `voicedock.token` in N8 Tray's runtime folder (`%LOCALAPPDATA%\N8Tray\run`), readable by this user only.
- **Control plane.** `GET /n8/v2/status` (state, a component per engine, the extension's presence, and the memory, CPU and start time of every process the hub owns: itself, Kokoro and its venv launcher, the Piper readers), `POST /n8/v2/actions/stop`, `engine.start` and `engine.stop` (with `"component"`), and `POST /n8/v2/pressure`.
  Every request needs `Authorization: Bearer <token>`; a request with any `Origin`, or a `Host` other than `127.0.0.1` or `localhost` with this port, gets `403`.

CI runs the contract's conformance kit (`n8tray-contract check` and `probe`) against the hub on every pull request.

## Tests

- `test/piper-server.test.mjs`: Piper routes, error shapes, the origin check and the memory fields while a (fake) `piper` reads (no `piper.exe` needed).
- `test/piper-memory.test.mjs`: Piper reader tracking and memory sampling.
- `test/kokoro-launcher.test.mjs`: Kokoro on demand (start, shared starts, stop, a Piper read stopping it) and the 1.1 routes, with a fake process.
- `test/hub.test.mjs`: the engine policy (on demand, no-heartbeat stop, pressure, crashes), the N8 Tray control plane and Kokoro reads through the hub.
- `servers/kokoro/tests/test_server.py`: Kokoro routes, error shapes, the origin check and CORS, with a fake engine (no model needed).

`npm test` runs both.
