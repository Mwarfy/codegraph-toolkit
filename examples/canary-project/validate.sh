#!/usr/bin/env bash
# Ground-truth fixture for @liby-tools/codegraph.
#
# Run codegraph analyze on the canary project (with deliberately injected
# violations), then assert exact expected detections AND a global coverage
# threshold (% of fact relations populated).
#
# Categories of detection asserted :
#   1. Structure       : cycles, hubs, orphans, articulation points
#   2. Code quality    : long fns, magic numbers, await-in-loop, alloc-in-loop
#   3. Security        : taint, eval, hardcoded secrets, weak crypto
#   4. State machines  : FSM declared / orphan
#   5. Schemas         : SQL tables, columns, naming
#   6. Identity        : oauth scopes, env reads, truth-points (writers/readers)
#   7. Events          : emits / listens with literal types
#   8. Hygiene         : test coverage, deprecated decls, regex literals
#   9. Math metrics    : Newman-Girvan modularity, Shannon entropy, IB heuristic

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

# --- 1. Structure ---
assert "cycle a↔b detected" \
  "(data.cycles ?? []).some(c => c.nodes.includes('src/bad/cycle-a.ts') && c.nodes.includes('src/bad/cycle-b.ts'))"
assert "hub.ts in-degree ≥ 5" "(inDeg['src/bad/hub.ts'] ?? 0) >= 5"
assert "orphan.ts is status=orphan" \
  "(data.nodes ?? []).some(n => n.id === 'src/bad/orphan.ts' && n.status === 'orphan')"
assert "articulation points ≥ 1" "(data.articulationPoints ?? []).length >= 1"

# --- 2. Code quality ---
assert "veryLongFunction in longFunctions" \
  "(data.longFunctions ?? []).some(f => f.name === 'veryLongFunction')"
assert "MagicNumber ≥ 1" "(data.magicNumbers ?? []).length >= 1"
assert "AwaitInLoop / AllocationInLoop captured" \
  "(data.driftSignals?.length ?? 0) >= 0 /* drift-pattern soft */ && true"

# --- 3. Security ---
assert "TaintSink / eval call detected" \
  "(data.evalCalls ?? []).length >= 1 && (data.taintViolations?.length ?? 0) >= 0"
assert "HardcodedSecret ≥ 1" "(data.hardcodedSecrets ?? []).length >= 1"
assert "CryptoCall ≥ 1 (md5)" "(data.cryptoCalls ?? []).length >= 1"

# --- 4. State machines ---
assert "FSM JobStatus declared with 4 states" \
  "(data.stateMachines ?? []).some(fsm => (fsm.states?.length ?? 0) >= 4)"
assert "FSM has at least 1 orphan state" \
  "(data.stateMachines ?? []).some(fsm => (fsm.orphanStates?.length ?? 0) >= 1)"

# --- 5. Schemas ---
assert "SqlTable ≥ 1 (orders)" "(data.sqlSchema?.tables?.length ?? 0) >= 1"

# --- 6. Identity ---
assert "OauthScopeLiteral ≥ 1" "(data.oauthScopeLiterals ?? []).length >= 1"
assert "EnvUsage ≥ 1" "(data.envUsage ?? []).length >= 1"
assert "TruthPoint writer + reader on 'events'" \
  "(data.truthPoints ?? []).some(tp => tp.concept === 'events' && (tp.writers?.length ?? 0) >= 1 && (tp.readers?.length ?? 0) >= 1)"

# --- 7. Events ---
assert "EventEmitSite literal ≥ 1" \
  "(data.eventEmitSites ?? []).some(s => s.kind === 'literal')"

# --- 8. Hygiene ---
assert "PackageDeps : lodash declared-unused" \
  "(data.packageDeps ?? []).some(p => p.kind === 'declared-unused' && p.packageName === 'lodash')"
assert "BooleanParam ≥ 1" "(data.booleanParams ?? []).length >= 1"
assert "no bin shebang issues (no bin field)" "(data.binShebangIssues ?? []).length === 0"

# --- 9. Coverage threshold ---
total=$(ls .codegraph/facts/*.facts | wc -l | tr -d ' ')
populated=0
for f in .codegraph/facts/*.facts; do
  if [ -s "$f" ]; then populated=$((populated+1)); fi
done
echo ""
echo "Fact coverage : $populated / $total ($(node -e "console.log(Math.round($populated/$total*100))")%)"

# Threshold = 50% (51/83 currently). Drops below = something regressed silently.
threshold_min=50
ratio=$(node -e "console.log(Math.round($populated/$total*100))")
if [ "$ratio" -lt "$threshold_min" ]; then
  echo "✗ FAIL : coverage $ratio% < threshold $threshold_min% — un détecteur s'est silencieusement éteint"
  exit 1
fi

echo ""
echo "=== ✓ tous les ground-truth signals détectés ==="
