# @liby-tools/invariants-postgres-ts

Standard Datalog invariants for **TypeScript + Postgres** projects, drop-in for [`codegraph-toolkit`](https://github.com/Mwarfy/codegraph-toolkit).

Twenty invariants, all 100% portable across TS/Postgres projects:

| Invariant | What it catches |
|---|---|
| `cycles-no-new` | New non-gated import cycles (Tarjan SCC). Ratchet on `cycleId`. |
| `sql-fk-needs-index` | Foreign keys without index on source column (CASCADE = full scan). Ratchet on `(table, col)`. |
| `sql-table-needs-pk` | Tables without PRIMARY KEY (replication / ORM / dedup break). Ratchet on table name. |
| `sql-timestamp-needs-tz` | `TIMESTAMP` without time zone (multi-region bug). Ratchet on `(table, col)`. |
| `sql-orphan-fk` | Foreign keys pointing to non-existent tables (refactor reliquats). Ratchet on `(table, col)`. |
| `no-eval` | `eval(...)` and `new Function(...)` (RCE vector). Ratchet on `(file, kind)`. |
| `no-hardcoded-secret` | Hardcoded API keys / tokens / credentials in source (regex + entropy). Ratchet on `(file, line)`. |
| `no-boolean-positional-param` | Boolean trap (Sonar S2301) — prefer options object. Ratchet on `(file, name)`. |
| `no-identical-subexpressions` | `a OP a` where OP is logical/equality/comparison (Sonar S1764, copy-paste detection). Ratchet on `(file, line)`. |
| `no-return-then-else` | `if (cond) { return X } else { Y }` — flatten suggestion (Sonar S1126). Ratchet on `(file, line)`. |
| `no-switch-fallthrough` | `case X: doStuff()` without break/return/throw (gcc -Wimplicit-fallthrough). Ratchet on `(file, line)`. |
| `no-floating-promise` | Async function called without await/then/catch (rustc unused_must_use, ESLint no-floating-promises). Ratchet on `(file, line)`. |
| `no-deprecated-usage` | Call-sites of `@deprecated` symbols (Go SA1019, Pascal H2061, Java @Deprecated). Ratchet on `(file, line)`. |
| `no-new-articulation-point` | Hidden architectural hubs — files whose removal would disconnect the import graph (Tarjan O(V+E)). Ratchet on `file`. |
| `sql-naming-convention` | snake_case for tables/columns, `_at` for timestamps, `_id` for FKs (Codd / Postgres style). Ratchet on `(file, line, kind)`. |
| `sql-migration-order` | FK forward-references — migration declares FK before target table is created (topological sort). Ratchet on `(file, line)`. |
| `no-switch-empty-or-no-default` | switch without default or empty switch (MISRA 16.6 — silent behavior on unexpected values). Ratchet on `(file, line)`. |
| `no-controlling-expression-constant` | `if (true)`, `if (X && true)` and similar (MISRA 14.3, ESLint no-constant-condition). Ratchet on `(file, line)`. |
| `sql-audit-columns` | Business-critical tables (`*_events`, `orders`, `payments`, ...) must have `created_at` (and `updated_at` if mutable). Audit trail discipline. Ratchet on `(table, kind)`. |
| `no-resource-imbalance` | acquire/release counts mismatch in same function (lock/unlock, setInterval/clearInterval, etc.) — Reed-Solomon-style parity. Ratchet on `(file, symbol)`. |

## Why these two

These rules survived the test of being lifted from a real production codebase (Sentinel) — they detect drift that costs real time when missed:

- **Cycles** : silent architectural decay. A new import cycle compiles fine, breaks reasoning later. Once you commit it, removing it costs a refactor.
- **FK index** : silent perf disaster. `DELETE CASCADE` on an unindexed FK turns into N full scans. The first time you notice is the first prod incident.

Both are deterministic AST + DDL extraction, no LLM, no runtime cost.

## Setup

### Option A : via `adr-toolkit init` (recommended)

```bash
npx @liby-tools/adr-toolkit init --with-invariants postgres
```

This:
1. Adds `@liby-tools/invariants-postgres-ts` to `devDependencies`
2. Copies the `.dl` rules into `<your-project>/invariants/`
3. Wires the generic test runner

### Option B : manual

```bash
npm install --save-dev @liby-tools/invariants-postgres-ts
mkdir -p invariants
cp node_modules/@liby-tools/invariants-postgres-ts/invariants/cycles-no-new.dl invariants/
cp node_modules/@liby-tools/invariants-postgres-ts/invariants/sql-fk-needs-index.dl invariants/
```

If your project doesn't yet have an `invariants/schema.dl`, also copy `schema-subset.dl` and rename it `schema.dl`. If you already have one, ensure it declares the relations the rules need (`CycleNode`, `SqlFkWithoutIndex`, `SqlForeignKey`) — otherwise extend it.

Then add a generic test that runs all `.dl` against `.codegraph/facts/`. See your project's existing pattern (e.g. `tests/unit/datalog-invariants.test.ts`).

## How it works

Both rules consume facts emitted by `codegraph analyze` from the toolkit. The data flow:

```
your code → codegraph analyze → .codegraph/facts/CycleNode.facts
                              → .codegraph/facts/SqlFkWithoutIndex.facts
                              → .codegraph/facts/SqlForeignKey.facts
                                       ↓
                          Datalog runtime evaluates rules
                                       ↓
                          Violation(adr, file, line, msg)
                                       ↓
                          Fail tests at pre-commit / CI
```

No external Datalog binary — uses [`@liby-tools/datalog`](https://www.npmjs.com/package/@liby-tools/datalog) (pure TS, no JVM, no Soufflé).

---

## Invariant details

### `cycles-no-new`

**Rule.** No file may participate in a non-gated import cycle. A cycle is "gated" if at least one file in the cycle wraps the cycle-closing import in a runtime gate (env var, feature flag, dynamic conditional `import()`).

**Why.** Once a cycle exists, it gets harder to remove (adding new code that depends on the cycle locks it in). Detect at the moment of introduction, not after months.

**How to fix.** Either:
1. Extract a shared module that both files depend on (preferred).
2. Replace one of the imports with a runtime-gated dynamic import — the cycle becomes "gated" and is auto-allowed.

**Ratchet.** If your project has existing cycles, grandfather them by `cycleId` (stable hash of cycle nodes):

```datalog
.decl CyclesGrandfathered(cycleId: symbol)
CyclesGrandfathered("c-abc123def").
```

Find the cycleId via `npx codegraph analyze` then grep `.codegraph/facts/CycleNode.facts`.

---

### `sql-fk-needs-index`

**Rule.** Every foreign key must have an index on its source column.

**Why.** Without index:
- `DELETE FROM parent WHERE id = X` triggers a full scan of `child` for each cascaded delete (lock contention, timeouts).
- `SELECT * FROM child WHERE parent_id = X` is O(N) instead of O(log N).
- Replication lag spikes when a DELETE cascades over millions of rows.

The first time you notice is the first time prod stalls. Catch it at the migration commit.

**How to fix.** Add the index in the same migration that adds the FK:

```sql
ALTER TABLE invoices ADD COLUMN order_id INT REFERENCES orders(id);
CREATE INDEX idx_invoices_order_id ON invoices(order_id);
```

For Drizzle:

```ts
export const invoices = pgTable('invoices', {
  orderId: integer('order_id').references(() => orders.id),
}, (t) => [
  index('idx_invoices_order_id').on(t.orderId),
])
```

**Ratchet.** Existing unindexed FKs — grandfather by `(table, col)`:

```datalog
SqlFkIndexGrandfathered("orders", "customer_id").
SqlFkIndexGrandfathered("invoices", "order_id").
```

Migrate one at a time: add the index in a migration, then remove the grandfather line in the same PR.

---

## Compatibility

- `@liby-tools/codegraph` ≥ 0.2.0 (emits `SqlFkWithoutIndex` + `CycleNode` facts)
- `@liby-tools/datalog` ≥ 0.2.0 (Datalog runtime)
- TypeScript projects, raw SQL migrations OR Drizzle ORM. Prisma not yet supported.

## Adding more invariants

Open an issue with the rule pattern + a real-world repro. Strong signals for inclusion:
- Generic across TS/Postgres projects (no codebase-specific hardcodes)
- Detected at AST/DDL level (no runtime, no LLM)
- Ratchet-friendly (existing violations can be grandfathered without breaking the build)

## License

MIT.
