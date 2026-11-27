#!/usr/bin/env bash
# Vrai clic sur une autre fenêtre, sous un vrai gestionnaire de fenêtres (Openbox) :
# le chat doit se masquer, sauf s'il est épinglé ou si l'ancienne option hideOnBlur:false est présente.
#   xvfb-run -a -s "-screen 0 1400x900x24" bash test/e2e/outside-click.sh
# Prérequis : openbox, xdotool, xterm.   ASKA_E2E_NO_SANDBOX=1 si exécuté en root.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELECTRON="$ROOT/node_modules/electron/dist/electron"
FLAGS=(); [ "${ASKA_E2E_NO_SANDBOX:-0}" = 1 ] && FLAGS=(--no-sandbox)
for t in openbox xdotool xterm; do command -v "$t" >/dev/null || { echo "$t est requis" >&2; exit 2; }; done

FAILS=0
openbox >/dev/null 2>&1 & WM=$!
xterm -geometry 40x10+20+20 -e sleep 600 >/dev/null 2>&1 & TERM_PID=$!
cleanup() { kill "$WM" "$TERM_PID" 2>/dev/null; pkill -f "$ELECTRON" 2>/dev/null; }
trap cleanup EXIT
sleep 1

visible() { [ -n "$(xdotool search --onlyvisible --name '^Aska$' 2>/dev/null | head -1)" ]; }

check() { # $1 = nom, $2 = config.json, $3 = état (pinned) ou vide, $4 = attendu : masque | reste
  local home; home="$(mktemp -d)"
  mkdir -p "$home/.config/aska" "$home/.local/state/aska"
  echo "$2" > "$home/.config/aska/config.json"; chmod 600 "$home/.config/aska/config.json"
  if [ -n "$3" ]; then echo "{\"pinned\": $3}" > "$home/.local/state/aska/state.json"; chmod 600 "$home/.local/state/aska/state.json"; fi
  env -u XDG_CONFIG_HOME -u XDG_STATE_HOME -u XDG_DATA_HOME HOME="$home" "$ELECTRON" "${FLAGS[@]}" "$ROOT" >/dev/null 2>&1 &
  for _ in $(seq 1 40); do visible && break; sleep 0.25; done
  visible || { echo "  ✗ $1 : la fenêtre ne s'est pas affichée"; FAILS=$((FAILS+1)); pkill -f "$ELECTRON"; sleep 1; return; }
  sleep 1
  xdotool mousemove 100 60 click 1; sleep 2.5 # the chat fades, then hides after 1.5 s
  local got=reste; visible || got=masque
  if [ "$got" = "$4" ]; then echo "  ✓ $1 : $got"; else echo "  ✗ $1 : attendu « $4 », obtenu « $got »"; FAILS=$((FAILS+1)); fi
  env HOME="$home" "$ELECTRON" "${FLAGS[@]}" "$ROOT" --quit >/dev/null 2>&1; sleep 1; pkill -f "$ELECTRON"; sleep 0.5
}

echo "Clic sur une autre fenêtre :"
check "configuration par défaut" '{"shortcut":false}' "" masque
check "épinglé" '{"shortcut":false}' true reste
check "désépinglé malgré hideOnBlur:false" '{"shortcut":false,"hideOnBlur":false}' false masque
check "ancienne config hideOnBlur:false" '{"shortcut":false,"hideOnBlur":false}' "" reste
[ "$FAILS" = 0 ] && echo "Clic extérieur OK" || { echo "$FAILS échec(s)"; exit 1; }
