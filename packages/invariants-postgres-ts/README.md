# @liby-tools/invariants-postgres-ts

Standard Datalog invariants for **TypeScript + Postgres** projects, drop-in for [`codegraph-toolkit`](https://github.com/Mwarfy/codegraph-toolkit).

**91 rules** : 20 mono-relation + 56 composites multi-relation (Tiers 7-18) + 8 CWE security + 7 cross-discipline mathématique. 100% portable across TS/Postgres projects.

Architecture **multi-dir** (depuis v0.5.0) : tu consomme ces rules canoniques **sans les copier**. Ton projet local garde uniquement ses ADR-specific rules + ses grandfather facts. Source unique = ce package, zéro drift.

```typescript
import { runFromDirs } from '@liby-tools/datalog'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkgJson = require.resolve('@liby-tools/invariants-postgres-ts/package.json')
const canonicalRules = path.join(path.dirname(pkgJson), 'invariants')

await runFromDirs({
  rulesDir: [canonicalRules, 'invariants'],  // canonical + project local
  factsDir: '.codegraph/facts',
})
```

## 20 mono-relation invariants

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

## 56 composites multi-relation (Tiers 7-18)

Ces rules cross-référencent 2+ relations pour capturer des signaux qu'aucune rule isolée ne voit. Highlights ci-dessous ; voir `invariants/composite-*.dl` pour la liste complète des 56 rules.

| Composite | What it catches |
|---|---|
| `composite-eval-in-http-route` | `eval()` + `EntryPoint(http-route)` in same file = RCE chemin court via `req.body`. Ratchet on `(file, line)`. |
| `composite-fk-chain-without-index` | Transitive FK chain `A → B → C` where source has no index = pathological CASCADE on entire path. Ratchet on `(table, col)`. |
| `composite-high-critical-untested` | `ArticulationPoint ∧ TruthPointWriter ∧ ¬TestedFile` = max blast radius without safety net. Ratchet on `file`. |
| `composite-double-drift-wrapper-boolean` | `wrapper-superfluous` drift signal + `BooleanParam` on same function = double dette agentique, supprimer le wrapper résout les 2. Ratchet on `(file, name)`. |
| `composite-tainted-flow` | Taint analysis lite (CodeQL inspiration) — http-route entry → SymbolCallEdge transitif → TaintSink (sql/eval/exec/fs/http/html) sans SanitizerCall dans le file source ou sink. Ratchet on `(sinkFile, sinkLine)`. |
| `composite-tainted-var-to-sink` | Variable tracking lite — tainted var (req.body/process.env/etc.) passée DIRECTEMENT à un sink à la même ligne (Tier 11). Ratchet on `(file, line)`. |
| `composite-todo-in-truth-point-writer` | TODO sans owner dans un fichier qui écrit un truth-point business — dette qui peut affecter le SSOT. |
| `composite-boolean-trap-untested` | Boolean positionnel + fichier sans test direct — double risque. |
| `composite-cross-fn-sql-injection` | Multi-hop taint cross-fonction → SQL sink (Tier 14). |
| `composite-cross-fn-cmd-injection` | idem pour child_process.exec/spawn (Tier 14). |
| `composite-cross-fn-path-traversal` | idem pour fs.readFile/writeFile (Tier 14). |
| `composite-event-payload-cross-block-taint` | Event payload non-sanitized cross-block boundary (Tier 18). |
| `composite-cyclomatic-bomb` | McCabe cyclomatic > 30 (Tier 15). |
| `composite-cognitive-bomb` | SonarQube cognitive complexity > 25 (Tier 15). |
| `composite-god-function` | Long function (>200 LOC) ∧ articulation point ∧ untested. |
| `composite-fat-table`, `composite-god-table` | SQL tables avec ≥20 / ≥30 colonnes. |
| `composite-hot-allocation` | Allocation dans loop > seuil (perf hotspot). |
| `composite-await-in-loop` | `await` séquentiel dans loop (préférer Promise.all). |
| `composite-silent-error` | Empty catch block — perte d'erreurs silencieuse. |
| `composite-redos` | Regex avec nested quantifiers (catastrophic backtracking). |
| `composite-cors-misconfig`, `composite-disabling-cert-validation`, `composite-insecure-randomness` | Security misconfig variées. |

## 8 CWE rules — taxonomie sécurité MITRE

| CWE | What it catches |
|---|---|
| `cwe-022-path-traversal` | fs.readFile/writeFile avec user input sans path.normalize/resolve. |
| `cwe-078-command-injection` | child_process.exec avec user input sans shell escape. |
| `cwe-079-xss` | innerHTML/document.write avec user input non-escapé. |
| `cwe-089-sql-injection` | db.query avec user input sans parameterized query. |
| `cwe-327-weak-crypto` | MD5/SHA1/DES utilisés (préférer SHA256+/AES). |
| `cwe-502-deserialization` | JSON.parse/yaml.load sur user input non-validé. |
| `cwe-918-ssrf` | fetch/axios avec user input URL sans validation. |
| `cwe-1321-prototype-pollution` | `Object.assign(target, source)` avec user-controlled source. |

## 7 cross-discipline composites — disciplines mathématiques classiques

Première fois portées dans un analyzer TS/JS à notre connaissance. Détail : [`docs/CROSS-DISCIPLINE-METRICS.md`](../../docs/CROSS-DISCIPLINE-METRICS.md).

| Composite | Discipline | Théorème | Threshold |
|---|---|---|---|
| `composite-spectral-bottleneck` | Théorie spectrale des graphes | Fiedler 1973 — λ₂ Laplacien, Cheeger inequality | λ₂ × 1000 < 50 |
| `composite-god-dispatcher` | Théorie de l'information | Shannon 1948 — H(X) = -Σ p log p | entropy × 1000 > 4000 ∧ ≥10 callees |
| `composite-copy-paste-fork` | Théorie des codes | Hamming 1950 — distance entre vecteurs | Hamming = 0 entre 2 fichiers |
| `composite-structural-cycle-persistent` | TDA persistent homology | Edelsbrunner-Letscher-Zomorodian 2002 | persistence > 50% snapshots |
| `composite-chaos-amplifier` | Systèmes dynamiques | Lyapunov 1892 — divergence exponentielle | λ × 1000 > 2000 |
| `composite-package-coupling` | Théorie des flots | Ford-Fulkerson 1956 — min-cut/max-flow | minCut > 5 |
| `composite-information-hub-untested` | Information bottleneck | Tishby 1999 — I(input;output) | score × 1000 > 25000 |

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
2. Wires the generic test runner with **multi-dir loader** (consume canonical rules + project-local grandfathers)
3. Scaffold `<your-project>/invariants/` avec un `*-grandfathers.dl` vide

### Option B : multi-dir loader (recommended depuis v0.5.0)

Ne copie PAS les rules. Consomme via npm + multi-dir :

```bash
npm install --save-dev @liby-tools/invariants-postgres-ts @liby-tools/datalog
mkdir -p invariants
# Optionnel : <your-project>/invariants/adr-NNN.dl pour rules ADR-specific
# Optionnel : <your-project>/invariants/<project>-grandfathers.dl pour ratchets
```

Test runner :

```typescript
import { runFromDirs } from '@liby-tools/datalog'
import { createRequire } from 'node:module'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
const pkgJson = require.resolve('@liby-tools/invariants-postgres-ts/package.json')
const canonicalRules = path.join(path.dirname(pkgJson), 'invariants')
const projectRules = path.join(__dirname, '../../invariants')

const { result } = await runFromDirs({
  rulesDir: [canonicalRules, projectRules],
  factsDir: '.codegraph/facts',
  recordProofsFor: ['Violation'],
  allowRecursion: true,
})
```

**Avantage** : zéro duplication. Source unique = ce package. Update toolkit → tu hérites des nouvelles rules sans copier. Tes grandfathers projet vivent dans le ratchet pattern (facts `XGrandfathered("path/to/file")` qui s'injectent dans les rules canoniques).

### Option C : copy-paste rules (legacy, pré-v0.5.0)

```bash
npm install --save-dev @liby-tools/invariants-postgres-ts
mkdir -p invariants
cp node_modules/@liby-tools/invariants-postgres-ts/invariants/cycles-no-new.dl invariants/
cp node_modules/@liby-tools/invariants-postgres-ts/invariants/sql-fk-needs-index.dl invariants/
```

Si ton projet n'a pas encore d'`invariants/schema.dl`, copie aussi `schema-subset.dl` et renomme-le `schema.dl`.

**Inconvénient** : drift potentiel toolkit→projet non détecté. Préférer Option B.

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

- `@liby-tools/codegraph` ≥ 0.2.0 (émet 74 relations Datalog, dont 14 cross-discipline metrics)
- `@liby-tools/datalog` ≥ 0.2.0 (runtime, multi-dir loader depuis v0.5.0)
- TypeScript projects, raw SQL migrations OR Drizzle ORM. Prisma pas encore supporté (ETA v0.6.0).

## Adding more invariants

Open an issue with the rule pattern + a real-world repro. Strong signals for inclusion:
- Generic across TS/Postgres projects (no codebase-specific hardcodes)
- Detected at AST/DDL level (no runtime, no LLM)
- Ratchet-friendly (existing violations can be grandfathered without breaking the build)

## License

MIT.
