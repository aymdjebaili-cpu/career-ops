# Scheduler — daily-run task

Runs `node daily-run.mjs --score=3.5` every day at **10:00 local time**, on this PC.

## Files

- [daily-run.ps1](daily-run.ps1) — PowerShell wrapper that finds node, runs the orchestrator, and logs to `output/.daily-run.log`.
- [daily-run-task.xml](daily-run-task.xml) — Windows Task Scheduler definition (daily at 10:00, wakes the PC from sleep).

## Register the task (one-time)

Open **PowerShell** (not Admin needed, but Admin is fine too) and run:

```powershell
schtasks.exe /Create /XML "c:\Users\PC\Downloads\career-ops-main\career-ops-main\scheduler\daily-run-task.xml" /TN "career-ops-daily"
```

Verify:

```powershell
schtasks.exe /Query /TN "career-ops-daily" /V /FO LIST
```

## Manual test before relying on the schedule

Run the wrapper directly:

```powershell
& "c:\Users\PC\Downloads\career-ops-main\career-ops-main\scheduler\daily-run.ps1"
```

Or trigger the registered task on-demand:

```powershell
schtasks.exe /Run /TN "career-ops-daily"
```

Watch the log fill up:

```powershell
Get-Content -Path "c:\Users\PC\Downloads\career-ops-main\career-ops-main\output\.daily-run.log" -Wait -Tail 50
```

## Change the time

Edit the `<StartBoundary>` line in `daily-run-task.xml` (currently `2026-05-16T10:00:00`), then re-import:

```powershell
schtasks.exe /Delete /TN "career-ops-daily" /F
schtasks.exe /Create /XML "c:\Users\PC\Downloads\career-ops-main\career-ops-main\scheduler\daily-run-task.xml" /TN "career-ops-daily"
```

Or change it in the Task Scheduler GUI (`taskschd.msc` → `Task Scheduler Library` → `career-ops-daily`).

## Disable temporarily

```powershell
schtasks.exe /Change /TN "career-ops-daily" /DISABLE
```

Re-enable:

```powershell
schtasks.exe /Change /TN "career-ops-daily" /ENABLE
```

## Delete entirely

```powershell
schtasks.exe /Delete /TN "career-ops-daily" /F
```

## Behavior notes

- **Wake from sleep:** the task is set to wake the PC from sleep (`<WakeToRun>true</WakeToRun>`). If the PC is fully shut down at 10:00, the run is missed; `StartWhenAvailable=true` makes Windows fire it the next time the PC is on.
- **No-network handling:** if there's no network at 10:00, the task waits; `RunOnlyIfNetworkAvailable=true`.
- **One instance at a time:** if a previous run hasn't finished, a new run is skipped (`IgnoreNew`).
- **Timeout:** 1 hour hard cap (`ExecutionTimeLimit PT1H`).
- **Logs:** `output/.daily-run.log` (rotates at 1 MB → `.daily-run.log.old`).
- **Where the work lands:** new reports in `reports/`, cover letters in `output/cover-letters/`, index rows in `output/applications-index.md`, Gmail drafts in your Gmail Drafts folder (once OAuth is set up).
