param(
    [string]$FrontendOrigin,
    [string]$NgrokExe = 'ngrok',
    [int]$Port = 8081,
    [switch]$BackendOnly,
    [switch]$PublicAccess
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$reviewRoot = Join-Path $repoRoot '.syllora-review'
New-Item -ItemType Directory -Path $reviewRoot -Force | Out-Null
$configPath = Join-Path $reviewRoot 'runtime.json'
if (-not $PSBoundParameters.ContainsKey('PublicAccess') -and (Test-Path -LiteralPath $configPath)) {
    $savedAccess = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $PublicAccess = $savedAccess.publicAccess -eq $true
}
if (-not $FrontendOrigin -and (Test-Path -LiteralPath $configPath)) {
    $saved = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $FrontendOrigin = $saved.frontendOrigin
    if ($NgrokExe -eq 'ngrok' -and $saved.ngrokExe) { $NgrokExe = $saved.ngrokExe }
}
if ($FrontendOrigin) {
    $originUri = [Uri]$FrontendOrigin
    if ($originUri.Scheme -ne 'https' -or $originUri.AbsolutePath -ne '/' -or $originUri.Query -or $originUri.Fragment -or $originUri.UserInfo) { throw 'FrontendOrigin must be an HTTPS origin' }
    $FrontendOrigin = $originUri.GetLeftPart([UriPartial]::Authority)
}
$statePath = Join-Path $reviewRoot 'processes.json'
if (Test-Path -LiteralPath $statePath) {
    $oldState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($oldState.backendPid -and (Get-Process -Id $oldState.backendPid -ErrorAction SilentlyContinue)) { throw 'Review backend is running. Run review-stop.ps1 before restarting.' }
}
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$env:SYLLORA_REVIEW_MODE = '1'
$env:SYLLORA_REVIEW_ROOT = $reviewRoot
$env:SYLLORA_REVIEW_PUBLIC = if ($PublicAccess) { '1' } else { '0' }
$env:SYLLORA_ALLOWED_ORIGINS = $FrontendOrigin
$env:TSX_TSCONFIG_PATH = Join-Path $repoRoot 'tsconfig.base.json'
$backend = Start-Process -FilePath $nodeExe -ArgumentList @('--import', 'tsx', 'apps/cli/src/bin.ts', 'serve', '--port', "$Port") -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $reviewRoot 'backend.stdout.log') -RedirectStandardError (Join-Path $reviewRoot 'backend.stderr.log') -PassThru
$state = @{ backendPid = $backend.Id; tunnelPid = $null; keepawakePid = $null; port = $Port; frontendOrigin = $FrontendOrigin; publicAccess = [bool]$PublicAccess; startedAt = [DateTimeOffset]::Now.ToString('o') }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
try {
    $hostFile = Join-Path $reviewRoot 'home\host.json'
    $ready = $false
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if ($backend.HasExited) { throw 'Backend startup failed. Inspect .syllora-review/backend.stderr.log.' }
        if (Test-Path -LiteralPath $hostFile) {
            try {
                $hostState = Get-Content -LiteralPath $hostFile -Raw | ConvertFrom-Json
                if ($hostState.pid -eq $backend.Id) {
                    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 | Out-Null
                    $ready = $true
                    break
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Backend did not become ready within 30 seconds.' }
    $keepawake = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $PSScriptRoot 'review-keepawake.ps1') + '"')) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $reviewRoot 'keepawake.stdout.log') -RedirectStandardError (Join-Path $reviewRoot 'keepawake.stderr.log') -PassThru
    $state.keepawakePid = $keepawake.Id
    $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
    if (-not $BackendOnly) {
        $resolvedNgrok = (Get-Command $NgrokExe -ErrorAction Stop).Source
        & $resolvedNgrok config check | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Configure the ngrok authtoken first.' }
        $tunnel = Start-Process -FilePath $resolvedNgrok -ArgumentList @('http', "http://127.0.0.1:$Port", '--log', 'stdout', '--log-format', 'json', '--inspect=false') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $reviewRoot 'tunnel.stdout.log') -RedirectStandardError (Join-Path $reviewRoot 'tunnel.stderr.log') -PassThru
        $state.tunnelPid = $tunnel.Id
        $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
        $publicUrl = $null
        for ($attempt = 0; $attempt -lt 100; $attempt++) {
            if ($tunnel.HasExited) { throw 'Tunnel startup failed. Inspect .syllora-review/tunnel.stderr.log.' }
            try {
                $tunnels = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2
                $publicUrl = ($tunnels.tunnels | Where-Object { $_.public_url -like 'https://*' -and $_.config.addr -eq "http://127.0.0.1:$Port" } | Select-Object -First 1).public_url
                if ($publicUrl) { break }
            } catch { }
            Start-Sleep -Milliseconds 300
        }
        if (-not $publicUrl) { throw 'Tunnel did not become ready within 30 seconds.' }
        @{ frontendOrigin = $FrontendOrigin; apiUrl = $publicUrl; ngrokExe = $resolvedNgrok; port = $Port; publicAccess = [bool]$PublicAccess } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
        Write-Host "Review API: $publicUrl"
    }
    Write-Host "Backend ready: http://127.0.0.1:$Port"
    if ($PublicAccess) { Write-Host 'Public review: no access code is required, including supplier management.' }
    else { Write-Host 'The access code is stored locally in .syllora-review/home/host.json (token). Do not publish this file.' }
    Write-Host 'Keep this computer awake and online during review.'
} catch {
    if ($state.tunnelPid) { Stop-Process -Id $state.tunnelPid -ErrorAction SilentlyContinue }
    if ($state.keepawakePid) { Stop-Process -Id $state.keepawakePid -ErrorAction SilentlyContinue }
    Stop-Process -Id $backend.Id -ErrorAction SilentlyContinue
    throw
}
