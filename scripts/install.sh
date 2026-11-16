#!/usr/bin/env bash
# Installe Aska pour l'utilisateur courant (aucun sudo) :
#   lanceur ~/.local/bin/aska, entrée de menu, démarrage automatique en arrière-plan.
# Options :
#   --gnome-shortcut   enregistre Ctrl+Alt+Espace → « aska --toggle » dans GNOME (utile sous Wayland)
#   --no-autostart     ne lance pas Aska à l'ouverture de session
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GNOME=0; AUTOSTART=1
for a in "$@"; do
  case "$a" in
    --gnome-shortcut) GNOME=1 ;;
    --no-autostart) AUTOSTART=0 ;;
    *) echo "Option inconnue : $a" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "Node.js (>= 20) est requis." >&2; exit 1; }
ELECTRON="$ROOT/node_modules/electron/dist/electron"
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
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
CONF="${XDG_CONFIG_HOME:-$HOME/.config}"
mkdir -p "$BIN" "$APPS"

cat > "$BIN/aska" <<LAUNCHER
#!/bin/sh
exec "$ELECTRON" "$ROOT" "\$@"
LAUNCHER
chmod 755 "$BIN/aska"

desktop() { # $1 = fichier, $2 = arguments
  cat > "$1" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Aska
Comment=Demander une action à un agent IA (Claude, Codex, Copilot, Cursor)
Exec="$BIN/aska" $2
Icon=$ROOT/assets/aska.svg
Terminal=false
Categories=Utility;Development;
StartupNotify=false
DESKTOP
}
desktop "$APPS/aska.desktop" "--toggle"
if [ "$AUTOSTART" = 1 ]; then
  mkdir -p "$CONF/autostart"
  desktop "$CONF/autostart/aska.desktop" "--hidden"
fi

# Configuration privée : elle décide des programmes lancés, donc 0600.
( umask 077; mkdir -p "$CONF/aska" )
chmod 700 "$CONF/aska"
if [ ! -e "$CONF/aska/config.json" ]; then
  if [ "$GNOME" = 1 ]; then SHORTCUT=false; else SHORTCUT='"Control+Alt+Space"'; fi
  ( umask 077; cat > "$CONF/aska/config.json" <<JSON
{
  "shortcut": $SHORTCUT,
  "defaultAgent": "claude",
  "defaultMode": "read",
  "allowAutoMode": false
}
JSON
  )
fi
chmod 600 "$CONF/aska/config.json"

if [ "$GNOME" = 1 ]; then
  if command -v gsettings >/dev/null; then
    SCHEMA=org.gnome.settings-daemon.plugins.media-keys
    KEY=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/aska/
    LIST="$(gsettings get $SCHEMA custom-keybindings)"
    case "$LIST" in
      *"$KEY"*) ;;
      "@as []"|"[]") gsettings set $SCHEMA custom-keybindings "['$KEY']" ;;
      *) gsettings set $SCHEMA custom-keybindings "${LIST%]}, '$KEY']" ;;
    esac
    gsettings set "$SCHEMA.custom-keybinding:$KEY" name 'Aska'
    gsettings set "$SCHEMA.custom-keybinding:$KEY" command "$BIN/aska --toggle"
    gsettings set "$SCHEMA.custom-keybinding:$KEY" binding '<Control><Alt>space'
    echo "Raccourci GNOME enregistré : Ctrl+Alt+Espace"
  else
    echo "gsettings introuvable : associez « $BIN/aska --toggle » à un raccourci dans les paramètres clavier." >&2
  fi
fi

# Le bac à sable de Chromium doit rester actif : on explique comment, sans jamais le désactiver.
SANDBOX="$ROOT/node_modules/electron/dist/chrome-sandbox"
RESTRICT="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
if [ "$RESTRICT" = 1 ] && [ "$(stat -c '%U:%a' "$SANDBOX" 2>/dev/null)" != "root:4755" ]; then
  cat <<MSG

Votre système restreint les espaces de noms non privilégiés (Ubuntu 24.04+).
Pour que le bac à sable d'Electron fonctionne, lancez une fois :
  sudo chown root:root "$SANDBOX" && sudo chmod 4755 "$SANDBOX"
MSG
fi

echo
echo "Aska est installé. Lancez « aska » (ou « aska --hidden » en arrière-plan), puis Ctrl+Alt+Espace."
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Note : ajoutez $BIN à votre PATH." ;; esac
