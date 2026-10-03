$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$hostState = Get-Content -LiteralPath (Join-Path $repoRoot '.syllora-review\home\host.json') -Raw | ConvertFrom-Json
if (-not ($hostState.token -is [string]) -or -not $hostState.token.Trim()) { throw 'The review backend has not generated an access code. Start it first.' }
Set-Clipboard -Value $hostState.token
Write-Host 'Current review access code copied. Paste it into the review login page.'
