#!/usr/bin/env bash
# Ground-truth fixture pour @liby-tools/runtime-graph.
#
# Run l'app demo sous bootstrap OTel ESM, puis assert que les facts captures
# correspondent EXACTEMENT à ce qu'on attend (3 routes hit, 1 RuntimeRunMeta,
# nb spans cohérent).
#
# Sortie code 0 si tout OK, ≠ 0 si écart → catch automatique des régressions
# du capture pipeline.

set -euo pipefail

cd "$(dirname "$0")"

BOOTSTRAP="$(realpath ../../packages/runtime-graph/dist/capture/auto-bootstrap.js)"
FACTS_OUT="$(pwd)/.codegraph/facts-runtime"

echo "=== runtime-graph-demo run ==="
rm -rf .codegraph

NODE_OPTIONS="--import file://$BOOTSTRAP" \
  LIBY_RUNTIME_PROJECT_ROOT="$(pwd)" \
  LIBY_RUNTIME_FACTS_OUT="$FACTS_OUT" \
  node app.mjs

echo ""
echo "=== assertions ==="

# Trouve le sub-dir pid-*
pid_dir=$(ls -d "$FACTS_OUT"/pid-* 2>/dev/null | head -1)
if [ -z "$pid_dir" ]; then
  echo "✗ FAIL : aucun dossier pid-* dans $FACTS_OUT"
  exit 1
fi
echo "facts dir: $pid_dir"

# 1. HttpRouteHit doit avoir 3 lignes (1 par route hit)
http_lines=$(wc -l < "$pid_dir/HttpRouteHit.facts" | tr -d ' ')
if [ "$http_lines" -ne 3 ]; then
  echo "✗ FAIL : HttpRouteHit attendu 3 lignes, trouvé $http_lines"
  cat "$pid_dir/HttpRouteHit.facts"
  exit 1
fi
echo "✓ HttpRouteHit : 3 lignes"

# 2. Chaque route doit être présente (healthz, users, products)
for route in "/healthz" "/users" "/products"; do
  if ! grep -q "$route" "$pid_dir/HttpRouteHit.facts"; then
    echo "✗ FAIL : route $route absente de HttpRouteHit.facts"
    exit 1
  fi
done
echo "✓ Routes /healthz /users /products toutes présentes"

# 3. RuntimeRunMeta : 1 ligne, totalSpans ≥ 3 (au moins 3 server spans)
meta_lines=$(wc -l < "$pid_dir/RuntimeRunMeta.facts" | tr -d ' ')
if [ "$meta_lines" -ne 1 ]; then
  echo "✗ FAIL : RuntimeRunMeta attendu 1 ligne, trouvé $meta_lines"
  exit 1
fi
total_spans=$(awk -F'\t' '{print $4}' "$pid_dir/RuntimeRunMeta.facts")
if [ "$total_spans" -lt 3 ]; then
  echo "✗ FAIL : totalSpans ≥ 3 attendu, trouvé $total_spans"
  exit 1
fi
echo "✓ RuntimeRunMeta : totalSpans=$total_spans"

# 4. Driver doit être 'auto-bootstrap'
driver=$(awk -F'\t' '{print $1}' "$pid_dir/RuntimeRunMeta.facts")
if [ "$driver" != "auto-bootstrap" ]; then
  echo "✗ FAIL : driver attendu 'auto-bootstrap', trouvé '$driver'"
  exit 1
fi
echo "✓ Driver : auto-bootstrap"

echo ""
echo "=== ✓ tous les asserts passent ==="
echo ""
echo "Captured facts :"
for f in "$pid_dir"/*.facts; do
  lines=$(wc -l < "$f" | tr -d ' ')
  printf "  %4s  %s\n" "$lines" "$(basename "$f")"
done
