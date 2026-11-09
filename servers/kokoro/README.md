# VoiceDock Kokoro server

A small local [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) text-to-speech server backed by [`kokoro-onnx`](https://github.com/thewh1teagle/kokoro-onnx).
It is one of the two VoiceDock engines: the extension can read with Piper (`servers/piper`, port 7477) or Kokoro (this server, port 7478), chosen per profile.

**Kokoro is optional.**
Piper is the light default and the browser voice is the zero-setup fallback, so set Kokoro up only if you want its voices:

- **Download:** 338 MB, once (`kokoro-v1.0.onnx` 310 MB and `voices-v1.0.bin` 27 MB), plus about 180 MB of Python packages.
- **Memory:** about 500-600 MB of RAM while it reads, about 80 MB once the model is released after 10 idle minutes, and none once it stops after 30 (see [Memory](#memory-the-model-loads-on-demand)).
- **Needs:** [uv](https://docs.astral.sh/uv/), on Windows, macOS or Linux. uv uses a Python 3.10-3.13 it finds, or downloads one.

Kokoro sounds more natural than Piper and ships 54 voices in 9 languages, at a small latency cost (on the owner's Windows PC, about 0.85 s warm for one sentence versus 0.6 s for Piper).

It speaks the shared VoiceDock API described in [`docs/API.md`](../../docs/API.md).

## History

This folder was moved in from the standalone `n8watkins/kokoro-tts` repo with `git subtree`, so its earlier commits are kept.
List them with `git log --oneline <import merge>^2`, where the import merge is the commit "build: import the Kokoro server with its history into servers/kokoro".

## Ports and origins

- Piper server: `127.0.0.1:7477`
- Kokoro server (this): `127.0.0.1:7478`

The server binds `127.0.0.1` only (loopback), never `0.0.0.0`.
It has no authentication, so a non-loopback `KOKORO_HOST` logs a warning at startup and `/health` reports `"exposed": true`.

Like the Piper server, it only answers requests that either have no `Origin` header (curl, scripts, native apps) or come from a `chrome-extension://` origin.
Any other browser origin gets `403`, so a web page you visit can't drive your local engine.
Allowed extension origins get CORS headers, including on the `OPTIONS` preflight.

## API

| Method | Path      | Body                                          | Returns                                                |
| ------ | --------- | --------------------------------------------- | ------------------------------------------------------ |
| GET    | `/health` | -                                             | `{"status":"ok","engine":"kokoro","version":"1.1.0","voices":54,"modelLoaded":false}` |
| GET    | `/voices` | -                                             | `{"engine":"kokoro","voices":[...],"defaultVoice":"af_heart"}` |
| POST   | `/tts`    | `{"text":"...","voice":"af_heart","speed":1}` | `audio/wav` (16-bit PCM, 24 kHz mono)                  |

`voice` defaults to `af_heart`.
`speed` is clamped to 0.5-2.0 (the extension leaves it at 1 and changes speed during playback instead).
`lang` is optional: by default it follows the voice's first letter (`a` American English, `b` British English, `e` Spanish, `f` French, `h` Hindi, `i` Italian, `j` Japanese, `p` Brazilian Portuguese, `z` Mandarin).

Errors are JSON `{"error": "...", "details": "..."}` with a 4xx or 5xx status.

## Setup (one time)

Windows, in PowerShell from this folder:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"   # uv, if `uv --version` fails
powershell -ExecutionPolicy Bypass -File setup.ps1
```

macOS and Linux:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # uv, if `uv --version` fails
./setup.sh
```

Both scripts do the same three steps and print them as they go:

1. Find uv. They never install it: without uv they print the command above and stop.
2. `uv sync --frozen`: the packages pinned in `uv.lock` (`kokoro-onnx`, `onnxruntime`, `numpy`, `psutil`) into `.venv`.
3. The Kokoro-82M v1.0 model files into `./models`, checked against their SHA-256.
   `setup.ps1 -ModelsFrom <folder>` (or `MODELS_FROM=<folder> ./setup.sh`) copies them from a folder that already has them, such as an old WSL install, instead of downloading.

They end with `Kokoro is set up.` and are safe to run again.

## Run: on demand, through the Piper server

You don't start Kokoro yourself.
The Piper server (`servers/piper`, always on while VoiceDock is) starts it when the extension first reads with a Kokoro voice, and it stops on its own:

- **Start:** the extension calls `POST /engines/kokoro/start` on the Piper server, which runs `.venv`'s Python with `server.py` and answers once `/health` does (about 0.3-0.6 s; the extension says "Starting Kokoro" meanwhile). Opening the popup on a Kokoro profile starts it too, so the read that follows doesn't wait.
- **Unload:** after 10 minutes without a read, Kokoro releases its model (`KOKORO_IDLE_UNLOAD_SECONDS`, default 600).
- **Stop:** after 30 minutes without a read (`KOKORO_STOP_AFTER_SECONDS` on the Piper server, default 1800), when Piper reads (only the engine in use runs), or when the Piper server stops. Kokoro gets the Piper server's process id and exits within 5 s of it going away, even if it was killed.
- **Status:** the Piper server's `GET /engines` reports Kokoro's state (`not-installed`, `stopped`, `starting`, `ready`), and `GET /engines/kokoro/voices` lists its voices without starting it. Its log is `servers/piper/logs/kokoro.log`.

A Kokoro started some other way (by hand, a systemd unit) is used as is and never stopped by the Piper server.

### By hand

```powershell
.\start.ps1          # Windows
```

```bash
./start.sh           # macOS, Linux
```

Serves on `127.0.0.1:7478` in the foreground, without loading the model, and stays up until you stop it (Ctrl+C).
Override with `KOKORO_HOST` / `KOKORO_PORT`, and point at model files elsewhere with `KOKORO_MODELS_DIR`.
`KOKORO_IDLE_EXIT_SECONDS` makes it exit after that long without a read, and `KOKORO_PARENT_PID` makes it exit when that process is gone (the Piper server sets both).

### Memory: the model loads on demand

The model only sits in memory while it is being used:

- The first `/tts` request loads it, which adds about 1-1.5 s to that request.
- After `KOKORO_IDLE_UNLOAD_SECONDS` without a `/tts` request (default `600`, 10 minutes), it is released again.
  Set it to `0` to keep the model loaded once it has loaded.
- `/health` and `/voices` never load it: voice names come from the voices file's index.
- `/health` reports the memory state for trays and monitors: `modelLoaded`, `speaking`, `rssMb` (the process's resident memory, the working set on Windows), when the model was last loaded and released, the last request and the idle seconds (see [`docs/API.md`](../../docs/API.md#get-health)).
- numpy's OpenBLAS is limited to one thread (`OPENBLAS_NUM_THREADS=1`): with a thread per CPU it commits about 480 MB more private memory on an 8-core PC, for no speed gain here.

Measured on the owner's Windows 11 PC (8 cores, Python 3.13), resident memory of the server process (on Windows the venv's `python.exe` is a 4 MB launcher with the server as its child):

| State | Memory |
| --- | --- |
| Started, model not loaded yet | about 27 MB |
| Model loaded, while reading | about 510-625 MB |
| After the idle release | about 76 MB |
| After the idle stop | none |

Speed there: Kokoro starts in 0.3-0.6 s, the first read loads the model in 1-1.5 s, and a warm one-sentence read takes about 0.85 s.

## Linux: a systemd user service (optional)

To keep Kokoro always on instead of on demand, install it as a systemd user service.
It starts the server at login and restarts it on any exit, and journald captures the logs.

```bash
./install-service.sh
```

The script writes `~/.config/systemd/user/kokoro-tts.service` (from the template in `systemd/`, with this folder's path substituted), enables and starts it, and turns on user lingering so it survives logout.

```bash
journalctl --user -u kokoro-tts.service -f          # logs
systemctl --user restart kokoro-tts.service         # restart
systemctl --user disable --now kokoro-tts.service   # remove
```

To change the idle period for the service, add an override:

```bash
systemctl --user edit kokoro-tts.service
# [Service]
# Environment=KOKORO_IDLE_UNLOAD_SECONDS=1800
systemctl --user restart kokoro-tts.service
```

> The service binds `127.0.0.1:7478`.
> If an instance is already running there, stop it first or the new one will fail to bind.
> The install script checks `/health` and refuses to proceed if the port is already served.

## Tests

The HTTP layer (routes, error shapes, origin check, CORS) and the on-demand loading and idle release are tested with fakes and need only the Python standard library:

```bash
python3 -m unittest discover -s servers/kokoro/tests   # from the repo root
```

`npm test` at the repo root runs these too.

## Verify a running server

```bash
curl -s http://127.0.0.1:7478/health   # "modelLoaded": false until the first /tts
curl -s http://127.0.0.1:7478/voices | python3 -m json.tool | head
curl -s -X POST http://127.0.0.1:7478/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"Kokoro voice check","voice":"af_heart"}' -o /tmp/kokoro.wav
file /tmp/kokoro.wav   # -> RIFF WAVE audio, 16 bit, mono 24000 Hz
curl -s -o /dev/null -w '%{http_code}\n' -H 'Origin: https://example.com' http://127.0.0.1:7478/health   # -> 403
```

## Voices

54 voices across 9 languages, named by language and gender, for example American female `af_heart` (default) and `af_bella`, American male `am_adam`, British `bf_emma` and `bm_george`, plus Spanish, French, Hindi, Italian, Japanese, Portuguese and Mandarin sets.
Enumerate the live list from `GET /voices`.
