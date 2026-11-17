<#
.SYNOPSIS
  Installs Aska for the current user on Windows (no administrator rights required).

.DESCRIPTION
  - installs the dependencies and downloads Electron;
  - creates an "Aska" shortcut in the Start menu;
  - starts Aska in the background when you log in (unless -NoAutostart);
  - creates the "aska" command in %LOCALAPPDATA%\aska\bin (add it to PATH if you like).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
param(
  [switch]$NoAutostart
)
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# Node.js >= 20
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js (>= 20) is required: https://nodejs.org" }
$major = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 20) { throw "Node.js >= 20 is required (found version: $major)." }

# Dependencies, then the Electron binary (Electron >= 45 no longer downloads it on install).
$Electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
Push-Location $Root
try {
  if (-not (Test-Path (Join-Path $Root 'node_modules\electron'))) {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  }
  if (-not (Test-Path $Electron)) {
    Write-Host "Downloading Electron (about 100 MB)..."
    & node (Join-Path $Root 'node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0) {
      throw "Downloading Electron failed (access to github.com, proxy: HTTPS_PROXY, or mirror: ELECTRON_MIRROR)."
    }
  }
} finally {
  Pop-Location
}
if (-not (Test-Path $Electron)) { throw "Electron not found after installation ($Electron)." }

# Shortcuts (Start menu, autostart). They are written by Electron, the only one
# able to store the application identity in them, without which Windows
# does not show its notifications.
$shortcutArgs = @($Root, '--install-shortcuts')
if ($NoAutostart) { $shortcutArgs += '--no-autostart' }
$made = & $Electron @shortcutArgs | Out-String
if ($LASTEXITCODE -ne 0 -or $made -notmatch 'appUserModelId') {
  throw "Creating the shortcuts failed: $made"
}

# "aska" command (aska --quit, aska --reload...).
$binDir = Join-Path $env:LOCALAPPDATA 'aska\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
# Help and version in the terminal; otherwise Aska is started without blocking the terminal.
$launcher = @"
@echo off
for %%A in (%*) do (
  if /i "%%~A"=="--help" goto cli
  if /i "%%~A"=="-h" goto cli
  if /i "%%~A"=="--version" goto cli
  if /i "%%~A"=="-v" goto cli
)
start "" "$Electron" "$Root" %*
exit /b
:cli
node "$Root\src\cli.js" %*
"@
Set-Content -Encoding ASCII -Path (Join-Path $binDir 'aska.cmd') -Value $launcher

# Default configuration (never overwrites an existing configuration).
$confDir = Join-Path $env:APPDATA 'aska'
$conf = Join-Path $confDir 'config.json'
New-Item -ItemType Directory -Force -Path $confDir | Out-Null
if (-not (Test-Path $conf)) {
  $json = @'
{
  "shortcut": "Control+Alt+Space",
  "defaultAgent": "claude",
  "defaultMode": "read",
  "allowAutoMode": false
}
'@
  # UTF-8 without BOM: in Windows PowerShell 5.1, "Set-Content -Encoding UTF8" adds one.
  [IO.File]::WriteAllText($conf, $json, (New-Object Text.UTF8Encoding $false))
}

Write-Host ""
Write-Host "Aska is installed. Start it from the Start menu, then press Ctrl+Alt+Space."
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $binDir })) {
  Write-Host "To use the ""aska"" command in a terminal, add $binDir to your PATH."
}
