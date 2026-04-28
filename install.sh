#!/bin/bash
# ============================================
# codegraph-toolkit — installer one-liner
# ============================================
# Usage :
#   curl -fsSL https://raw.githubusercontent.com/<user>/codegraph-toolkit/master/install.sh | bash
#
# Clone le repo dans ~/Documents/codegraph-toolkit (ou $TOOLKIT_DIR), build
# les 2 packages, et publie les binaires `codegraph` + `adr-toolkit` via
# `npm link`. Idempotent.
#
# Variables :
#   TOOLKIT_DIR   Default ~/Documents/codegraph-toolkit
#   TOOLKIT_REPO  Default https://github.com/<user>/codegraph-toolkit.git
#                 Override pour un fork ou un mirror local.

set -e

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
echo "   Target : $TOOLKIT_DIR"
echo ""

# 1. Node version (vitest 4 + rolldown exigent ≥22)
if ! command -v node &>/dev/null; then
  fail "Node.js absent. Install Node ≥22 (https://nodejs.org)"
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  warn "Node $NODE_MAJOR < 22 — vitest 4 ne marchera pas. Source nvm :"
  warn "  nvm use --lts (puis relance ce script)"
  fail "Stop"
fi
ok "Node $(node -v)"

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
echo -e "${GREEN}✓ Installation terminée${NC}"
echo ""
echo "Pour utiliser dans ton projet :"
echo ""
echo "  cd <ton-projet>"
echo "  npm link @liby/codegraph @liby/adr-toolkit"
echo "  npx adr-toolkit init --with-claude-settings"
echo ""
echo "Puis crée ton premier ADR (cf. README du toolkit)."
echo ""
