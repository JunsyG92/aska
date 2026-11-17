#!/usr/bin/env bash
# Installe Aska sur macOS pour l'utilisateur courant (aucun sudo) :
#   lanceur ~/.local/bin/aska, application ~/Applications/Aska.app (Spotlight, Launchpad),
#   démarrage automatique en arrière-plan (LaunchAgent).
# Appelé par scripts/install.sh sous macOS. Options :
#   --no-autostart     ne lance pas Aska à l'ouverture de session
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTOSTART=1
for a in "$@"; do
  case "$a" in
    --no-autostart) AUTOSTART=0 ;;
    --gnome-shortcut|--sandbox-fix|--no-sandbox-fix) ;; # options Linux, sans effet ici
    *) echo "Option inconnue : $a" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "Node.js (>= 20) est requis (brew install node)." >&2; exit 1; }
ELECTRON="$ROOT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[ -d "$ROOT/node_modules/electron" ] || (cd "$ROOT" && npm install --no-fund --no-audit)
# Electron >= 45 ne télécharge plus son binaire pendant « npm install » : on le fait ici.
if [ ! -x "$ELECTRON" ]; then
  echo "Téléchargement d'Electron (environ 100 Mo)…"
  node "$ROOT/node_modules/electron/install.js" || {
    cat >&2 <<MSG

Le téléchargement d'Electron a échoué (voir l'erreur ci-dessus). Causes fréquentes :
  - pas d'accès à github.com (réseau, proxy ou pare-feu) ;
  - proxy : exportez HTTPS_PROXY (et ELECTRON_GET_USE_PROXY=1) puis relancez ;
  - miroir : ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ ./scripts/install.sh
MSG
    exit 1
  }
fi
[ -x "$ELECTRON" ] || { echo "Electron est introuvable après installation ($ELECTRON)." >&2; exit 1; }

BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
APP="$HOME/Applications/Aska.app"
AGENT="$HOME/Library/LaunchAgents/io.github.aska.plist"
mkdir -p "$BIN"

cat > "$BIN/aska" <<LAUNCHER
#!/bin/sh
# Lanceur Aska (généré par scripts/install-macos.sh).
# Aide et version : répondues dans le terminal, sans démarrer l'interface.
for ARG in "\$@"; do
  case "\$ARG" in
    -h|--help|-v|-V|--version)
      if command -v node >/dev/null; then exec node "$ROOT/src/cli.js" "\$@"; fi
      ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$ROOT/src/cli.js" "\$@" ;;
  esac
done
exec "$ELECTRON" "$ROOT" "\$@"
LAUNCHER
chmod 755 "$BIN/aska"

# Petite application qui appelle le lanceur : Aska apparaît dans Spotlight et le Launchpad.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/MacOS/Aska" <<APPRUN
#!/bin/sh
exec "$BIN/aska" --toggle
APPRUN
chmod 755 "$APP/Contents/MacOS/Aska"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Aska</string>
  <key>CFBundleDisplayName</key><string>Aska</string>
  <key>CFBundleIdentifier</key><string>io.github.aska.launcher</string>
  <key>CFBundleExecutable</key><string>Aska</string>
  <key>CFBundleIconFile</key><string>Aska</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(node -p "require('$ROOT/package.json').version")</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
# Icône : rendu du SVG par Quick Look, puis jeu de tailles .icns (facultatif).
ICON_TMP="$(mktemp -d)"
if qlmanage -t -s 1024 -o "$ICON_TMP" "$ROOT/assets/aska.svg" >/dev/null 2>&1 && [ -f "$ICON_TMP/aska.svg.png" ]; then
  SET="$ICON_TMP/Aska.iconset"
  mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_TMP/aska.svg.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$ICON_TMP/aska.svg.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$APP/Contents/Resources/Aska.icns" 2>/dev/null || true
fi
rm -rf "$ICON_TMP"

# Démarrage à l'ouverture de session, en arrière-plan.
if [ "$AUTOSTART" = 1 ]; then
  mkdir -p "$(dirname "$AGENT")"
  cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.github.aska</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN/aska</string>
    <string>--hidden</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
else
  rm -f "$AGENT"
fi

# Configuration privée : elle décide des programmes lancés, donc 0600.
( umask 077; mkdir -p "$CONF/aska" )
chmod 700 "$CONF/aska"
if [ ! -e "$CONF/aska/config.json" ]; then
  ( umask 077; cat > "$CONF/aska/config.json" <<JSON
{
  "shortcut": "Control+Alt+Space",
  "defaultAgent": "claude",
  "defaultMode": "read",
  "allowAutoMode": false
}
JSON
  )
fi
chmod 600 "$CONF/aska/config.json"

echo
echo "Aska est installé. Lancez « aska » (ou ouvrez Aska depuis Spotlight), puis ⌃⌥Espace (Ctrl+Option+Espace)."
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Note : $BIN n'est pas dans votre PATH. Ajoutez-le : echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.zshrc" ;;
esac
