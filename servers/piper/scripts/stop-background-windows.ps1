$ErrorActionPreference = "Stop"

$ServerDir = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ServerDir "logs"
$LogFile = Join-Path $LogDir "voicedock-piper-background.log"
$PidFile = Join-Path $LogDir "voicedock-piper.pid"
$WrapperPidFile = Join-Path $LogDir "voicedock-piper-wrapper.pid"
# Names before VoiceDock 1.2, still stopped for one release.
$LegacyPidFile = Join-Path $LogDir "piper-tts-server.pid" # legacy-name
$LegacyWrapperPidFile = Join-Path $LogDir "piper-tts-wrapper.pid" # legacy-name

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-ManagedLog {
  param([string]$Message, [string]$Level = "INFO")
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
  Add-Content -LiteralPath $LogFile -Value "[$timestamp] [$Level] $Message" -Encoding UTF8
}

function Stop-PidFileProcess {
  param([string]$Path, [string]$Label)

  if (-not (Test-Path $Path)) {
    Write-ManagedLog "$Label pid file not found."
    return
  }

  try {
    $processId = [int]((Get-Content -LiteralPath $Path -Raw).Trim())
  } catch {
    Write-ManagedLog "$Label pid file was invalid; removing it." "WARN"
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return
  }

  $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($proc) {
    Stop-Process -Id $processId -Force
    Write-ManagedLog "Stopped $Label`: pid=$processId"
  } else {
    Write-ManagedLog "$Label was not running: pid=$processId"
  }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

Stop-PidFileProcess -Path $PidFile -Label "VoiceDock Piper server"
if (Test-Path $LegacyPidFile) { Stop-PidFileProcess -Path $LegacyPidFile -Label "VoiceDock Piper server (1.1 pid file)" }
Start-Sleep -Milliseconds 300
Stop-PidFileProcess -Path $WrapperPidFile -Label "VoiceDock Piper wrapper"
if (Test-Path $LegacyWrapperPidFile) { Stop-PidFileProcess -Path $LegacyWrapperPidFile -Label "VoiceDock Piper wrapper (1.1 pid file)" }
