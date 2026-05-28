# daily-run.ps1 — wrapper invoked by Windows Task Scheduler
# Runs the career-ops daily pipeline and logs to output/.daily-run.log
#
# Manual test from PowerShell:
#   .\scheduler\daily-run.ps1
#
# Registered via Task Scheduler (see scheduler/README.md or scheduler/daily-run-task.xml).

$ErrorActionPreference = 'Continue'
$ProjectDir = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectDir

$LogDir  = Join-Path $ProjectDir 'output'
$LogFile = Join-Path $LogDir '.daily-run.log'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# Rotate log if > 1 MB
if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) {
    Move-Item $LogFile "$LogFile.old" -Force
}

$Stamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
Add-Content -Path $LogFile -Value ""
Add-Content -Path $LogFile -Value "=== $Stamp ==="
Add-Content -Path $LogFile -Value "cwd: $ProjectDir"

# Find node.exe (Task Scheduler doesn't always inherit PATH)
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) {
    foreach ($p in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:LOCALAPPDATA\Volta\bin\node.exe"
    )) {
        if (Test-Path $p) { $NodeExe = $p; break }
    }
}
if (-not $NodeExe) {
    Add-Content -Path $LogFile -Value "FATAL: node not found on PATH or known locations"
    exit 127
}
Add-Content -Path $LogFile -Value "node: $NodeExe"

# Force Node.js to use Windows' system CA store (fixes "unable to verify the first certificate"
# errors when scan.mjs fetches Greenhouse/Lever/Ashby APIs from this user/session context).
# Required as of 2026-05 — the previous CA bundle behavior worked under Task Scheduler at
# 10:00 AM today but fails for manual runs in some shells. --use-system-ca is safe in both.
$env:NODE_OPTIONS = '--use-system-ca'
Add-Content -Path $LogFile -Value "NODE_OPTIONS: $env:NODE_OPTIONS"

# Run the orchestrator, capturing stdout + stderr into the log
# Capture to array to preserve stdout/display and write with UTF-8
$Output = & $NodeExe 'daily-run.mjs' '--score=3.5' 2>&1 | ForEach-Object { $_ }
$ExitCode = $LASTEXITCODE

# Write output to console and file (UTF-8 to avoid encoding issues)
$Output | ForEach-Object { Write-Host $_ }
$Output | Out-File -FilePath $LogFile -Append -Encoding utf8

$EndStamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'
Add-Content -Path $LogFile -Value "exit: $ExitCode"
Add-Content -Path $LogFile -Value "=== end $EndStamp ==="

exit $ExitCode
