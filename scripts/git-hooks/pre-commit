#!/bin/bash
# ─── pre-commit guard (générique @liby-tools/adr-toolkit) ───
#
# Refuse les commits qui violent les invariants architecturaux. Installé par
# `npx @liby-tools/adr-toolkit init` dans `<projet>/scripts/git-hooks/pre-commit`.
# Activé via `git config core.hooksPath scripts/git-hooks` (fait par init).
#
# Le projet personnalise via env vars (dans le hook lui-même ou via un
# wrapper). Defaults raisonnables — si rien n'est défini, le hook fait
# uniquement les checks portables (anchors regen + brief sync).
#
# Personnalisation projet (édite ces lignes après init si tu veux ajouter
# tsc + tests d'invariant) :
#   ADR_TOOLKIT_RUN_TSC=true      Lance `npx tsc --noEmit`. Default : false.
#   ADR_TOOLKIT_RUN_TSC_DIR=path  Sous-dir où lancer tsc (default: .).
#   ADR_TOOLKIT_INVARIANT_TESTS   Liste de tests à lancer en pre-commit.
#                                 Format : "path1.test.ts path2.test.ts".
#                                 Default : vide (skip).
#   ADR_TOOLKIT_VITEST_DIR=path   Sous-dir où lancer vitest (default: .).
#   SKIP_PRECOMMIT=1              Bypass complet (urgences uniquement).

set -e

if [ -n "$SKIP_PRECOMMIT" ]; then
  echo -e "\033[0;33m  pre-commit\033[0m SKIP_PRECOMMIT=1 — guards bypassed"
  exit 0
fi

# Source nvm — sans ça, tsx/vitest tournent avec le node de login shell
# (souvent v20) et crashent silencieusement avec des erreurs tronquées.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use --silent >/dev/null 2>&1 || true
fi

# Skip in rebase/merge/cherry-pick
GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"
REPO_ROOT="$(cd "$GIT_COMMON_DIR/.." && pwd)"
if [ -d "$REPO_ROOT/.git/rebase-merge" ] || [ -d "$REPO_ROOT/.git/rebase-apply" ]; then
  exit 0
fi

cd "$REPO_ROOT"

# Sanity: node version (vitest 4 + rolldown exigent ≥22)
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo -e "\033[0;31m  pre-commit\033[0m ✗ Node $NODE_MAJOR < 22 (vitest 4 needs ≥22)"
  echo "    Run 'nvm use' (or install nvm) — repo .nvmrc pins ≥22."
  exit 1
fi

# 1. tsc (optionnel)
if [ "${ADR_TOOLKIT_RUN_TSC:-false}" = "true" ]; then
  TSC_DIR="${ADR_TOOLKIT_RUN_TSC_DIR:-.}"
  echo -e "\033[0;36m  pre-commit\033[0m tsc..."
  if ! (cd "$TSC_DIR" && npx tsc --noEmit > /tmp/precommit-tsc.log 2>&1); then
    echo -e "\033[0;31m  pre-commit\033[0m ✗ tsc failed:"
    tail -10 /tmp/precommit-tsc.log
    exit 1
  fi
fi

# 2. Tests d'invariant (optionnel)
if [ -n "${ADR_TOOLKIT_INVARIANT_TESTS:-}" ]; then
  VITEST_DIR="${ADR_TOOLKIT_VITEST_DIR:-.}"
  echo -e "\033[0;36m  pre-commit\033[0m invariants..."
  # shellcheck disable=SC2086
  if ! (cd "$VITEST_DIR" && npx vitest run $ADR_TOOLKIT_INVARIANT_TESTS 2>&1 | tail -25); then
    echo -e "\033[0;31m  pre-commit\033[0m ✗ invariant tests failed"
    exit 1
  fi
fi

# 3. ADR anchors regen — SSOT inversée. Les marqueurs `// ADR-NNN` du code
#    génèrent ## Anchored in. Si drift, on régen + auto-stage.
echo -e "\033[0;36m  pre-commit\033[0m ADR anchors..."
ANCHORS_OUT=$(npx @liby-tools/adr-toolkit regen 2>&1) || {
  echo -e "\033[0;31m  pre-commit\033[0m ✗ regen anchors a échoué :"
  echo "$ANCHORS_OUT" | tail -10
  exit 1
}
# Auto-stage si l'ADR dir a changé (le path est lu depuis .codegraph-toolkit.json
# par le toolkit, mais on git-add globalement le pattern docs/adr).
if ! git diff --quiet -- '*adr/*.md' 2>/dev/null; then
  git add -- '*adr/*.md' 2>/dev/null || true
  echo -e "\033[0;33m  pre-commit\033[0m ⓘ ADRs ## Anchored in auto-staged (drift)"
fi

# 4. Brief sync
echo -e "\033[0;36m  pre-commit\033[0m brief sync..."
npx @liby-tools/adr-toolkit brief > /dev/null 2>&1 || {
  echo -e "\033[0;31m  pre-commit\033[0m ✗ brief generation failed"
  exit 1
}
# Auto-stage si brief a bougé (path lu depuis config — ici on git-add le
# pattern par défaut + le path le plus courant).
for f in CLAUDE-CONTEXT.md; do
  if [ -f "$f" ] && ! git diff --quiet -- "$f" 2>/dev/null; then
    git add "$f"
    echo -e "\033[0;33m  pre-commit\033[0m ⓘ $f auto-staged (drift)"
  fi
done

echo -e "\033[0;32m  pre-commit\033[0m ✓ checks OK"
exit 0
