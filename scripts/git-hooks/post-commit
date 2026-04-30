#!/bin/bash
# ─── post-commit hook (générique @liby-tools/adr-toolkit) ───
#
# Régénère le snapshot codegraph + le boot brief après chaque commit.
# Installé par `npx @liby-tools/adr-toolkit init` dans `<projet>/scripts/git-hooks/post-commit`.
#
# Variables d'environnement :
#   CODEGRAPH_SKIP=1       Skip codegraph analyze
#   SKIP_CONTEXT_BRIEF=1   Skip brief regeneration
#   CODEGRAPH_STRICT=1     Fail si nouveaux orphans détectés

# Source nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use --silent >/dev/null 2>&1 || true
fi

GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"
REPO_ROOT="$(cd "$GIT_COMMON_DIR/.." && pwd)"

if [ -d "$REPO_ROOT/.git/rebase-merge" ] || [ -d "$REPO_ROOT/.git/rebase-apply" ]; then
  exit 0
fi

cd "$REPO_ROOT"

# 1. CodeGraph analyze (si codegraph est configuré)
if [ -z "$CODEGRAPH_SKIP" ] && [ -f "$REPO_ROOT/codegraph.config.json" ] || [ -f "$REPO_ROOT/codegraph/codegraph.config.json" ]; then
  echo -e "\033[0;36m  codegraph\033[0m analyzing..."
  npx @liby-tools/codegraph analyze > /dev/null 2>&1 && \
    echo -e "\033[0;32m  codegraph\033[0m ✓ snapshot updated" || \
    echo -e "\033[0;33m  codegraph\033[0m ⚠ analyze skipped (config absent or error)"
fi

# 2. Boot brief regeneration
if [ -z "$SKIP_CONTEXT_BRIEF" ]; then
  npx @liby-tools/adr-toolkit brief > /dev/null 2>&1 && \
    echo -e "\033[0;32m  brief\033[0m ✓ brief regenerated"
fi

exit 0
