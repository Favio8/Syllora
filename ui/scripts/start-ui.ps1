param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$url = 'http://127.0.0.1:3001'
$mutex = New-Object System.Threading.Mutex($false, 'Local\SylloraUiLauncher')
$hasLock = $false

function Get-UiStatus {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200 -and $response.Content -match '<title>Syllora') { return 'ready' }
        return 'other'
    } catch { return 'waiting' }
}

function Test-UiPort {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.BeginConnect('127.0.0.1', 3001, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne(300)) { return $false }
        $client.EndConnect($connection)
        return $true
    } catch { return $false }
    finally { $client.Close() }
}

try {
    $hasLock = $mutex.WaitOne(10000)
    if (-not $hasLock) { throw 'Another launcher is running. Please try again shortly.' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json'))) {
        throw "UI project was not found: $projectRoot"
    }

    $status = Get-UiStatus
    if ($status -eq 'other') { throw 'Port 3001 is used by another application. Close that application and retry.' }

    if ($status -ne 'ready' -and -not (Test-UiPort)) {
        $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
        if (-not $node) {
            throw 'Node.js was not found on PATH. Please install Node.js 22.19 or newer.'
        }
        $next = Join-Path $projectRoot 'node_modules\next\dist\bin\next'
        if (-not (Test-Path -LiteralPath $next)) {
            $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
            if (-not $npm) { $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd' }
            if (-not (Test-Path -LiteralPath $npm)) { throw 'npm was not found.' }
            Push-Location $projectRoot
            try {
                Write-Host 'Installing UI dependencies...'
                & $npm ci --no-audit --no-fund
                if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your network and retry.' }
            } finally { Pop-Location }
        }

        $logDir = Join-Path $projectRoot '.launcher'
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        Write-Host 'Starting Syllora UI...'
        $server = Start-Process -FilePath $node -ArgumentList @(('"' + $next + '"'), 'dev', '--hostname', '127.0.0.1', '--port', '3001') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'stdout.log') -RedirectStandardError (Join-Path $logDir 'stderr.log') -PassThru
        $server.Id | Set-Content -LiteralPath (Join-Path $logDir 'server.pid') -Encoding Ascii
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ($status -ne 'ready' -and [DateTime]::UtcNow -lt $deadline) {
        if ($server -and $server.HasExited) {
            throw "The UI server stopped. See logs in $projectRoot\.launcher"
        }
        Start-Sleep -Milliseconds 600
        $status = Get-UiStatus
        if ($status -eq 'other') { throw 'Port 3001 is used by another application.' }
    }
    if ($status -ne 'ready') { throw "The UI is not ready yet. Check $projectRoot\.launcher and retry." }

    Write-Host "Syllora UI is ready: $url"
    if (-not $NoBrowser) { Start-Process $url }
    exit 0
} catch {
    Write-Host "Unable to open Syllora UI: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($hasLock) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
