# deploy.ps1 — build and install copilot-portal into VS Code extensions folder
# After running this, just do Ctrl+Shift+P > "Reload Window" in VS Code.
#
# NOTE (decision log): We use copy-to-extensions + manual Reload Window instead
# of "Install Extension from Location" (requires dialog) or
# "code --extensionDevelopmentPath" (headless but opens a second GUI window).
# Revisit the --extensionDevelopmentPath approach if we need a fully automated
# CI-style test loop later.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$dest = "$env:USERPROFILE\.vscode\extensions\copilot-portal"

Set-Location $root

Write-Host "Building extension..." -ForegroundColor Cyan
node esbuild.js
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed" -ForegroundColor Red; exit 1 }

Write-Host "Building web UI..." -ForegroundColor Cyan
Set-Location webui
npm run build --silent
if ($LASTEXITCODE -ne 0) { Write-Host "Web UI build failed" -ForegroundColor Red; exit 1 }
Set-Location $root

Write-Host "Copying to $dest ..." -ForegroundColor Cyan
Copy-Item -Recurse -Force $root $dest

Write-Host ""
Write-Host "Done. In VS Code: Ctrl+Shift+P > Reload Window" -ForegroundColor Green
Write-Host "(Server will auto-start if copilotPortal.autoStart is true)" -ForegroundColor DarkGray
