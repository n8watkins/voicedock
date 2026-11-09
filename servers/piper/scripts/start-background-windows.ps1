$ErrorActionPreference = "Stop"

$ServerDir = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ServerDir "logs"
$LogFile = Join-Path $LogDir "voicedock-piper-background.log"
$OutLog = Join-Path $LogDir "voicedock-piper.out.log"
$ErrLog = Join-Path $LogDir "voicedock-piper.err.log"
$PidFile = Join-Path $LogDir "voicedock-piper.pid"
$WrapperPidFile = Join-Path $LogDir "voicedock-piper-wrapper.pid"
# Names before VoiceDock 1.2. A server started by a 1.1 script still has these
# pid files, so they are read (and then removed) for one release.
$LegacyPidFile = Join-Path $LogDir "piper-tts-server.pid" # legacy-name
$LegacyMutexName = "Local\PiperTtsLocalServer_Background" # legacy-name

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-ManagedLog {
  param([string]$Message, [string]$Level = "INFO")
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
  Add-Content -LiteralPath $LogFile -Value "[$timestamp] [$Level] $Message" -Encoding UTF8
}

function Test-ProcessIdRunning {
  param([int]$ProcessId)
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

$mutex = New-Object System.Threading.Mutex($false, "Local\VoiceDockPiper_Background")
if (-not $mutex.WaitOne(0)) {
  Write-ManagedLog "Another background wrapper is already running; exiting." "WARN"
  exit 0
}
$legacyMutex = $null
try {
  $legacyMutex = [System.Threading.Mutex]::OpenExisting($LegacyMutexName)
} catch {}
if ($legacyMutex) {
  $legacyMutex.Dispose()
  Write-ManagedLog "A background wrapper from VoiceDock 1.1 is still running; exiting." "WARN"
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
  exit 0
}

try {
  Set-Content -LiteralPath $WrapperPidFile -Value $PID -Encoding ASCII

  foreach ($existingPidFile in @($PidFile, $LegacyPidFile)) {
    if (-not (Test-Path $existingPidFile)) { continue }
    try {
      $existingPid = [int]((Get-Content -LiteralPath $existingPidFile -Raw).Trim())
    } catch {
      Write-ManagedLog "Existing server pid file was invalid; removing it." "WARN"
      Remove-Item -LiteralPath $existingPidFile -Force -ErrorAction SilentlyContinue
      $existingPid = 0
    }
    if ($existingPid -gt 0 -and (Test-ProcessIdRunning $existingPid)) {
      Write-ManagedLog "The VoiceDock Piper server is already running: pid=$existingPid"
      exit 0
    }
    Remove-Item -LiteralPath $existingPidFile -Force -ErrorAction SilentlyContinue
  }

  if (-not $env:HOST) { $env:HOST = "127.0.0.1" }
  if (-not $env:PORT) { $env:PORT = "7477" }
  if (-not $env:VOICE_DIR) { $env:VOICE_DIR = Join-Path $ServerDir "piper\voices" }
  if (-not $env:OUTPUT_DIR) { $env:OUTPUT_DIR = Join-Path $ServerDir "output" }
  if (-not $env:PIPER_BIN) {
    $env:PIPER_BIN = Join-Path $ServerDir "piper\piper.exe"
  }

  New-Item -ItemType Directory -Force -Path $env:VOICE_DIR, $env:OUTPUT_DIR | Out-Null

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-ManagedLog "node.exe not found in PATH. Install Node.js before starting the VoiceDock Piper server." "ERROR"
    exit 1
  }

  if (-not (Test-Path (Join-Path $ServerDir "node_modules"))) {
    Write-ManagedLog "node_modules missing; running npm install."
    $npm = Start-Process npm -ArgumentList "install" -WorkingDirectory $ServerDir -Wait -PassThru -NoNewWindow
    if ($npm.ExitCode -ne 0) {
      Write-ManagedLog "npm install failed with code $($npm.ExitCode)." "ERROR"
      exit $npm.ExitCode
    }
  }

  $serverJs = Join-Path $ServerDir "server.js"
  Write-ManagedLog "Starting the VoiceDock Piper server."
  Write-ManagedLog "  Server: $serverJs"
  Write-ManagedLog "  Host: $env:HOST"
  Write-ManagedLog "  Port: $env:PORT"
  Write-ManagedLog "  Piper: $env:PIPER_BIN"

  $server = Start-Process -FilePath $nodeCmd.Source `
    -ArgumentList "`"$serverJs`"" `
    -WorkingDirectory $ServerDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -PassThru

  Set-Content -LiteralPath $PidFile -Value $server.Id -Encoding ASCII
  Write-ManagedLog "The VoiceDock Piper server started: pid=$($server.Id)"

  $server.WaitForExit()
  Write-ManagedLog "The VoiceDock Piper server exited: code=$($server.ExitCode)"
} catch {
  Write-ManagedLog "Background wrapper failed: $($_.Exception.Message)" "ERROR"
  exit 1
} finally {
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $WrapperPidFile -Force -ErrorAction SilentlyContinue
  if ($mutex) {
    try { $mutex.ReleaseMutex() | Out-Null } catch {}
    $mutex.Dispose()
  }
}
