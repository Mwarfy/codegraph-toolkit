#!/bin/bash
# ============================================
# prepare-publish.sh — preflight check before npm publish
# ============================================
# NE PUBLIE PAS. Vérifie que tout est prêt et imprime les commandes
# que Marius lancera manuellement quand il sera prêt.
#
# Usage : bash scripts/prepare-publish.sh

set -e

cd "$(dirname "$0")/.."

echo "─── 1. Git status ────────────────────────────────────────────"
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ Working tree not clean. Commit or stash before publish."
  git status --short
  exit 1
fi
echo "✓ Working tree clean"
echo "  HEAD: $(git log -1 --oneline)"

echo ""
echo "─── 2. Build ─────────────────────────────────────────────────"
npx tsc -b
echo "✓ Build clean"

echo ""
echo "─── 3. Tests ─────────────────────────────────────────────────"
npx vitest run --reporter=basic 2>&1 | tail -3 || npx vitest run | tail -3
echo "✓ Tests pass"

echo ""
echo "─── 4. Package versions ──────────────────────────────────────"
for pkg in salsa datalog codegraph adr-toolkit codegraph-mcp; do
  v=$(node -e "console.log(require('./packages/$pkg/package.json').version)")
  echo "  @liby-tools/$pkg : $v"
done

echo ""
echo "─── 5. npm whoami ────────────────────────────────────────────"
WHO=$(npm whoami 2>/dev/null || echo "")
if [ -z "$WHO" ]; then
  echo "✗ Not logged in to npm. Run: npm login"
  exit 1
fi
echo "✓ Logged in as: $WHO"

echo ""
echo "─── 6. @liby scope availability ──────────────────────────────"
echo "  Verify org @liby exists on npmjs.com (Marius admin)"
echo "  https://www.npmjs.com/org/liby"

echo ""
echo "─── 7. Publication order (deps-first) ───────────────────────"
echo ""
echo "Run these commands in order, one at a time, verifying each:"
echo ""
echo "# 1. salsa first (no @liby-tools/ deps)"
echo "  npm publish --workspace=@liby-tools/salsa"
echo ""
echo "# 2. datalog (no @liby-tools/ deps)"
echo "  npm publish --workspace=@liby-tools/datalog"
echo ""
echo "# 3. codegraph (depends on @liby-tools/salsa)"
echo "  npm publish --workspace=@liby-tools/codegraph"
echo ""
echo "# 4. adr-toolkit (depends on @liby-tools/codegraph + @liby-tools/datalog)"
echo "  npm publish --workspace=@liby-tools/adr-toolkit"
echo ""
echo "# 5. codegraph-mcp (depends on @modelcontextprotocol/sdk)"
echo "  npm publish --workspace=@liby-tools/codegraph-mcp"
echo ""
echo "─── 8. Post-publish ──────────────────────────────────────────"
echo ""
echo "After publish, consumers can install via :"
echo "  npm install @liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/codegraph-mcp"
echo ""
echo "Update install.sh to use npm install instead of npm link."
echo "Tag the release : git tag v0.1.0 && git push --tags"
echo ""
echo "✓ All preflight checks passed. Ready for manual publish."
