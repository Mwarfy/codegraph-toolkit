#!/usr/bin/env bash
# Ground-truth fixture for @liby-tools/codegraph.
#
# Run codegraph analyze on the canary project (with deliberately injected
# violations), then assert exact expected detections. If a future toolkit
# change breaks one of the 5 known signals, this script fails immediately
# → precision regression caught at CI.
#
# Coverage :
#   1. Cycle direct (cycle-a ↔ cycle-b)        → snapshot.cycles ≥ 1
#   2. Hub haut in-degree (hub.ts, 7 importers) → in-degree edge count ≥ 5
#   3. Orphan file (orphan.ts)                  → ≥ 1 status === 'orphan'
#   4. Long function (veryLongFunction, 105L)   → snapshot.longFunctions ≥ 1
#   5. Bin shebang (no bin in pkg)              → 0 issues (negative test)

set -euo pipefail
cd "$(dirname "$0")"

echo "=== canary-project codegraph analyze ==="
rm -rf .codegraph
node ../../packages/codegraph/dist/cli/index.js analyze 2>&1 | tail -3

echo ""
echo "=== ground-truth assertions ==="

snap=$(ls .codegraph/snapshot-*.json | head -1)
if [ ! -f "$snap" ]; then
  echo "✗ FAIL : pas de snapshot"
  exit 1
fi

# Helper : run a node one-liner that loads the snapshot and runs an assertion
assert() {
  local name=$1
  local expr=$2
  local result
  result=$(node -e "
    const data = JSON.parse(require('fs').readFileSync('$snap', 'utf-8'))
    const inDeg = {}
    for (const e of (data.edges ?? [])) inDeg[e.to] = (inDeg[e.to] ?? 0) + 1
    process.stdout.write(String($expr))
  ")
  if [ "$result" = "true" ]; then
    echo "✓ $name"
  else
    echo "✗ FAIL : $name — got $result"
    exit 1
  fi
}

# 1. Cycle detected
assert "cycle: cycle-a ↔ cycle-b detected" \
  "(data.cycles ?? []).some(c => c.nodes.includes('src/bad/cycle-a.ts') && c.nodes.includes('src/bad/cycle-b.ts'))"
assert "cycle count = 1" "(data.cycles ?? []).length === 1"

# 2. Hub : hub.ts has high in-degree
assert "hub.ts in-degree ≥ 5" "(inDeg['src/bad/hub.ts'] ?? 0) >= 5"

# 3. Orphan : orphan.ts is detected as orphan
assert "orphan.ts is status=orphan" \
  "(data.nodes ?? []).some(n => n.id === 'src/bad/orphan.ts' && n.status === 'orphan')"

# 4. Long function detected
assert "veryLongFunction in longFunctions" \
  "(data.longFunctions ?? []).some(f => f.name === 'veryLongFunction')"

# 5. No bin issues (negative test)
assert "no bin shebang issues (no bin field)" \
  "(data.binShebangIssues ?? []).length === 0"

echo ""
echo "=== ✓ tous les ground-truth signals détectés ==="
echo ""
echo "Snapshot summary :"
node -e "
  const data = JSON.parse(require('fs').readFileSync('$snap', 'utf-8'));
  const inDeg = {};
  for (const e of (data.edges ?? [])) inDeg[e.to] = (inDeg[e.to] ?? 0) + 1;
  console.log('  files       :', (data.nodes ?? []).filter(n => n.type === 'file').length);
  console.log('  edges       :', (data.edges ?? []).length);
  console.log('  cycles      :', (data.cycles ?? []).length);
  console.log('  orphans     :', (data.nodes ?? []).filter(n => n.status === 'orphan').length);
  console.log('  longFns     :', (data.longFunctions ?? []).length);
  console.log('  hub in-deg  :', inDeg['src/bad/hub.ts'] ?? 0);
"
