$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$statePath = Join-Path $repoRoot '.syllora-review\processes.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Host 'No review process state found.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
foreach ($entry in @(@{id=$state.tunnelPid;name='ngrok'}, @{id=$state.backendPid;name='node'}, @{id=$state.keepawakePid;name='powershell'})) {
    if (-not $entry.id) { continue }
    $process = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $command = (Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.id)").CommandLine
    if ($process.ProcessName -ne $entry.name -or (-not $command) -or ($entry.name -eq 'node' -and $command -notlike '*apps/cli/src/bin.ts*') -or ($entry.name -eq 'ngrok' -and $command -notlike "*127.0.0.1:$($state.port)*") -or ($entry.name -eq 'powershell' -and $command -notlike '*review-keepawake.ps1*')) { throw 'Process identity changed; refusing to stop an unrelated process.' }
    Stop-Process -Id $entry.id -ErrorAction Stop
}
Write-Host 'Review backend and tunnel stopped. All course data was preserved.'
