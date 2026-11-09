<#
.SYNOPSIS
  Sets up VoiceDock's Kokoro server on Windows, natively (no WSL).

.DESCRIPTION
  1. Finds uv (https://docs.astral.sh/uv/). It does not install it: if uv is
     missing it prints the official install command and stops.
  2. Installs Kokoro's Python packages into .venv with `uv sync --frozen`,
     exactly the versions in uv.lock. uv uses a Python 3.10-3.13 it finds, or
     downloads one into its own folder.
  3. Puts the model files (338 MB) in .\models: copied from -ModelsFrom when
     that folder has them with the right SHA-256, otherwise downloaded.
  Safe to run again: finished steps are skipped.

  After setup the Piper server starts Kokoro when VoiceDock first reads with
  it and stops it after 30 idle minutes. To run it by hand: .\start.ps1

.PARAMETER ModelsFrom
  A folder that already has kokoro-v1.0.onnx and voices-v1.0.bin, for example
  an old WSL install: \\wsl.localhost\Ubuntu-24.04\home\<you>\voicedock\servers\kokoro\models

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File setup.ps1
#>
param([string]$ModelsFrom = "")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-Location -LiteralPath $PSScriptRoot

$Base = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
$Models = @(
    @{ Name = "kokoro-v1.0.onnx"; Sha256 = "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"; Size = "310 MB" },
    @{ Name = "voices-v1.0.bin";  Sha256 = "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"; Size = "27 MB" }
)

function Step($n, $text) { Write-Host "[$n/3] $text" -ForegroundColor Cyan }
function Test-Sha256($path, $want) {
    (Test-Path -LiteralPath $path) -and ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower() -eq $want)
}

# 1. uv
Step 1 "Finding uv"
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) {
    $candidate = Join-Path $env:USERPROFILE ".local\bin\uv.exe"
    if (Test-Path -LiteralPath $candidate) { $uv = $candidate }
}
if (-not $uv) {
    Write-Host "      uv is not installed. Install it with the official installer, then run this again:" -ForegroundColor Yellow
    Write-Host '      powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    exit 1
}
Write-Host "      $(& $uv --version) at $uv"

# 2. Python packages
Step 2 "Installing Kokoro's Python packages into .venv (uv sync)"
& $uv sync --frozen --no-dev
if ($LASTEXITCODE -ne 0) { Write-Host "      uv sync failed (exit $LASTEXITCODE)." -ForegroundColor Red; exit 1 }

# 3. Model files
Step 3 "Model files in .\models (338 MB)"
New-Item -ItemType Directory -Force -Path models | Out-Null
foreach ($m in $Models) {
    $dest = Join-Path "models" $m.Name
    if (Test-Sha256 $dest $m.Sha256) { Write-Host "      $($m.Name): already here"; continue }
    $copied = $false
    if ($ModelsFrom) {
        $src = Join-Path $ModelsFrom $m.Name
        if (Test-Sha256 $src $m.Sha256) {
            Copy-Item -LiteralPath $src -Destination $dest -Force
            $copied = $true
            Write-Host "      $($m.Name): copied from $ModelsFrom"
        } else {
            Write-Host "      $($m.Name): not found or different in $ModelsFrom, downloading instead" -ForegroundColor Yellow
        }
    }
    if (-not $copied) {
        Write-Host "      $($m.Name): downloading ($($m.Size))"
        & curl.exe -fL --progress-bar -o "$dest.part" "$Base/$($m.Name)"
        if ($LASTEXITCODE -ne 0) { Write-Host "      Download failed (exit $LASTEXITCODE)." -ForegroundColor Red; exit 1 }
        Move-Item -LiteralPath "$dest.part" -Destination $dest -Force
    }
    if (-not (Test-Sha256 $dest $m.Sha256)) {
        Remove-Item -LiteralPath $dest -Force
        Write-Host "      $($m.Name): checksum mismatch, removed. Run setup again." -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "Kokoro is set up." -ForegroundColor Green
Write-Host "VoiceDock starts it the first time you read with a Kokoro voice (needs the Piper server running)."
Write-Host "Check it by hand: .\start.ps1, then open http://127.0.0.1:7478/health"
