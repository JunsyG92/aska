#!/usr/bin/env bash
# Installe Aska pour l'utilisateur courant (aucun sudo) :
#   lanceur ~/.local/bin/aska, entrée de menu, démarrage automatique en arrière-plan.
# Options :
#   --gnome-shortcut   enregistre Ctrl+Alt+Espace → « aska --toggle » dans GNOME (utile sous Wayland)
#   --no-autostart     ne lance pas Aska à l'ouverture de session
#   --sandbox-fix      (Ubuntu 24.04+) installe sans demander le profil AppArmor du bac à sable
#   --no-sandbox-fix   ne touche pas au système : la commande à lancer est seulement affichée
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# macOS : installation dédiée (Electron.app, LaunchAgent, Aska.app).
[ "$(uname -s)" = Darwin ] && exec "$ROOT/scripts/install-macos.sh" "$@"
GNOME=0; AUTOSTART=1; SANDBOX_FIX=ask
for a in "$@"; do
  case "$a" in
    --gnome-shortcut) GNOME=1 ;;
    --no-autostart) AUTOSTART=0 ;;
    --sandbox-fix) SANDBOX_FIX=yes ;;
    --no-sandbox-fix) SANDBOX_FIX=no ;;
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
# Lanceur Aska (généré par scripts/install.sh).
# Aide et version : répondues dans le terminal, sans démarrer l'interface.
for ARG in "\$@"; do
  case "\$ARG" in
    -h|--help|-v|-V|--version)
      if command -v node >/dev/null; then exec node "$ROOT/src/cli.js" "\$@"; fi
      ELECTRON_RUN_AS_NODE=1 exec "$ELECTRON" "$ROOT/src/cli.js" "\$@" ;;
  esac
done
SANDBOX="$ROOT/node_modules/electron/dist/chrome-sandbox"
# Ubuntu 24.04+ : sans profil AppArmor ni assistant setuid, Electron s'arrête
# brutalement (SIGTRAP). On l'explique plutôt que de planter en silence.
if [ "\$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] \\
   && [ ! -e /etc/apparmor.d/aska ] \\
   && [ "\$(stat -c '%U:%a' "\$SANDBOX" 2>/dev/null)" != "root:4755" ]; then
  MSG="Le bac à sable d'Electron n'est pas configuré sur ce système. Relancez : $ROOT/scripts/install.sh --sandbox-fix"
  echo "\$MSG" >&2
  command -v notify-send >/dev/null && notify-send "Aska ne peut pas démarrer" "\$MSG"
  exit 1
fi
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

# Le bac à sable de Chromium doit rester actif. Ubuntu 24.04+ interdit par défaut
# les espaces de noms non privilégiés dont il a besoin : la méthode recommandée
# par Ubuntu est un profil AppArmor qui les autorise pour ce seul binaire.
RESTRICT="$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)"
PROFILE=/etc/apparmor.d/aska
SANDBOX="$ROOT/node_modules/electron/dist/chrome-sandbox"
REAL_ELECTRON="$(readlink -f "$ELECTRON")"
if [ "$RESTRICT" = 1 ]; then
  WANT="$(printf '%s\n' \
    '# Aska : autorise Electron à créer les espaces de noms de son bac à sable.' \
    '# Généré par scripts/install.sh, supprimable sans risque (sudo rm /etc/apparmor.d/aska).' \
    'abi <abi/4.0>,' \
    'include <tunables/global>' \
    '' \
    "profile aska \"$REAL_ELECTRON\" flags=(unconfined) {" \
    '  userns,' \
    '  include if exists <local/aska>' \
    '}')"
  if [ -e "$PROFILE" ] && [ "$(cat "$PROFILE")" = "$WANT" ]; then
    : # déjà en place pour ce dossier
  else
    APPLY=no
    if [ "$SANDBOX_FIX" = yes ]; then
      APPLY=yes
    elif [ "$SANDBOX_FIX" = ask ] && [ -t 0 ]; then
      echo
      echo "Ubuntu 24.04+ bloque le bac à sable d'Electron. Pour qu'Aska démarre, ce script"
      echo "peut installer un profil AppArmor dans $PROFILE (mot de passe sudo demandé)."
      printf "L'installer maintenant ? [O/n] "
      read -r REPLY
      case "$REPLY" in [nN]*) ;; *) APPLY=yes ;; esac
    fi
    if [ "$APPLY" = yes ] && command -v apparmor_parser >/dev/null; then
      TMP="$(mktemp)"
      printf '%s\n' "$WANT" > "$TMP"
      if sudo install -m 644 -o root -g root "$TMP" "$PROFILE" && sudo apparmor_parser -r "$PROFILE"; then
        echo "Profil AppArmor installé : le bac à sable d'Electron est actif."
      else
        echo "L'installation du profil AppArmor a échoué." >&2
        APPLY=failed
      fi
      rm -f "$TMP"
    fi
    if [ "$APPLY" != yes ]; then
      cat <<MSG

Ubuntu 24.04+ bloque le bac à sable d'Electron : Aska ne démarrera pas tant que
ce n'est pas réglé. Au choix :
  - relancer ce script avec : ./scripts/install.sh --sandbox-fix   (recommandé)
  - ou, à refaire après chaque « npm install » :
      sudo chown root:root "$SANDBOX" && sudo chmod 4755 "$SANDBOX"
MSG
    fi
  fi
fi

echo
echo "Aska est installé. Lancez « aska » (ou « aska --hidden » en arrière-plan), puis Ctrl+Alt+Espace."
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Note : ajoutez $BIN à votre PATH." ;; esac
