#!/bin/bash
# ============================================
# codegraph-toolkit — installer one-liner
# ============================================
# Usage :
#   curl -fsSL https://raw.githubusercontent.com/Mwarfy/codegraph-toolkit/master/install.sh | bash
#
# Default : install via npm registry (recommended).
#   npm install -g @liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/codegraph-mcp
#
# Dev mode : clone + npm link (use --dev flag for contributing to the toolkit itself).
#   curl -fsSL ...install.sh | bash -s -- --dev
#
# Variables :
#   TOOLKIT_DIR   Default ~/Documents/codegraph-toolkit (only used in --dev mode)
#   TOOLKIT_REPO  Default https://github.com/Mwarfy/codegraph-toolkit.git

set -e

MODE="install"
for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    *) ;;
  esac
done

TOOLKIT_DIR="${TOOLKIT_DIR:-$HOME/Documents/codegraph-toolkit}"
TOOLKIT_REPO="${TOOLKIT_REPO:-https://github.com/Mwarfy/codegraph-toolkit.git}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✕${NC} $1"; exit 1; }

echo ""
echo "🔧 codegraph-toolkit installer"
if [ "$MODE" = "dev" ]; then
  echo "   Mode : --dev (clone + npm link from source)"
  echo "   Target : $TOOLKIT_DIR"
else
  echo "   Mode : npm install -g (default — use --dev for contributor mode)"
fi
echo ""

# 1. Node version
if ! command -v node &>/dev/null; then
  fail "Node.js absent. Install Node ≥18 (https://nodejs.org)"
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
MIN_NODE=18
if [ "$MODE" = "dev" ]; then MIN_NODE=22; fi  # vitest 4 needs ≥22 in dev
if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
  warn "Node $NODE_MAJOR < $MIN_NODE — required for this mode."
  warn "  nvm use --lts (puis relance ce script)"
  fail "Stop"
fi
ok "Node $(node -v)"

# ─── PATH 1 : npm install -g (default, recommended) ───
if [ "$MODE" = "install" ]; then
  echo "  Installing @liby-tools packages globally..."
  npm install -g @liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/codegraph-mcp 2>&1 | tail -3 \
    || fail "npm install failed. Check your network or try --dev mode."

  ok "Installed: @liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/codegraph-mcp"

  echo ""
  echo -e "${GREEN}✓ Installation terminée${NC}"
  echo ""
  echo "Available binaries :"
  echo "  - codegraph (analyze, watch, synopsis, diff, ...)"
  echo "  - adr-toolkit (init, regen, brief, check-asserts, ...)"
  echo "  - codegraph-mcp (MCP server, wire dans .mcp.json)"
  echo ""
  echo "Pour utiliser dans ton projet :"
  echo ""
  echo "  cd <ton-projet>"
  echo "  npx adr-toolkit init --with-claude-settings"
  echo "  # Optional : add codegraph-mcp to .mcp.json (see README)"
  echo ""
  echo "Puis crée ton premier ADR (cf. README du toolkit)."
  echo ""
  exit 0
fi

# ─── PATH 2 : --dev mode (clone + npm link from source) ───

# 2. Clone or update
if [ -d "$TOOLKIT_DIR/.git" ]; then
  ok "Repo déjà présent à $TOOLKIT_DIR"
  echo "  Updating..."
  (cd "$TOOLKIT_DIR" && git pull --ff-only) || warn "git pull a échoué (continue)"
elif [ -d "$TOOLKIT_DIR" ]; then
  fail "$TOOLKIT_DIR existe mais n'est pas un repo git. Supprime-le ou choisis un autre TOOLKIT_DIR."
else
  echo "  Cloning..."
  git clone "$TOOLKIT_REPO" "$TOOLKIT_DIR" || fail "git clone a échoué"
  ok "Cloned"
fi

cd "$TOOLKIT_DIR"

# 3. Install + build
echo "  Installing dependencies..."
npm install --silent 2>&1 | tail -3
echo "  Building..."
npm run build > /dev/null 2>&1 || fail "build a échoué — voir 'cd $TOOLKIT_DIR && npm run build' pour les détails"
ok "Built"

# 4. Tests sanity
npm test --silent > /dev/null 2>&1 && ok "Tests : OK" || warn "Tests ont échoué (non-bloquant)"

# 5. Publier les binaires via npm link
npm link --workspaces --silent 2>&1 | tail -1
ok "npm link --workspaces"

echo ""
echo -e "${GREEN}✓ Installation --dev terminée${NC}"
echo ""
echo "Pour utiliser dans ton projet (en mode dev, lié au source) :"
echo ""
echo "  cd <ton-projet>"
echo "  npm link @liby-tools/codegraph @liby-tools/adr-toolkit"
echo "  npx adr-toolkit init --with-claude-settings"
echo ""
echo "Modifs dans $TOOLKIT_DIR sont live (pas besoin de re-publish)."
echo ""
