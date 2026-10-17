$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host 'Installing local application dependencies...'
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
Write-Host 'Starting JagaAI. Open http://127.0.0.1:5173. Ctrl+C stops it.'
& node scripts/dev.mjs
