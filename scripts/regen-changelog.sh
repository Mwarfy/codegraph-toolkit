#!/bin/bash
# ─── regen-changelog.sh ───
#
# Régénère un bloc "Activity log" en tête du CHANGELOG.md depuis
# `git log` — pas de versioning sémantique automatique (les versions
# sont gérées manuellement dans chaque package.json), juste un
# inventaire vivant des commits par catégorie + date.
#
# Output : un fichier `CHANGELOG-RECENT.md` mis à jour avec les
# 50 derniers commits, groupés par type conventional commit (feat,
# fix, perf, refactor, chore, docs).
#
# Idempotent : peut être appelé depuis le post-commit hook.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

OUT="$REPO_ROOT/CHANGELOG-RECENT.md"
N_COMMITS=50

{
  echo "# Recent activity"
  echo
  echo "> Auto-generated from \`git log\` by \`scripts/regen-changelog.sh\`."
  echo "> Reflects the last ${N_COMMITS} commits, grouped by conventional"
  echo "> commit type. The semantic version per package lives in each"
  echo "> \`package.json\`."
  echo
  echo "Last update : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "## By type"
  echo

  for type in feat fix perf refactor chore docs test; do
    count=$(git log -n "$N_COMMITS" --pretty=format:"%s" | grep -E "^${type}(\(|:)" | wc -l | tr -d ' ')
    if [ "$count" -gt 0 ]; then
      echo "### \`$type\` ($count)"
      echo
      git log -n "$N_COMMITS" --pretty=format:"- **%h** %s — %ad" --date=short \
        | grep -E "^- \*\*[a-f0-9]+\*\* ${type}(\(|:)" \
        | head -20
      echo
      echo
    fi
  done

  echo "## Full history"
  echo
  git log -n "$N_COMMITS" --pretty=format:"- **%h** %s — %ad" --date=short
  echo
} > "$OUT"

echo "✓ Wrote $(wc -l < "$OUT" | tr -d ' ') lines to $(basename "$OUT")"
