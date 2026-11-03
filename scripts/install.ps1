[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $repositoryRoot 'plugins\copilot-provider\dist\cli.mjs'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 or newer first.' }
if (-not (Test-Path -LiteralPath $cliPath)) { throw 'The bundled plugin is missing. From the repository run npm ci and npm run build.' }
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { throw 'Install the Codex CLI first so it can register the local plugin source.' }
& codex plugin marketplace add $repositoryRoot
if ($LASTEXITCODE -ne 0) { throw 'Could not add the plugin marketplace.' }
& codex plugin add 'copilot-provider@yishanby-copilot'
if ($LASTEXITCODE -ne 0) { throw 'Could not install the plugin. Open Plugins Directory and install it from Yishanby Copilot.' }
Write-Host 'Installed. Restart Codex, enable Copilot Provider, and run its Setup workflow.'
Write-Host 'In Settings > Hooks, review and trust the startup hook.'
