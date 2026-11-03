$ErrorActionPreference = 'Stop'
$pluginDirectory = Split-Path -Parent $PSScriptRoot
$cliScript = Join-Path $pluginDirectory 'dist\cli.mjs'
& node $cliScript hook
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
