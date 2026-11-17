<#
.SYNOPSIS
  Installe Aska pour l'utilisateur courant sous Windows (aucun droit administrateur requis).

.DESCRIPTION
  - installe les dépendances et télécharge Electron ;
  - crée un raccourci « Aska » dans le menu Démarrer ;
  - lance Aska en arrière-plan à l'ouverture de session (sauf -NoAutostart) ;
  - crée la commande « aska » dans %LOCALAPPDATA%\aska\bin (à ajouter au PATH si souhaité).

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
if (-not $node) { throw "Node.js (>= 20) est requis : https://nodejs.org" }
$major = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($major -lt 20) { throw "Node.js >= 20 est requis (version trouvée : $major)." }

# Dépendances, puis binaire d'Electron (Electron >= 45 ne le télécharge plus à l'installation).
$Electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
Push-Location $Root
try {
  if (-not (Test-Path (Join-Path $Root 'node_modules\electron'))) {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "npm install a échoué." }
  }
  if (-not (Test-Path $Electron)) {
    Write-Host "Téléchargement d'Electron (environ 100 Mo)…"
    & node (Join-Path $Root 'node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0) {
      throw "Le téléchargement d'Electron a échoué (accès à github.com, proxy : HTTPS_PROXY, ou miroir : ELECTRON_MIRROR)."
    }
  }
} finally {
  Pop-Location
}
if (-not (Test-Path $Electron)) { throw "Electron est introuvable après installation ($Electron)." }

# Raccourcis (menu Démarrer, démarrage automatique).
$shell = New-Object -ComObject WScript.Shell
function New-Shortcut([string]$Path, [string]$Arguments) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
  $lnk = $shell.CreateShortcut($Path)
  $lnk.TargetPath = $Electron
  $lnk.Arguments = "`"$Root`" $Arguments"
  $lnk.WorkingDirectory = $Root
  $lnk.Description = "Demander une action à un agent IA (Claude, Codex, Copilot, Cursor)"
  $lnk.IconLocation = "$Electron,0"
  $lnk.Save()
}
$programs = [Environment]::GetFolderPath('Programs')
New-Shortcut (Join-Path $programs 'Aska.lnk') '--toggle'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Aska.lnk'
if ($NoAutostart) {
  Remove-Item -Force -ErrorAction SilentlyContinue $startupLnk
} else {
  New-Shortcut $startupLnk '--hidden'
}

# Commande « aska » (aska --quit, aska --reload…).
$binDir = Join-Path $env:LOCALAPPDATA 'aska\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
# Aide et version dans le terminal ; sinon Aska est lancé sans bloquer le terminal.
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

# Configuration par défaut (n'écrase jamais une configuration existante).
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
  # UTF-8 sans BOM : sous Windows PowerShell 5.1, « Set-Content -Encoding UTF8 » en ajoute un.
  [IO.File]::WriteAllText($conf, $json, (New-Object Text.UTF8Encoding $false))
}

Write-Host ""
Write-Host "Aska est installé. Lancez-le depuis le menu Démarrer, puis Ctrl+Alt+Espace."
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $binDir })) {
  Write-Host "Pour la commande « aska » dans un terminal, ajoutez $binDir à votre PATH."
}
