# @liby-tools/salsa

Salsa-style incremental computation runtime in pure TypeScript.

Inspired by [salsa-rs](https://github.com/salsa-rs/salsa) (the engine
behind rust-analyzer). Provides automatic memoization with **transitive
dependency tracking** and **red/green invalidation** — when an input
changes, only the queries actually affected are recomputed.

## Why

Without Salsa, an analysis pipeline (parse → extract → aggregate)
re-runs everything on every invocation. With Salsa:

- Pure functions become `Query`s that cache automatically
- Dependencies are captured at runtime (no manual wiring)
- A change to one input invalidates only the queries that read it
- A no-op change (same value) doesn't invalidate anything
- A derived query whose value doesn't change doesn't propagate (red/green)

For codegraph at Sentinel scale: re-analyzing on a 1-file change drops
from 7s to <1s once everything is migrated.

## Quick start

```ts
import { Database, input, derived } from '@liby-tools/salsa'

const db = new Database()

// Inputs : set externally.
const fileContent = input<string, string>(db, 'fileContent')

// Derived : pure function of other queries.
const wordCount = derived<string, number>(db, 'wordCount',
  (path) => fileContent.get(path).split(/\s+/).length,
)

fileContent.set('a.txt', 'hello world')
wordCount.get('a.txt')                     // 2 (computed)
wordCount.get('a.txt')                     // 2 (cached, hit)

fileContent.set('a.txt', 'hello big world')
wordCount.get('a.txt')                     // 3 (recomputed)

fileContent.set('a.txt', 'hello big world') // same content
wordCount.get('a.txt')                     // 3 (still cached — no-op write)
```

## Semantics

A `Database` carries a monotonic **revision** counter. Each `input.set`
bumps the revision. Each cell records:

- `value` — the cached result
- `deps` — list of (queryId, key, seenRevision) tuples
- `computedAt` — revision when the function ran
- `verifiedAt` — revision at which we last confirmed the cell is valid
- `changedAt` — revision when the value last actually changed

On `derived.get(key)`:

1. **Fast path** — if `cell.verifiedAt == currentRevision`, return cached.
2. **Slow path** — for each dep, deep-verify recursively. If all deps
   have `changedAt <= computedAt`, the cell is still valid: bump
   `verifiedAt`, return cached.
3. **Recompute** — run the function, capture new deps, build a new cell.
   If the new value equals the old, keep `changedAt` from before
   (red/green optimization that propagates "no change" downstream).

## Determinism

- Pure-TS, zero binary, zero JVM
- Deterministic key encoding (`s\0...` / `n\0...` / `t\1...`)
- Reset (`db.reset()`) is a clean slate
- Across reruns of the same operations on the same DB, observable
  behavior is identical

## What this implementation does NOT do

- No mutual recursion / fixed-point iteration. Cycles throw `SalsaError`.
- No async queries. Functions must be sync.
- No multi-database query sharing. A query is bound to one DB.
- No durability levels (Salsa-rs has them; we don't need them yet).
- No GC of stale cells. They live until `db.reset()`.

These are deliberate non-features — the runtime stays under 800 lines
and covers 100% of codegraph's needs. Adding any of them is a future
breaking change behind a major version bump.

## API

### `new Database()`

Create a new database. Each Database is independent — tests use one
per test, production uses a single long-lived one.

### `input<K, V>(db, id): InputQuery<K, V>`

Declare an input query. Returns:
- `get(key)` — read; throws if `set` was never called
- `set(key, value)` — write; bumps the revision (or no-ops if value is `Object.is`-equal)
- `has(key)` — was it ever set?

### `derived<K, V>(db, id, fn): DerivedQuery<K, V>`

Declare a derived query. `fn(key)` is the pure function — calls to
other `.get()` inside `fn` become tracked dependencies.

- `get(key)` — read; computes if needed, otherwise cached
- `peek(key)` — return the cached `Cell` (or `undefined`) for inspection

### Stats

`db.stats()` returns:

```ts
{
  revision: number
  totalCells: number
  hits: { [queryId: string]: number }
  misses: { [queryId: string]: number }
}
```

`hits` count cache reuses; `misses` count function executions.

## Errors

All errors extend `SalsaError` with stable `code`:

- `query.duplicateId` — two `input`/`derived` calls with the same id
- `input.unset` — read before write
- `input.setInsideQuery` — `.set()` called from a derived function
- `cycle` — a query depends on itself directly or transitively
- `key.notFinite` / `key.invalidType` — invalid key in `get`/`set`

## Testing

```bash
cd packages/salsa
npx vitest run
```

28 tests cover basic semantics, invalidation, red/green optimization,
cycle detection, and end-to-end use cases (codegraph-like file graph).

## Roadmap

This package is the **runtime** only. Migration of @liby-tools/codegraph to
use it (parseFile, importsOf, every detector as a query) is in
progressive sprints. Cf. ADR-022 + the Sprint 2-4 commits in
codegraph-toolkit.
