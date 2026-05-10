#!/usr/bin/env bash
# Action complète : pull master + install deps + build packages + symlink
# le CLI dans ~/.local/bin pour que les autres projets utilisent toujours
# la dernière version locale.
#
# À lancer manuellement quand sync-master.sh signale du retard :
#   ./scripts/sync-toolkit.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CURRENT_BRANCH=$(git branch --show-current)
SAFE_TO_PULL=0
if [ "$CURRENT_BRANCH" = "master" ]; then
  SAFE_TO_PULL=1
fi

echo "▸ Fetch origin"
git fetch origin --quiet

# Pull master uniquement si on est dessus (et clean)
if [ "$SAFE_TO_PULL" = "1" ]; then
  if ! git diff-index --quiet HEAD --; then
    echo "✗ Working tree dirty — commit/stash avant sync-toolkit"
    exit 1
  fi
  echo "▸ Pull master"
  git pull --ff-only origin master
else
  echo "ℹ️  Tu es sur \`$CURRENT_BRANCH\` (pas master) — skip pull, build seulement"
fi

echo "▸ pnpm install"
pnpm install --silent

echo "▸ Build packages/codegraph"
( cd packages/codegraph && pnpm build )

# Symlink CLI dans ~/.local/bin (premier dans le PATH)
LINK_DIR="$HOME/.local/bin"
mkdir -p "$LINK_DIR"

CLI_SRC="$REPO_ROOT/packages/codegraph/dist/cli/index.js"
CLI_LINK="$LINK_DIR/codegraph"

if [ ! -f "$CLI_SRC" ]; then
  echo "✗ Build artifact missing: $CLI_SRC"
  exit 1
fi

# rendre exécutable + symlink
chmod +x "$CLI_SRC"
ln -sf "$CLI_SRC" "$CLI_LINK"
echo "▸ Linked $CLI_LINK → $CLI_SRC"

# codegraph-mcp si présent
MCP_SRC="$REPO_ROOT/packages/codegraph-mcp/dist/index.js"
if [ -f "$MCP_SRC" ]; then
  chmod +x "$MCP_SRC"
  ln -sf "$MCP_SRC" "$LINK_DIR/codegraph-mcp"
  echo "▸ Linked $LINK_DIR/codegraph-mcp → $MCP_SRC"
fi

echo ""
echo "✓ Toolkit synced. CLI version:"
"$CLI_LINK" --version
