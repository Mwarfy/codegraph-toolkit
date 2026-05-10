#!/usr/bin/env bash
# Update les packages @liby-tools/* dans les projets externes consommateurs
# listés dans scripts/sync.config. Pour chaque projet :
#   - pnpm update --latest @liby-tools/codegraph @liby-tools/adr-toolkit ...
#   - print le diff de versions
#
# Destructif (modifie package.json + lockfile des projets externes), donc
# JAMAIS appelé automatiquement par un hook. À lancer manuellement après
# une release npm du toolkit :
#   ./scripts/sync-external.sh        # interactif (confirme par projet)
#   ./scripts/sync-external.sh -y     # non-interactif
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$REPO_ROOT/scripts/sync.config"

[ -f "$CONFIG" ] || { echo "✗ Missing $CONFIG"; exit 1; }

AUTO_YES=0
[ "${1:-}" = "-y" ] && AUTO_YES=1

PACKAGES=(
  "@liby-tools/codegraph"
  "@liby-tools/codegraph-mcp"
  "@liby-tools/adr-toolkit"
  "@liby-tools/datalog"
  "@liby-tools/salsa"
  "@liby-tools/runtime-graph"
  "@liby-tools/invariants-postgres-ts"
)

# Lit la config (skip lignes vides + commentaires)
PROJECTS=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="${line## }"
  line="${line%% }"
  [ -z "$line" ] && continue
  PROJECTS+=("$line")
done < "$CONFIG"

if [ "${#PROJECTS[@]}" = "0" ]; then
  echo "✗ Aucun projet dans $CONFIG"
  exit 1
fi

echo "▸ ${#PROJECTS[@]} projets externes à sync"
echo ""

for project in "${PROJECTS[@]}"; do
  if [ ! -d "$project" ]; then
    echo "⚠️  $project — répertoire absent, skip"
    continue
  fi
  if [ ! -f "$project/package.json" ]; then
    echo "⚠️  $project — pas de package.json, skip"
    continue
  fi

  cd "$project"

  # Détecte les @liby-tools/* effectivement présents dans ce projet
  PRESENT=()
  for pkg in "${PACKAGES[@]}"; do
    if grep -q "\"$pkg\"" package.json 2>/dev/null; then
      PRESENT+=("$pkg")
    fi
  done

  if [ "${#PRESENT[@]}" = "0" ]; then
    echo "─ $project — aucun @liby-tools/* dépendance, skip"
    continue
  fi

  echo "─ $project (${#PRESENT[@]} packages: ${PRESENT[*]})"

  if [ "$AUTO_YES" = "0" ]; then
    read -r -p "  pnpm update --latest ? [y/N] " ans
    case "$ans" in
      y|Y) ;;
      *) echo "  skip"; continue ;;
    esac
  fi

  # Print versions avant
  echo "  Avant:"
  for pkg in "${PRESENT[@]}"; do
    ver=$(node -e "const p=require('./package.json'); const d={...p.dependencies,...p.devDependencies}; console.log(d['$pkg']||'?')")
    echo "    $pkg $ver"
  done

  if pnpm update --latest "${PRESENT[@]}" 2>&1 | tail -5; then
    echo "  Après:"
    for pkg in "${PRESENT[@]}"; do
      ver=$(node -e "const p=require('./package.json'); const d={...p.dependencies,...p.devDependencies}; console.log(d['$pkg']||'?')")
      echo "    $pkg $ver"
    done
  else
    echo "  ✗ update failed"
  fi
  echo ""
done

echo "✓ sync-external done"
