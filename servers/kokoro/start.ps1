<#
.SYNOPSIS
  Runs VoiceDock's Kokoro server in this window on 127.0.0.1:7478 (Ctrl+C stops it).

.DESCRIPTION
  You rarely need this: the Piper server starts Kokoro on demand and stops it
  after 30 idle minutes. Use it to try Kokoro by hand or read its log live.
  Run setup.ps1 once first.
#>
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    Write-Host "Kokoro is not set up yet: run setup.ps1 first." -ForegroundColor Yellow
    exit 1
}
& $python server.py
exit $LASTEXITCODE
