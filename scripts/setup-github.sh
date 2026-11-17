#!/usr/bin/env bash
# Configures Aska's GitHub repository as a team repository. Run it once, with
# an administrator account on the repository and the GitHub CLI signed in (gh auth login).
#
#   ./scripts/setup-github.sh [--dry-run] [--yes] [owner/repo]
#
# What the script does (each step is idempotent):
#   1. default branch "main"; squash merge only, PR title as the commit
#      message; branches deleted after merge; auto-merge allowed;
#      Discussions enabled;
#   2. GitHub Actions: read-only token by default, PR creation allowed
#      (needed by release-please);
#   3. Dependabot alerts and security fixes, secret scanning and push protection;
#   4. protection rules from .github/rulesets/ (created or updated);
#   5. labels used by the issue templates and Dependabot;
#   6. open PRs targeting the old default branch: retargeted to main.
set -euo pipefail

DRY=0; YES=0; REPO=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    */*) REPO="$a" ;;
    *) echo "Unknown option: $a" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v gh >/dev/null || { echo "The GitHub CLI (gh) is required: https://cli.github.com" >&2; exit 1; }
if [ -z "$REPO" ]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi
echo "Repository: $REPO$([ "$DRY" = 1 ] && echo '  (dry run: nothing will be changed)')"

run() {
  if [ "$DRY" = 1 ]; then printf '  [dry run] gh'; printf ' %q' "$@"; echo; else gh "$@" >/dev/null; fi
}
step() { echo; echo "▸ $*"; }

if [ "$DRY" = 0 ]; then
  ADMIN="$(gh api "repos/$REPO" -q .permissions.admin)"
  [ "$ADMIN" = "true" ] || { echo "You must be an administrator of $REPO." >&2; exit 1; }
fi
OLD_DEFAULT="$(gh api "repos/$REPO" -q .default_branch)"
gh api "repos/$REPO/branches/main" >/dev/null 2>&1 || { echo "The main branch does not exist on $REPO." >&2; exit 1; }

step "Repository settings (default branch main, squash, delete merged branches)"
run api -X PATCH "repos/$REPO" \
  -f default_branch=main \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY \
  -F delete_branch_on_merge=true -F allow_auto_merge=true -F allow_update_branch=true \
  -F has_discussions=true

step "GitHub Actions: read-only token, PR creation allowed (release-please)"
run api -X PUT "repos/$REPO/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true

step "Security: Dependabot alerts and fixes, secret scanning"
run api -X PUT "repos/$REPO/vulnerability-alerts"
run api -X PUT "repos/$REPO/automated-security-fixes"
run api -X PATCH "repos/$REPO" --input - <<'JSON'
{"security_and_analysis": {"secret_scanning": {"status": "enabled"}, "secret_scanning_push_protection": {"status": "enabled"}}}
JSON

step "Protection rules (.github/rulesets)"
EXISTING="$(gh api "repos/$REPO/rulesets" -q '.[] | "\(.id)\t\(.name)"' 2>/dev/null || true)"
for f in "$ROOT"/.github/rulesets/*.json; do
  NAME="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$f")"
  ID="$(printf '%s\n' "$EXISTING" | awk -F'\t' -v n="$NAME" '$2==n {print $1}' | head -1)"
  if [ -n "$ID" ]; then
    echo "  updating: $NAME"
    run api -X PUT "repos/$REPO/rulesets/$ID" --input "$f"
  else
    echo "  creating: $NAME"
    run api -X POST "repos/$REPO/rulesets" --input "$f"
  fi
done

step "Labels"
while IFS='|' read -r name color desc; do
  run label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force
done <<'LABELS'
triage|ededed|New issue, not reviewed yet
bug|d73a4a|Something is not working
enhancement|a2eeef|New feature or improvement
security|b60205|Touches security
dependencies|0366d6|Dependency updates
ci|1d76db|Continuous integration
documentation|0075ca|Documentation
LABELS

if [ "$OLD_DEFAULT" != "main" ]; then
  step "Open PRs targeting the old default branch ($OLD_DEFAULT)"
  PRS="$(gh pr list --repo "$REPO" --base "$OLD_DEFAULT" --state open --json number,title -q '.[] | "\(.number)\t\(.title)"')"
  if [ -z "$PRS" ]; then
    echo "  none"
  else
    printf '%s\n' "$PRS" | sed 's/^/  #/'
    ANSWER=n
    if [ "$YES" = 1 ]; then ANSWER=y
    elif [ -t 0 ] && [ "$DRY" = 0 ]; then read -r -p "  Retarget them to main? [y/N] " ANSWER; fi
    if [ "$DRY" = 1 ] || [[ "$ANSWER" =~ ^[yY] ]]; then
      printf '%s\n' "$PRS" | cut -f1 | while read -r n; do run pr edit "$n" --repo "$REPO" --base main; done
    else
      echo "  left as they are (gh pr edit <number> --base main to do it later)"
    fi
  fi
fi

echo
echo "Done. Next steps, if needed:"
echo "  - RELEASE_TOKEN secret so that CI runs on the release PR (see CONTRIBUTING.md);"
echo "  - Settings → Collaborators: give the \"Write\" role to regular contributors."
