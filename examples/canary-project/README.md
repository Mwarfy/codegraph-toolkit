# canary-project — ground-truth fixture for codegraph

Tiny TypeScript project with **deliberately injected violations**. Each
violation has an exact expected detection, asserted by `validate.sh`.

If a toolkit change silently breaks one detector, this fixture fails at CI
and tells you exactly which signal regressed.

## The 5 violations

| # | Violation | File(s) | Expected detection |
|---|---|---|---|
| 1 | Direct import cycle | `src/bad/cycle-a.ts` ↔ `src/bad/cycle-b.ts` | `snapshot.cycles[]` has 1 entry of size 2 |
| 2 | High in-degree hub | `src/bad/hub.ts` (7 importers) | edge in-degree ≥ 5 |
| 3 | Orphan file | `src/bad/orphan.ts` | node with `status === 'orphan'` |
| 4 | Long function | `src/bad/long-function.ts:7` (`veryLongFunction`, 105 LOC) | `snapshot.longFunctions[]` has entry |
| 5 | (Negative) no bin field | `package.json` has no `bin` | `snapshot.binShebangIssues` empty |

## Usage

```bash
# From toolkit root :
cd packages/codegraph && npm run build
./examples/canary-project/validate.sh
```

Expected : `✓ tous les ground-truth signals détectés` + summary table.

## Why this exists

`docs/EXTERNAL-VALIDATION.md` documents qualitative runs on Hono / Sentinel
("hubs cohérents", "0 hallucination") but doesn't give a quantitative
precision/recall measure. This fixture fills that gap : known violations,
known counts, exact assertions. It's the smallest possible step toward a
universal-readiness benchmark — sister fixture
[`runtime-graph-demo`](../runtime-graph-demo/) does the same job for the
runtime layer.

## Adding a new violation

1. Add a source file in `src/bad/` that triggers the new detector
2. Add the assertion in `validate.sh`
3. Document the violation in this table
4. Run `./validate.sh` — should pass

## Limits (acknowledged)

- **6 orphans**, not 1 : the 5 hub consumers (`consumer-a..e.ts`) exist to
  drive up hub's in-degree but they themselves are unimported. Validate
  asserts ≥ 1 orphan, not exactly 1.
- **Not exhaustive** : 5 detectors covered out of ~40. New ground-truth
  files are welcome — see "Adding a new violation" above.
- **Single config** : doesn't validate detector toggles, multi-package
  monorepos, or non-default include/exclude patterns. Out of scope for v1.
