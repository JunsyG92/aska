#!/usr/bin/env bash
# Règle le dépôt GitHub d'Aska comme un dépôt d'équipe. À lancer une fois, avec
# un compte administrateur du dépôt et la CLI GitHub connectée (gh auth login).
#
#   ./scripts/setup-github.sh [--dry-run] [--yes] [propriétaire/dépôt]
#
# Ce que fait le script (chaque étape est idempotente) :
#   1. branche par défaut « main » ; fusion en squash uniquement, titre de PR comme
#      message ; branches supprimées après fusion ; fusion automatique autorisée ;
#      Discussions activées ;
#   2. GitHub Actions : jeton en lecture seule par défaut, création de PR autorisée
#      (nécessaire à release-please) ;
#   3. alertes et correctifs Dependabot, détection de secrets et blocage au push ;
#   4. règles de protection de .github/rulesets/ (création ou mise à jour) ;
#   5. étiquettes utilisées par les modèles d'issues et Dependabot ;
#   6. PR ouvertes vers l'ancienne branche par défaut : proposées vers main.
set -euo pipefail

DRY=0; YES=0; REPO=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    */*) REPO="$a" ;;
    *) echo "Option inconnue : $a" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v gh >/dev/null || { echo "La CLI GitHub (gh) est requise : https://cli.github.com" >&2; exit 1; }
if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi
echo "Dépôt : $REPO$([ "$DRY" = 1 ] && echo '  (simulation : rien ne sera modifié)')"

run() {
  if [ "$DRY" = 1 ]; then printf '  [simulation] gh'; printf ' %q' "$@"; echo; else gh "$@" >/dev/null; fi
}
step() { echo; echo "▸ $*"; }

if [ "$DRY" = 0 ]; then
  ADMIN="$(gh api "repos/$REPO" -q .permissions.admin)"
  [ "$ADMIN" = "true" ] || { echo "Il faut être administrateur de $REPO." >&2; exit 1; }
fi
OLD_DEFAULT="$(gh api "repos/$REPO" -q .default_branch)"
gh api "repos/$REPO/branches/main" >/dev/null 2>&1 || { echo "La branche main n'existe pas sur $REPO." >&2; exit 1; }

step "Réglages du dépôt (branche par défaut main, squash, suppression des branches fusionnées)"
run api -X PATCH "repos/$REPO" \
  -f default_branch=main \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true -F allow_auto_merge=true -F allow_update_branch=true \
  -F has_discussions=true

step "GitHub Actions : jeton en lecture seule, création de PR autorisée (release-please)"
run api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true

step "Sécurité : alertes et correctifs Dependabot, détection de secrets"
run api -X PUT "repos/$REPO/vulnerability-alerts"
run api -X PUT "repos/$REPO/automated-security-fixes"
run api -X PATCH "repos/$REPO" --input - <<'JSON'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"}, "secret_scanning_push_protection": {"status": "enabled"}}}
JSON

step "Règles de protection (.github/rulesets)"
EXISTING="$(gh api "repos/$REPO/rulesets" -q '.[] | "\(.id)\t\(.name)"' 2>/dev/null || true)"
for f in "$ROOT"/.github/rulesets/*.json; do
  NAME="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$f")"
  ID="$(printf '%s\n' "$EXISTING" | awk -F'\t' -v n="$NAME" '$2==n {print $1}' | head -1)"
  if [ -n "$ID" ]; then
    echo "  mise à jour : $NAME"
    run api -X PUT "repos/$REPO/rulesets/$ID" --input "$f"
  else
    echo "  création : $NAME"
    run api -X POST "repos/$REPO/rulesets" --input "$f"
  fi
done

step "Étiquettes"
while IFS='|' read -r name color desc; do
  run label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force
done <<'LABELS'
à trier|ededed|Nouvelle issue, pas encore examinée
bug|d73a4a|Quelque chose ne fonctionne pas
amélioration|a2eeef|Nouvelle fonctionnalité ou évolution
sécurité|b60205|Touche à la sécurité
dépendances|0366d6|Mise à jour de dépendances
ci|1d76db|Intégration continue
documentation|0075ca|Documentation
LABELS

if [ "$OLD_DEFAULT" != "main" ]; then
  step "PR ouvertes vers l'ancienne branche par défaut ($OLD_DEFAULT)"
  PRS="$(gh pr list --repo "$REPO" --base "$OLD_DEFAULT" --state open --json number,title -q '.[] | "\(.number)\t\(.title)"')"
  if [ -z "$PRS" ]; then
    echo "  aucune"
  else
    printf '%s\n' "$PRS" | sed 's/^/  #/'
    ANSWER=n
    if [ "$YES" = 1 ]; then ANSWER=o
    elif [ -t 0 ] && [ "$DRY" = 0 ]; then read -r -p "  Les proposer vers main ? [o/N] " ANSWER; fi
    if [ "$DRY" = 1 ] || [[ "$ANSWER" =~ ^[oOyY] ]]; then
      printf '%s\n' "$PRS" | cut -f1 | while read -r n; do run pr edit "$n" --repo "$REPO" --base main; done
    else
      echo "  laissées telles quelles (gh pr edit <numéro> --base main pour le faire plus tard)"
    fi
  fi
fi

echo
echo "Terminé. À faire ensuite, si besoin :"
echo "  - secret RELEASE_TOKEN pour que la CI tourne sur la PR de release (voir CONTRIBUTING.md) ;"
echo "  - Settings → Collaborators : donner le rôle « Write » aux contributeurs réguliers."
