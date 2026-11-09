# VoiceDock on the owner's Windows PC

What runs where on the owner's PC, and how to update each part.
Checked 2026-11-09 (Kokoro moved from WSL to Windows that day).

## What is running

| What | Where |
| --- | --- |
| Chrome extension | Loaded unpacked from `C:\Users\natha\Extensions\voicedock` (VoiceDock 1.1.0) |
| Piper server | `C:\Users\natha\Projects\Tools\voicedock\servers\piper`, a clone of this repo, on `http://127.0.0.1:7477` |
| How Piper starts | N8 Tray module `n8voice` (VoiceDock), which reads `piper.path` from `C:\Users\natha\scripts\n8tray\n8voice\config\settings.json` and runs `server.js` with a named Node copy, `voicedock-piper.exe` |
| Piper binary and voices | `...\servers\piper\piper\` (`piper.exe`, DLLs, `espeak-ng-data\`, the `.onnx` voices); gitignored, they exist only there |
| Kokoro | Native on Windows: `C:\Users\natha\Projects\Tools\voicedock\servers\kokoro` (uv environment in `.venv`, models in `models\`), on `http://127.0.0.1:7478`. Not running by default: the Piper server starts it on the first Kokoro read and stops it after 30 idle minutes; its log is `servers\piper\logs\kokoro.log`. |

## Update the extension

From WSL:

```bash
cd ~/projects/extensions/voicedock
git pull
npm run deploy
```

`npm run deploy` builds the bundles and mirrors the files the store package ships into `C:\Users\natha\Extensions\voicedock`, removing any that no longer ship.
Then reload VoiceDock at `chrome://extensions`.

Chrome derives an unpacked extension's ID from its folder path, and the saved profiles belong to that ID, so keep deploying to the folder Chrome already loads.
Set `VOICEDOCK_WINDOWS_DIR` to deploy somewhere else, or `VOICEDOCK_WINDOWS_USER` for another Windows account.

## Update the Piper server

In PowerShell:

```powershell
cd C:\Users\natha\Projects\Tools\voicedock
git pull
cd servers\piper
npm ci
```

Then restart VoiceDock from N8 Tray (**Stop VoiceDock**, then **Start VoiceDock**) and check `Invoke-RestMethod http://127.0.0.1:7477/health`.

## Update Kokoro

After the `git pull` above, in PowerShell:

```powershell
cd C:\Users\natha\Projects\Tools\voicedock\servers\kokoro
powershell -ExecutionPolicy Bypass -File setup.ps1
```

It installs any changed Python packages from `uv.lock` and skips the model files it already has.
uv is at `C:\Users\natha\.local\bin\uv.exe` (installed 2026-11-09 with the official installer).

## Old folders the owner can remove

Two copies of the extension from before the rename, version 1.0.17 with the old "P" icon, are still on disk.
Nothing loads them any more: Chrome loads `C:\Users\natha\Extensions\voicedock`, and n8voice runs the server from the `voicedock` clone.

- `C:\Users\natha\Projects\Tools\piper-tts` <!-- legacy-name -->
- `C:\Users\natha\Projects\Tools\local-tts-reader`

Before removing them, check at `chrome://extensions` that no extension's **Source** points into either folder.
