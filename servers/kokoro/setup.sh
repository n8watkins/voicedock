#!/usr/bin/env bash
# One-time setup for VoiceDock's Kokoro server on macOS and Linux (setup.ps1 is
# the Windows version): install the Python packages pinned in uv.lock into
# .venv with uv, then put the Kokoro-82M v1.0 model files (338 MB) in ./models.
# Idempotent: finished steps are skipped. MODELS_FROM=<dir> copies the model
# files from a folder that already has them, when their SHA-256 matches.
set -euo pipefail
cd "$(dirname "$0")"

BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
# A function, not an associative array: macOS ships bash 3.2.
expected_sha() {
  case "$1" in
    kokoro-v1.0.onnx) echo 7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5 ;;
    voices-v1.0.bin) echo bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d ;;
  esac
}

sha_ok() { # file expected
  [ -f "$1" ] || return 1
  local got
  if command -v sha256sum >/dev/null; then got=$(sha256sum "$1" | cut -d' ' -f1); else got=$(shasum -a 256 "$1" | cut -d' ' -f1); fi
  [ "$got" = "$2" ]
}

echo "[1/3] Finding uv"
UV=$(command -v uv || true)
[ -z "$UV" ] && [ -x "$HOME/.local/bin/uv" ] && UV="$HOME/.local/bin/uv"
if [ -z "$UV" ]; then
  echo "      uv is not installed. Install it with the official installer, then run this again:" >&2
  echo "      curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi
echo "      $("$UV" --version) at $UV"

echo "[2/3] Installing Kokoro's Python packages into .venv (uv sync)"
"$UV" sync --frozen --no-dev

echo "[3/3] Model files in ./models (338 MB)"
mkdir -p models
for name in kokoro-v1.0.onnx voices-v1.0.bin; do
  dest="models/$name"
  want=$(expected_sha "$name")
  if sha_ok "$dest" "$want"; then echo "      $name: already here"; continue; fi
  if [ -n "${MODELS_FROM:-}" ] && sha_ok "$MODELS_FROM/$name" "$want"; then
    cp "$MODELS_FROM/$name" "$dest"; echo "      $name: copied from $MODELS_FROM"
  else
    echo "      $name: downloading"
    curl -fL --progress-bar -o "$dest.part" "$BASE/$name"
    mv "$dest.part" "$dest"
  fi
  if ! sha_ok "$dest" "$want"; then rm -f "$dest"; echo "      $name: checksum mismatch, removed. Run setup again." >&2; exit 1; fi
done

echo
echo "Kokoro is set up. VoiceDock starts it the first time you read with a Kokoro voice"
echo "(needs the Piper server running). Check it by hand: ./start.sh, then"
echo "curl http://127.0.0.1:7478/health"
