# codegraph-toolkit

> **Rends ton projet TS lisible à un agent IA. Détecte les invariants architecturaux. Joint statique × dynamique × Salsa incremental en sub-seconde.**

> **Status : v0.6 publié sur npm.** Dogfooded sur 1 projet réel ([Sentinel](https://github.com/Mwarfy/sentinel)) + le toolkit lui-même.
> Les heuristiques mathématiques (Lyapunov, Information Bottleneck, TDA persistent
> homology, Granger) sont **inspirées** de leurs références scientifiques mais
> implémentées comme heuristiques scalaires, **pas comme les vrais objets
> mathématiques** (cf. disclaimer dans chaque fichier `extractors/*.ts`).

```bash
# 1. Install dans ton projet
npm install --save-dev @liby-tools/codegraph @liby-tools/adr-toolkit \
                       @liby-tools/datalog @liby-tools/salsa \
                       @liby-tools/invariants-postgres-ts \
                       @liby-tools/runtime-graph

# 2. Init complet (91 rules Datalog + hooks Claude + git hooks)
npx adr-toolkit init --with-invariants postgres --with-claude-hooks

# 3. Press-button : statique + dynamique + cross-cut composite
npx codegraph analyze              # statique → .codegraph/facts/
npx liby-runtime-graph run         # dynamique → .codegraph/facts-runtime/
npx codegraph cross-check          # composite : DEAD_HANDLER, DEAD_ROUTE, etc.
```

C'est tout. Le toolkit détecte ta stack (Express/Hono/Next, raw SQL/Drizzle, mono ou monorepo), génère la config, installe **91 rules Datalog** (20 mono-relation + 56 composites + 8 CWE + 7 heuristiques inspirées de cross-discipline math), wire les hooks git + Claude Code (PreToolUse + PostToolUse avec **live Datalog gate à 70ms par edit**), et te livre une mental map déterministe régénérée à chaque commit.

**74 relations Datalog émises** depuis 50+ extracteurs. Implémentations
**rigoureuses** : graph theory (PageRank, Tarjan SCC, articulation points),
théorie spectrale (Fiedler λ₂ via power iteration sur Laplacien — déterministe
via van der Corput init), théorie des codes (Hamming distance), théorie des
flots (Ford-Fulkerson min-cut).

**Heuristiques inspirées** (PAS les vrais objets mathématiques — cf.
disclaimers dans chaque fichier `extractors/*.ts`) : "Lyapunov-cochange"
= log(avg co_change), "Information Bottleneck" = log fan-in × log fan-out,
"persistent cycles" = fréquence temporelle, "Granger" = lag-1 conditional
probability sur commits. Utiles comme signal heuristique, pas comme
science formelle.

---

## Packages

Le toolkit est un monorepo. Le **noyau publishable** (4 packages) :

| Package | Version | Rôle | Status |
|---|---|---|---|
| [`@liby-tools/codegraph`](packages/codegraph/) | `0.6.0` | Static analyzer + Datalog runner γ + Salsa incremental + composite cross-cut | core |
| [`@liby-tools/adr-toolkit`](packages/adr-toolkit/) | `0.3.0` | ADR governance (anchors, asserts ts-morph, boot brief, hooks) | core |
| [`@liby-tools/datalog`](packages/datalog/) | `0.3.0` | Pure-TS Datalog interpreter — zero binary, multi-dir loader | core |
| [`@liby-tools/salsa`](packages/salsa/) | `0.3.0` | Salsa-style incremental computation runtime (peer dep de codegraph) | core |
| [`@liby-tools/invariants-postgres-ts`](packages/invariants-postgres-ts/) | `0.1.0` | 78 composite Datalog rules pour stack TS+Postgres | published |
| [`@liby-tools/runtime-graph`](packages/runtime-graph/) | `0.1.0-alpha.5` | OTel runtime capture + bridge Salsa pour cross-cut composite | published |

Les **packages expérimentaux** :

| Package | Status | Pourquoi |
|---|---|---|
| [`@liby-tools/codegraph-mcp`](packages/codegraph-mcp/) | experimental | demande client MCP (Claude Code). Tests faibles (2). |

---

## Pourquoi ça existe

Sans infra partagée, chaque projet TS recommence de zéro la cartographie + la gouvernance docs↔code. L'agent IA dérive ("où est géré le trust ?"), les invariants implicites se perdent ("on avait dit pas de cycles d'import gated"), le projet meurt après 3 mois.

Avec : la mental map est rendue **déterministe** (zéro LLM dans la chaîne de synthèse), les invariants sont **exécutables** (Datalog rules, pas prose), les régressions sont **bloquées au pre-commit**, pas découvertes en prod 3 semaines plus tard.

C'est une **infra de concentration**, pas une infra de code.

---

## Ce que tu obtiens (concret)

### 1. Mental map auto-régénérée

À chaque commit : `CLAUDE-CONTEXT.md` (le boot brief) + `synopsis-level{1,2,3}.md` (Containers/Components/Files) + `MAP.md` (graphe d'imports). Ton agent IA lit ça en début de session — il sait quels fichiers sont des hubs, quels ADRs sont actifs, quelles cycles existent.

### 2. ADRs vivants liés au code

Tu poses `// ADR-018` au top d'un fichier. Le toolkit régénère automatiquement la section `## Anchored in` de l'ADR. Renames absorbés gratuitement (le marqueur suit le code). Les claims sémantiques (`fonction X existe`, `Y est de type Set<string>`) deviennent **exécutables via ts-morph asserts**.

### 3. 91 rules Datalog ratchetées (package `@liby-tools/invariants-postgres-ts`)

Tu écris une règle déclarative (`fk-needs-index.dl`), elle s'exécute contre les facts émis par codegraph (74 relations émises : `SqlForeignKey`, `EvalCall`, `EntryPoint`, `ArticulationPoint`, `TruthPointWriter`, `LyapunovMetric`, `InformationBottleneck`, etc.). La rule attrape **toute nouvelle violation** sans bloquer sur l'existant (pattern ratchet).

**20 invariants mono-relation** :
- **Architecture** : `cycles-no-new`, `no-new-articulation-point` (Tarjan O(V+E) — révèle les hubs cachés)
- **SQL/Postgres** : `sql-fk-needs-index`, `sql-table-needs-pk`, `sql-timestamp-needs-tz`, `sql-orphan-fk`, `sql-naming-convention`, `sql-migration-order`, `sql-audit-columns`
- **Sécurité** : `no-eval`, `no-hardcoded-secret` (regex + Shannon entropy)
- **Code quality** : `no-boolean-positional-param` (Sonar S2301), `no-identical-subexpressions` (S1764), `no-return-then-else` (S1126), `no-switch-fallthrough` (gcc -Wimplicit-fallthrough), `no-switch-empty-or-no-default` (MISRA 16.6), `no-controlling-expression-constant` (MISRA 14.3)
- **JS-specific** : `no-floating-promise` (rustc unused_must_use porté JS), `no-deprecated-usage` (Go SA1019), `no-resource-imbalance` (Reed-Solomon parity acquire/release)

**56 composites multi-relation** (Tiers 7-18) — patterns qu'aucune rule isolée ne capture. Exemples :
- `composite-eval-in-http-route` — `EvalCall` ∩ `EntryPoint(http-route)` = RCE chemin court
- `composite-fk-chain-without-index` — closure transitive `A→B→C` avec maillon faible
- `composite-high-critical-untested` — `ArticulationPoint ∩ TruthPointWriter ∩ ¬TestedFile` = blast radius max sans safety net
- `composite-cross-fn-sql-injection` — taint multi-hop `req.body → param N → SQL sink` sans sanitizer (CodeQL inspiration)
- `composite-event-payload-cross-block-taint` — event payload non-sanitized cross-block boundary
- `composite-cyclomatic-bomb`, `composite-cognitive-bomb` — McCabe + SonarQube cognitive
- `composite-god-dispatcher` — Shannon H(callees) > 4 bits ∧ ≥10 callees

**8 CWE rules** — taxonomie sécurité MITRE :
- `cwe-022` (Path Traversal), `cwe-078` (Command Injection), `cwe-079` (XSS), `cwe-089` (SQL Injection), `cwe-327` (Weak Crypto), `cwe-502` (Unsafe Deserialization), `cwe-918` (SSRF), `cwe-1321` (Prototype Pollution)

**7 cross-discipline composites** — disciplines mathématiques classiques portées dans un analyzer TS/JS :
- `composite-spectral-bottleneck` — Fiedler λ₂ × 1000 < 50 (théorie spectrale, Cheeger inequality)
- `composite-god-dispatcher` — Shannon entropy distribution callees (théorie de l'information)
- `composite-copy-paste-fork` — Hamming = 0 entre 2 signatures (théorie des codes)
- `composite-structural-cycle-persistent` — TDA persistent homology > 50% des snapshots (Edelsbrunner-Letscher-Zomorodian 2002)
- `composite-chaos-amplifier` — Lyapunov exponent λ × 1000 > 2000 (systèmes dynamiques chaos)
- `composite-package-coupling` — Ford-Fulkerson min-cut > 5 entre 2 packages (théorie des flots)
- `composite-information-hub-untested` — Tishby Information Bottleneck score > 25 (I(input;output) approximé)

Détail : [`docs/CROSS-DISCIPLINE-METRICS.md`](docs/CROSS-DISCIPLINE-METRICS.md).

Validation Sentinel : 68 violations totales (toutes grandfathered = baseline historique stable), **plusieurs vrais positifs HIGH-CRITICAL révélés par les composites** que aucune rule isolée ne voyait.

#### Multi-dir loader (consume canonical + project-local)

Depuis v0.5.0, `runFromDirs` accepte `rulesDir: string[]` permettant aux projets consumers de séparer :

```typescript
import { runFromDirs } from '@liby-tools/datalog'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkgJson = require.resolve('@liby-tools/invariants-postgres-ts/package.json')
const canonical = path.join(path.dirname(pkgJson), 'invariants')

await runFromDirs({
  rulesDir: [canonical, 'sentinel-core/invariants'],  // canonical + project local
  factsDir: '.codegraph/facts',
})
```

Le projet local garde uniquement :
1. Ses `adr-NNN.dl` (rules ADR-specific projet)
2. Un `*-grandfathers.dl` consolidé (les facts ratchet `XGrandfathered("project/path")`)

Plus de duplication des 88 rules universelles. La source unique = le toolkit. Les grandfathers projet sont des facts injectés dans les rules canoniques via le ratchet pattern.

### 4. 14 MCP tools pour l'agent IA

Le serveur MCP `codegraph-mcp` expose le snapshot comme outils queryable. Ton agent peut demander à la volée :

| Tool | Quand l'utiliser |
|---|---|
| `codegraph_context(file)` | Avant d'éditer un fichier — voir hub status, cycles, truth-points, dette |
| `codegraph_who_imports(file)` | Impact analysis FILE-level (≠ LSP find_references symbol-level) |
| `codegraph_who_calls(symbol)` | Call sites d'une fonction **avec types observés** (zod, etc.) |
| `codegraph_truth_point_for(file)` | Participation aux concepts SSOT (writers/readers/mirrors) |
| `codegraph_co_changed(file)` | Fichiers souvent co-modifiés (signal coupling non-codifié) |
| `codegraph_affected(files)` | BFS reverse — tests à runner après une modif |
| `codegraph_changes_since()` | Diff structurel entre snapshot live et dernier commit |
| `codegraph_extract_candidates(file)` | Fonctions à extraire en priorité (loc × fanIn) |
| `codegraph_recent(file)` | Git archaeology : commits récents + top contributor |
| `codegraph_uncovered()` | Fichiers sans test rankés par criticité |
| `codegraph_datalog_query(rule)` | **Datalog ad hoc** sur les 37 facts émis (transitivité, anti-jointure, agrégation) |
| `codegraph_drift(file?)` | Drift agentique : excessive params, wrappers superflus, TODO sans owner, deep nesting, empty catch |
| `codegraph_memory_recall(scope?)` | **Mémoire inter-sessions** : false-positives marqués, decisions, incidents |
| `codegraph_memory_mark(kind, fp, reason)` | Persiste un FP/decision/incident — survit aux sessions |

### 5. Pipeline composite statique × dynamique × Salsa incremental (ADR-026)

**v0.6.0 — pipeline unifié warm path < 500ms sur Sentinel (220 fichiers TS).**

Trois sources, une jointure Datalog, cache à tous les niveaux :

```
┌──────────────────────┐    ┌──────────────────────┐
│  STATIQUE            │    │  DYNAMIQUE           │
│  codegraph analyze   │    │  liby-runtime-graph  │
│  + ts-morph AST walk │    │  + OpenTelemetry     │
│  + Datalog runner γ  │    │  + 7 facts runtime   │
│  + Salsa cells per-fn│    │  + push Salsa cells  │
└──────────┬───────────┘    └──────────┬───────────┘
           ▼                           ▼
   .codegraph/facts/         .codegraph/facts-runtime/
           │                           │
           └────────────┬──────────────┘
                        ▼
               codegraph cross-check
               (composite-runner cache)
                        ▼
                Violations cross-cut
```

Bench Sentinel (`useDatalog: true, incremental: true`) :

| Mode | Total | Runner Datalog |
|---|---|---|
| Legacy v0.4 | 16.6s | — |
| Cold incremental | 16.2s | 3.7s |
| **Warm incremental** | **400ms** | **20ms** |
| | **41× speedup** | **184× speedup** |

Composite rules cross-cut typiques (charger via `cross-check`) :

- `DEAD_HANDLER` — exporté statique mais jamais touché runtime
- `DEAD_ROUTE` — route HTTP déclarée mais 0 trafic observé
- `RUNTIME_DRIFT` — symbol référencé statique jamais touché à runtime
- `HOT_PATH_UNTESTED` — fonction haute fréquence runtime sans tests
- `STALE_QUERY` — table avec writers déclarés mais 0 activity DB
- `COMPOSITE_CYCLE_RUNTIME_CONFIRMED` — cycle statique + edge bidirectionnel runtime
- `COMPOSITE_HUB_BOTTLENECK` — fichier hub statique + p95 runtime > 500ms

Activable end-to-end :

```bash
codegraph analyze                                   # statique
liby-runtime-graph run --duration 60                # dynamique
codegraph cross-check rules-cross-cut/              # composite
```

Ou en mode programmatique pour watcher unifié :

```ts
import { analyze, setRuntimeFacts, runCompositeRules } from '@liby-tools/codegraph'
import { aggregateSpans, pushFactsToSalsa } from '@liby-tools/runtime-graph'

await analyze(cfg, { useDatalog: true, incremental: true })  // 400ms warm
const snapshot = aggregateSpans(spans, runMeta)
await pushFactsToSalsa(snapshot)                              // bridge runtime → codegraph
const r = runCompositeRules({ rulesDl, staticFactsByRelation })
// r.stats.cacheHit warm = 0.02ms (80× cache miss)
```

### 6. Watch mode + hook PostToolUse + **Live Datalog gate** (~70ms par edit)

`codegraph watch &` maintient `.codegraph/snapshot-live.json` à jour à chaque save (~50ms warm via cache Salsa). Le hook PostToolUse Claude Code lit ce snapshot live et injecte le contexte structurel **plus** :

- **Live Datalog** (Tier 8) — exécute les 91 rules contre les facts live à chaque edit, affiche uniquement les **nouvelles violations** vs baseline post-commit. Latence mesurée 70ms wall clock. Si je m'apprête à introduire un FK chain pathologique, un eval dans un http handler, ou faire devenir un fichier HIGH-CRITICAL-UNTESTED, je le sais immédiatement — pas en bloc au pre-commit
- **Drift signals** (Tier 4) — patterns que l'agent crée plus que les humains, par fichier touché
- **Mémoire inter-sessions** (Tier 3) — décisions / FP / incidents marqués lors de sessions précédentes affichés quand le fichier est touché

Le résultat : l'agent voit l'impact structurel + les invariants violés + la mémoire historique AVANT chaque réponse.

### 7. Mémoire inter-sessions (Tier 3)

Store local `~/.codegraph-toolkit/memory/<projet>.json` qui survit aux sessions. 3 kinds : `false-positive`, `decision`, `incident`. Per-projet, slug stable, soft-validation au load.

```bash
codegraph memory mark false-positive "tp:items" "Drizzle FP — pas un truth-point business" --scope-file src/db/schema.ts
codegraph memory list
codegraph memory obsolete <id>
```

Sans mémoire, l'agent redécouvre chaque session ce que tu as déjà validé. Avec : il consulte avant de proposer, il marque au passage, la prochaine session bénéficie. Privacy : `recall()` retourne uniquement une projection scopée — jamais le dump complet via MCP.

### 8. Drift agentique (Tier 4)

5 patterns AST/regex déterministe que l'agent crée plus que les humains :

- `excessive-optional-params` — fonction avec >5 params optionnels (future-proof non demandé)
- `wrapper-superfluous` — function dont le body = single forward call (pas de transformation)
- `todo-no-owner` — TODO/FIXME sans `@user` ni `#issue`
- `deep-nesting` — pyramide if/for/while >5 niveaux
- `empty-catch-no-comment` — try/catch silencieux sans rationale

Convention exempt : `// drift-ok: <reason>` sur ligne précédente. Skip fichiers de test. Le but n'est pas de bloquer mais de **ralentir** l'agent au bon moment.

### 9. Stacks DB supportées (mêmes invariants partout)

Le pattern "**mêmes facts Datalog, plusieurs back-ends d'extraction**" :

| Stack | Source détectée | Tables détectées (exemple) |
|---|---|---|
| **Raw SQL** (migrations `.sql`) | `CREATE TABLE`, `REFERENCES`, `CREATE INDEX` | Sentinel : 113 tables, 13 FK sans index |
| **Drizzle ORM** | `pgTable(...)`, `references(() => ...)`, `index(...).on(...)` | Morovar : 7 tables, 1 FK sans index |
| **Prisma** | `schema.prisma` | (À venir, ~3-4h d'effort) |
| **TypeORM** | Decorators `@Entity()`/`@Column()` | (À venir) |

La rule Datalog `sql-fk-needs-index.dl` que tu écris **une seule fois** marche sur **tous** ces back-ends. Architecture testée bout-en-bout sur Sentinel + Morovar.

---

## Quickstart 30 secondes

```bash
# 1. Install dans ton projet (tous packages publiés sur npm)
npm install --save-dev @liby-tools/codegraph @liby-tools/adr-toolkit \
                       @liby-tools/datalog @liby-tools/salsa \
                       @liby-tools/invariants-postgres-ts \
                       @liby-tools/runtime-graph

# 2. Init complet (91 rules Datalog + hooks Claude + git hooks)
cd ton-projet
npx adr-toolkit init --with-invariants postgres --with-claude-hooks

# 3. Premier ADR
cp docs/adr/_TEMPLATE.md docs/adr/001-mon-invariant.md
# édite : Rule, Why, asserts si pertinent
# pose `// ADR-001` au top d'un fichier source

# 4. Régen + commit
npx adr-toolkit regen
npx codegraph analyze
npx adr-toolkit brief
git commit -am "feat: ADR-001"

# 5. (Optionnel — pipeline composite statique × dynamique)
npx liby-runtime-graph run --duration 60     # capture trafic OTel
npx codegraph cross-check                     # joint statique + runtime
```

À partir d'ici :
- **pre-commit** : `codegraph facts --regen` + `tsc` + 91 rules Datalog + ADR anchors regen + brief sync
- **post-commit** : `codegraph analyze` + brief regen + datalog baseline update
- **Edit/Write Claude** : PreToolUse (ADR check) + PostToolUse (HIGH-RISK + drift + mémoire + **live Datalog 70ms**)
- **Watch mode** (optionnel, recommandé) : `codegraph watch &` régen facts à chaque save (~50ms)
- **Cross-cut composite** : `codegraph cross-check` joint statique + dynamique → DEAD_HANDLER, HOT_PATH_UNTESTED, etc.

---

## Quickstart détaillé

### Étape 1 — Installer le toolkit (une fois par machine)

```bash
npm install -g @liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/codegraph-mcp
```

Expose `codegraph`, `adr-toolkit`, `codegraph-mcp` dans ton PATH.

**Mode dev** (contributeurs au toolkit, pour live-edit le source) :
```bash
curl -fsSL https://raw.githubusercontent.com/Mwarfy/codegraph-toolkit/master/install.sh | bash -s -- --dev
```
Clone dans `~/Documents/codegraph-toolkit`, build, `npm link --workspaces`.

### Étape 2 — Activer dans ton projet

```bash
cd ton-projet
npx adr-toolkit init --with-claude-settings
```

`init` :
1. Détecte ton **layout** (`simple` `src/`, `fullstack-monorepo` `backend/+frontend/`, `workspaces-monorepo` `apps/*`/`packages/*`)
2. Détecte ta **stack DB** (raw SQL migrations, Drizzle, Prisma) en scannant les `package.json` et dossiers communs
3. Scaffolde :
   - `.codegraph-toolkit.json` — config du toolkit
   - `codegraph.config.json` — config codegraph (include/exclude/detectors **+ detectorOptions activés selon stack détectée**)
   - `docs/adr/_TEMPLATE.md` + `INDEX.md` — modèle d'ADR
   - `scripts/git-hooks/{pre,post}-commit` + `adr-hook.sh` — hooks
   - `git config core.hooksPath` — active les hooks
   - `.claude/settings.json` — wire le hook Claude Code (avec `--with-claude-settings`)

Output typique sur un projet Drizzle :

```
Layout détecté : fullstack-monorepo
Created:
  + .codegraph-toolkit.json
  + codegraph.config.json
  + docs/adr/_TEMPLATE.md
  ...
Warnings:
  ⚠ Drizzle ORM détecté → drizzle-schema detector activé
  ⚠ Migrations .sql détectées → sql-schema detector activé
```

### Étape 3 — Premier ADR

```md
---
asserts:
  - symbol: "kernel/scheduler#inFlightBlocks"
    type: "Set<string>"
---

# ADR-018: Scheduler anti-double-execution

## Rule
> Un même blockId ne peut JAMAIS tick deux fois en parallèle.
> Le verrou `inFlightBlocks: Set<string>` protège `jobHandler`.

## Why
Race condition vue le 2026-03-12 : deux ticks BullMQ concurrents pour le même
block ont écrit deux jobs à la queue → double exécution.

## How to apply
- Avant chaque tick : `if (inFlightBlocks.has(id)) return`
- Après le tick : `inFlightBlocks.delete(id)` dans `finally`

## Anchored in
<!-- AUTO-GÉNÉRÉ — ne pas éditer -->
- `kernel/scheduler.ts`
```

Tu poses `// ADR-018` au top de `kernel/scheduler.ts`. À chaque commit :
- `regen` met à jour `## Anchored in` (les renames sont absorbés gratuitement)
- `check-asserts` vérifie que `inFlightBlocks` est toujours un `Set<string>`
- Si quelqu'un le renomme en `_inFlight`, le check pète

### Étape 4 — Premier invariant Datalog (optionnel mais puissant)

Crée `<rules-dir>/no-cycles.dl` :

```dl
// Bloque tout nouveau cycle d'import non-gated.
.decl CycleGrandfathered(file: symbol)
// (la dette historique va ici si tu en as)

Violation("CYCLES", File, 0,
  "fichier dans un cycle d'import non-gated") :-
    CycleNode(File, _, "false"),
    !CycleGrandfathered(File).
```

Le test générique `tests/unit/datalog-invariants.test.ts` (ajouté par `init`) exécute toutes les `.dl` contre les facts émis par codegraph. Tu écris la rule, le test la pète automatiquement quand un nouveau cycle apparaît.

### Étape 5 — Activer le watch mode (recommandé en dev)

```bash
npx codegraph watch &
```

Maintient `.codegraph/snapshot-live.json` à jour en temps réel (~50ms par save grâce au cache Salsa). Les MCP tools + hook PostToolUse lisent ce snapshot live au lieu du snapshot post-commit potentiellement obsolète.

---

## Layouts supportés

| Layout | Détection | Config générée |
|---|---|---|
| **Simple** | `src/` à la racine | `srcDirs: ["src"]`, tsconfig: `tsconfig.json` |
| **Fullstack monorepo** | `backend/src/` + `frontend/` | `srcDirs: ["backend/src", "shared/src", "frontend"]`, tsconfig: `backend/tsconfig.json` |
| **Workspaces monorepo** | `apps/*` ou `packages/*` | `srcDirs: ["apps", "packages"]` |
| **Flat** | Rien d'évident | Fallback minimal — ajuste `srcDirs` à la main |

---

## CLI reference

```bash
# Setup + maintenance ADR
adr-toolkit init [--with-claude-settings] [--with-invariants postgres] [--with-claude-hooks]
adr-toolkit regen [--check]
adr-toolkit linker <file>
adr-toolkit check-asserts [--json]
adr-toolkit brief
adr-toolkit install-hooks
adr-toolkit bootstrap [--max N] [--apply] [--mode auto|cli|sdk]

# Analysis + queries
codegraph analyze [-c <config>] [--map] [--no-save]
codegraph watch [--debounce 50]                # daemon mode (B2)
codegraph synopsis [snapshot] [--level 1|2|3]
codegraph orphans [snapshot]
codegraph exports [snapshot]
codegraph diff <prev> <new> [--md]             # for PR comments (B3)
codegraph affected [files...] [--tests-only]   # reverse-deps Dijkstra (B1)
codegraph reach <from-glob> <to-glob>
codegraph dsm [--granularity file|container]
codegraph deps [--only declared-unused|missing|devOnly]
codegraph facts <out-dir>                      # Datalog facts emission

# Datalog gating (Tier 8 live + post-commit baseline)
codegraph datalog-check [--diff] [--update-baseline] [--json]

# Composite cross-cut (statique × dynamique unifié — ADR-026 phase D)
codegraph cross-check [--rules-dir DIR] [--facts-dir DIR] [--facts-runtime-dir DIR] [--json]

# Memory inter-sessions (Tier 3)
codegraph memory list [--kind X] [--file F]
codegraph memory mark <kind> <fingerprint> <reason> [--scope-file F]
codegraph memory obsolete <id>
codegraph memory delete <id>
codegraph memory prune                         # dur-delete les obsolètes
codegraph memory export                        # JSON dump pour backup
codegraph memory where                         # path du store

# Runtime observability (alpha — package @liby-tools/runtime-graph)
liby-runtime-graph run [--duration N] [--driver synthetic|replay-tests|chaos]
liby-runtime-graph check [--rules-dir DIR] [--facts-dir DIR]
```

---

## MCP server (`codegraph-mcp`)

Wire dans le `.mcp.json` du consommateur :

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph-mcp",
      "cwd": "/path/to/your/project"
    }
  }
}
```

LSP fait du **sémantique fin-grained** (symbols, types, refs).
codegraph-mcp fait du **structurel coarse-grained** (fichiers, ADRs, SSOT, dette, co-change, FK sans index, etc.).
Les deux ensemble : architecture push (hooks) + pull (MCP) symétrique.

Détails des 14 outils : voir [`packages/codegraph-mcp/README.md`](packages/codegraph-mcp/README.md).

---

## Configuration

`.codegraph-toolkit.json` à la racine :

```json
{
  "rootDir": ".",
  "adrDir": "docs/adr",
  "srcDirs": ["src"],
  "tsconfigPath": "tsconfig.json",
  "briefPath": "CLAUDE-CONTEXT.md",
  "anchorMarkerExtensions": ["ts", "tsx", "sh", "sql"],
  "hubThreshold": 15,
  "invariantTestPaths": ["tests/unit/*-invariant.test.ts"],
  "briefCustomSections": [
    {
      "placement": "after-anchored-files",
      "markdown": "Note projet-spécifique injectée dans le brief..."
    }
  ]
}
```

`codegraph.config.json` :

```json
{
  "rootDir": ".",
  "include": ["src/**/*.{ts,tsx}"],
  "exclude": ["**/node_modules/**", "**/*.test.ts"],
  "entryPoints": ["src/index.ts"],
  "detectors": ["ts-imports", "event-bus", "http-routes", "bullmq-queues", "db-tables"],
  "detectorOptions": {
    "sqlSchema": { "enabled": true },
    "drizzleSchema": { "enabled": true },
    "taint": { "enabled": false }
  },
  "snapshotDir": ".codegraph",
  "tsconfigPath": "tsconfig.json"
}
```

`detectorOptions` est **auto-généré par `init`** selon la stack détectée. Tu peux ajuster manuellement.

---

## Architecture interne

### Pipeline d'analyse

`codegraph analyze` orchestre :

1. **File discovery** (glob + exclude)
2. **Base detectors** (boucle visiteur sur les fichiers TS via ts-morph) :
   `ts-imports`, `event-bus`, `http-routes`, `bullmq-queues`, `db-tables`
3. **Build graph** (nodes = fichiers, edges = imports/events/queues/db-tables)
4. **Detector registry** (14 détecteurs, pattern visiteur uniforme) :
   - Architecture : `unused-exports`, `complexity`, `symbol-refs`, `typed-calls`, `cycles`, `truth-points`, `data-flows`, `state-machines`, `barrels`
   - Schema DB : `sql-schema`, `drizzle-schema` (mergent dans `snapshot.sqlSchema`)
   - Hygiène : `env-usage`, `package-deps`, `event-emit-sites`, `oauth-scope-literals`, `taint`
   - Dette : `todos`, `long-functions`, `magic-numbers`, `test-coverage`, `co-change`
5. **Post-snapshot metrics** : `module-metrics` (PageRank, fan-in/out, Henry-Kafura), `component-metrics` (Martin I/A/D), `dsm` (Design Structure Matrix)
6. **Persistence** : `.codegraph/snapshot-{timestamp}-{commit}.json` + facts `.codegraph/facts/*.facts`

### Mode incremental (Salsa) + Datalog runner γ (ADR-026)

`codegraph analyze --incremental` route le pipeline via `@liby-tools/salsa` (runtime de computation incrémentale ~600 LOC pure-TS). Cache per-file via mtime. Sur Sentinel : warm 149ms (vs 21s legacy → 99% plus rapide).

**v0.6 ajoute le pipeline Datalog runner** (ADR-026 phase γ→E) — 21 détecteurs ts-morph portés en rules `.dl` qui consomment des facts dénormalisés émis par UN seul AST walk partagé. Activé par défaut quand `incremental: true` (env `LIBY_DATALOG_LEGACY=1` pour rollback).

Trois caches en cascade :
1. **Phase C.1** — Salsa cells per-file (`astFactsOfFile`) cachant le visit AST. Warm = 0 re-walk pour les fichiers non-modifiés.
2. **Phase C.2** — Cache module-level de `parse(rules) + loadFacts + evaluate`. Hash SHA-256 sur factsByRelation TSV. Warm < 20ms eval (vs 150ms cold).
3. **Phase D** — Cache module-level du composite cross-cut runner. Hash combiné statique + runtime + rules. Warm = 0.02ms cache hit (80× cache miss).

Bench Sentinel `analyze({useDatalog: true, incremental: true})` :
| Mode | Total | Runner Datalog | vs Legacy |
|---|---|---|---|
| Legacy v0.4 | 16.6s | — | 1× |
| Cold incremental | 16.2s | 3.7s | 1.02× |
| **Warm incremental** | **400ms** | **20ms** | **41×** |

`codegraph watch` daemon = Salsa + fs.watch + persistence delta. Snapshot-live.json + facts régénérés ~50ms par save.

### Convention zéro LLM

Le synopsis builder (`buildSynopsis(snapshot, options)`) est **pur** : aucun I/O, aucun LLM, aucun random. Même snapshot → output JSON byte-équivalent. Test `synopsis-determinism` verrouille cette propriété. C'est le cœur de la mental map déterministe.

L'exception : `adr-toolkit bootstrap --apply` lance des agents Sonnet pour rédiger des **drafts** d'ADRs depuis les patterns détectés (l'agent ne décide pas du périmètre, codegraph le fait, l'humain est filtre final).

---

## Détecteurs déterministes additionnels

En plus de la cartographie de base, 50+ extracteurs émettent des facts Datalog (74 relations) :

- **todos** — TODO/FIXME/HACK/XXX/NOTE markers avec file + line + message
- **long-functions** — fonctions/méthodes >100 LOC (configurable)
- **magic-numbers** — littéraux hardcodés en positions suspectes (timeouts, thresholds)
- **test-coverage** — coverage structurel (pas runtime) : pour chaque fichier, liste les tests qui le couvrent
- **co-change** — paires de fichiers fréquemment co-modifiés (90j window) avec coefficient de Jaccard
- **sql-schema** — tables, colonnes, FK, indexes, primary keys depuis migrations `.sql` raw
- **drizzle-schema** — idem depuis exports `pgTable(...)`
- **sql-naming** — conventions Codd-era (snake_case, `_at` suffix, `_id` suffix, audit columns)
- **sql-migration-order** — topological sort : FK forward references détectées
- **eval-calls** — `eval()` et `new Function()` (vecteurs RCE)
- **hardcoded-secrets** — regex + Shannon entropy
- **boolean-params** — Sonar S2301 (boolean trap)
- **drift-patterns** — 5 patterns agentiques (excessive params, wrappers, TODO no owner, deep nesting, empty catch)
- **dead-code** — Sonar S1764, S1126, gcc switch-fallthrough, MISRA 16.6/14.3
- **floating-promises** — rustc `unused_must_use` porté JS
- **deprecated-usage** — JSDoc `@deprecated` declarations + cross-ref call sites
- **articulation-points** — Tarjan O(V+E) : hubs cachés du graphe d'imports
- **resource-balance** — parity acquire/release, setInterval/clearInterval, etc.
- **module-centrality** — PageRank (Brin/Page) + Henry-Kafura par fichier
- **function-complexity** — McCabe cyclomatic + SonarQube cognitive
- **allocation-in-loop** — allocations détectées dans loops (perf)
- **persistent-cycles** — TDA persistent homology sur les snapshots historiques
- **lyapunov-cochange** — exposant de Lyapunov par fichier (cascade refactor)
- **package-mincut** — Ford-Fulkerson Edmonds-Karp BFS, coût objectif de séparation
- **information-bottleneck** — score I(input;output) par symbole (Tishby 1999)
- **spectral-graph** — Fiedler λ₂ par sous-graphe (power iteration projetée)
- **symbol-entropy** — Shannon H(callees) par fonction
- **signature-duplication** — Hamming distance sur signatures encodées (~10 bits)
- **taint** — flow analysis cross-function avec sinks/sanitizers (CodeQL inspiration)
- **crypto-algo** + **security-patterns** — détecte CWE-327, CORS misconfig, TLS unsafe, weak random

---

## Hooks Claude Code

Installés via `init --with-claude-settings` (PreToolUse seul) ou `init --with-claude-hooks` (PreToolUse + PostToolUse complet).

### PreToolUse — `adr-hook.sh`
Avant chaque Edit/Write, injecte la liste des ADRs liés au fichier édité dans `additionalContext`. L'agent voit le bloc `📋 ADR check` AVANT de modifier.

### PostToolUse — `codegraph-feedback.sh` (Tier 8 live datalog)

Après chaque Edit/Write, injecte un bloc `📍 codegraph context` complet :

- **Live Datalog** — exécute les 24 rules (mono + composites) en ~70ms wall clock contre les facts régénérés par le watcher. Affiche uniquement les **nouvelles violations** vs baseline post-commit
- **HIGH-RISK header** si fichier sensible (hub, truth-point writer, cycle)
- **Drift signals** — patterns agentiques pour ce fichier (excessive params, wrappers, TODO sans owner, etc.)
- **Mémoire inter-sessions** — décisions / FP / incidents marqués lors de sessions précédentes
- In/out degree, top importers, exports problématiques
- Cycles, truth-points participants
- Dette : long fns, magic numbers, FIXME, coverage gaps
- Co-change : fichiers souvent modifiés ensemble
- Activité git récente
- WIP intent depuis git diff

L'agent voit l'impact structurel + les invariants violés + la mémoire historique AVANT chaque réponse. Resolution dynamique des paths (walk-up `.git`, `require.resolve` du fast script via node_modules) — le hook survit à un déplacement du repo ou du toolkit.

---

## Pièges connus

- **`workspace:*`** : npm ne supporte pas le protocole pnpm. Utiliser `"*"` pour les deps inter-workspaces.
- **Node ≥22** : nécessaire pour vitest 4. Les hooks doivent sourcer nvm (déjà fait dans les templates).
- **Marqueurs en prose** : `// cf. ADR-013` ne match pas, le matcher exige `ADR-NNN` en début de commentaire.
- **Suffix matching strict** : anchor sans `/` (ex: `index.ts`) ne fait PAS de suffix match — sinon il matcherait 50 fichiers.
- **`git config core.hooksPath`** est local, pas versionné. `init` le set, mais sur un nouveau clone il faut relancer `npx adr-toolkit install-hooks`.
- **Tests exclus du snapshot** : si ta `codegraph.config.json` exclut les tests, `codegraph affected --tests-only` doit passer `--tests-glob` pour les scanner à la volée.
- **Drizzle `references(() => ...)` cross-file** : v1 du détecteur Drizzle ne résout que les références **intra-fichier** (le cas commun). Pour cross-file via imports, à venir en v2.

---

## Bootstrap agentique (auto-rédaction de drafts ADR)

`adr-toolkit bootstrap` lance des agents Sonnet ciblés pour rédiger des **drafts** d'ADRs depuis les patterns détectés. L'agent ne décide pas du périmètre (codegraph le fait), l'humain reste le filtre final.

```bash
# Si Claude Code installé (auth via keychain) :
npx adr-toolkit bootstrap --max 5
npx adr-toolkit bootstrap --apply --only-confidence high,medium

# Sinon avec une clé API :
export ANTHROPIC_API_KEY=sk-ant-...
npx adr-toolkit bootstrap --mode sdk --max 5
```

**4 détecteurs bootstrap** : `singleton`, `write-isolation`, `hub`, `fsm`.

**Architecture en 3 rôles séparés** :

| Niveau | Qui décide | Quoi |
|---|---|---|
| OÙ regarder | codegraph + pattern detectors | détecte les candidats |
| COMMENT formuler | agent Sonnet (prompt cadré, output JSON) | rédige Rule + Why + asserts depuis le code |
| QUOI accepter | humain (CLI revue + `--apply`) | valide / édite / rejette |

**Garde-fous anti-dérive** :
- Why halluciné → forcer à citer commentaire/git OU "TODO" → flag basse confiance
- Asserts inventés → `checkAsserts` AVANT d'écrire l'ADR
- Sur-génération → candidat vient de codegraph, pas du LLM
- Rule générique ("for consistency", "best practice") → flag basse confiance

---

## API programmatique

```ts
import {
  loadConfig, regenerateAnchors,
  loadADRs, matches, findAdrsForFile,
  checkAsserts, generateBrief, initProject,
} from '@liby-tools/adr-toolkit'

import {
  analyze, buildSynopsis, collectAdrMarkers,
} from '@liby-tools/codegraph'

import {
  buildStructuralDiff, renderStructuralDiffMarkdown,
} from '@liby-tools/codegraph/diff'

// v0.6 — pipeline composite statique × dynamique × salsa (ADR-026 phase D)
import {
  setRuntimeFacts, clearRuntimeFacts,
  runCompositeRules,
  // Salsa cells (set par runtime-graph, get par composite runner)
  runtimeSymbolsTouched, runtimeHttpRouteHits, runtimeDbQueriesExecuted,
  allRuntimeFactsByRelation,
} from '@liby-tools/codegraph'
import type {
  RuntimeFactsSnapshot, CompositeRunOptions, CompositeRunResult,
} from '@liby-tools/codegraph'

import {
  attachRuntimeCapture, aggregateSpans,
  pushFactsToSalsa,                  // bridge runtime-graph → codegraph cells
  syntheticDriver, replayTestsDriver, chaosDriver,
} from '@liby-tools/runtime-graph'

// Watcher unifié (1 process pour analyze + capture + composite check)
const handle = attachRuntimeCapture()
await analyze(cfg, { useDatalog: true, incremental: true })  // 400ms warm
const snap = aggregateSpans(handle.flush(), runMeta)
await pushFactsToSalsa(snap)
const r = runCompositeRules({ rulesDl, staticFactsByRelation })
// r.stats.cacheHit = true au 2e run sans changement → 0.02ms
```

---

## Consommateurs

- **Sentinel** (référence) — Express + raw SQL Postgres. 23 ADRs, 47+ marqueurs, 11 ts-morph asserts, **95 rules Datalog actives** (91 toolkit canonical + 4 Sentinel ADR-specific), 335 grandfathers consolidés, hooks Claude Code (PreToolUse + PostToolUse avec live Datalog 70ms par edit). Multi-dir loader actif depuis v0.5.0 — zéro duplication des rules toolkit.
- **Morovar** — Hono + Drizzle ORM + Postgres. MMORPG 2D. Validé Phase 3 portabilité (rule SQL Sentinel marche identiquement sur facts Drizzle).
- **Ton projet ?** — ouvre une issue avec ton retour.

---

## Roadmap

- **Détecteur Prisma** (`schema.prisma`) — émet les mêmes facts SQL que sql-schema/drizzle-schema. ~3-4h.
- **Détecteur TypeORM** (decorators `@Entity()`) — idem. ~4-5h.
- **Reconstruction transitions FSM (V2)** — actuellement le détecteur `fsm` capture les write sites + le contexte fonction. V2 : reconstruire `read state X → write state Y` par control flow analysis.
- **PR diff GitHub Action template** — workflow YAML générique à `npx adr-toolkit init-ci` qui poste le diff structurel auto sur les PR.
- **codegraph_changes_since incremental** — actuellement reload les deux snapshots, possible streaming live.
- **`useDatalog` default-on en CLI one-shot** — actuellement legacy par défaut sans `incremental: true` (cold runner = +3s overhead inutile). Nécessite extract Salsa-isé out of incremental context, à investiguer.
- **Composite rules suite cross-cut** — élargir les `.dl` cross-cut au-delà des 4 rules runtime existantes (DEAD_HANDLER/ROUTE/HOT_PATH/STALE_QUERY) en exploitant les 78 composite rules de `@liby-tools/invariants-postgres-ts`.

---

## Versioning

- `v0.1.0` — premier release npm
- `v0.2.0` — détecteurs bootstrap (singleton + write-isolation + hub) + types invariant + install.sh moderne
- `v0.3.0` — détecteur fsm bootstrap, refactor analyzer.ts (Phase A+B+C), 13 axes d'enrichissement (Phase 1+2+3 multi-projet)
- `v0.4.0` — **Phase 4 agent-first** (Tiers 1-9) :
  - `@liby-tools/invariants-postgres-ts` package — 24 rules Datalog packagées (20 mono + 4 composites multi-relation)
  - 4 nouveaux MCP tools (`codegraph_datalog_query`, `codegraph_drift`, `codegraph_memory_recall`, `codegraph_memory_mark`)
  - Mémoire inter-sessions (Tier 3) — store local `~/.codegraph-toolkit/memory/<projet>.json`
  - Drift agentique (Tier 4) — 5 patterns AST (excessive params, wrappers, TODO no owner, deep nesting, empty catch)
  - 11 nouveaux extracteurs : eval-calls, hardcoded-secrets, boolean-params, drift-patterns, dead-code, floating-promises, deprecated-usage, articulation-points, sql-naming, sql-migration-order, resource-balance
  - Composites multi-relation (Tier 7) — `composite-eval-in-http-route`, `composite-fk-chain-without-index`, `composite-high-critical-untested`, `composite-double-drift-wrapper-boolean`
  - Live Datalog gate dans hook PostToolUse (Tier 8) — 70ms wall clock par edit, delta vs baseline post-commit
  - Packaging shipping-ready (Tier 9) — `--with-invariants postgres --with-claude-hooks` install tout en 1 commande
  - Snapshot relations émises 17 → 37, suite tests toolkit 191 → 452
- `v0.6.0` — **Phase 6 ADR-026 : pipeline composite statique × dynamique × Salsa** :
  - Phases γ.4 → γ.15 : 21 détecteurs ts-morph portés au pattern Datalog runner (1 visit AST + N rules .dl)
  - Phase A.1 (shadow mode) : `analyze({ datalogShadow: true })` compare outputs runner vs legacy, parité 32 facts validée bench BIT-IDENTICAL
  - Phase A.3 (full swap) : `useDatalog: true` route 19 fields snapshot via runner — adapter shape-compat
  - Phase A.4 (close outliers) : couverture 100% des fields portables (hardcodedSecrets.trigger, deadCode 6 kinds, driftSignals + isTodoExempt)
  - Phase C (Salsa caching) : cells per-file `astFactsOfFile` + cache module-level eval Datalog → warm path runner 13ms
  - Phase D : pipeline composite runner statique × dynamique unifié + 8 input cells runtime + bridge `pushFactsToSalsa` côté runtime-graph
  - Phase E : `useDatalog` default-on quand `incremental: true` (watcher mode warm 400ms total, 41× legacy)
  - Fix root-cause : `discoverFiles` sort déterministe (cause du bug cache invalidation Salsa)
  - Nouvelle CLI `codegraph cross-check` : composite runner statique × dynamique end-to-end via fs facts/
  - 9 nouveaux exports publics : `setRuntimeFacts`, `runCompositeRules`, 8 input cells runtime, types associés
  - Hooks dedup PreToolUse + PostToolUse via SHA40 cache TTL 5min — 94-98% réduction tokens hook répétés
  - Suite tests 510 → 726 ; 4 commits Phase D/E publiés en npm v0.6.0
- `v0.5.0` — **Phase 5 cross-discipline + composition orthogonale** (Tiers 14-18) :
  - 67 nouvelles rules : 56 composites (Tiers 14-18) + 8 CWE (Tier 14) + 7 cross-discipline mathématique
  - **6 disciplines mathématiques portées** : Fiedler λ₂ (théorie spectrale, Cheeger inequality), Shannon entropy (théorie de l'information), Hamming distance (théorie des codes), TDA persistent homology (Edelsbrunner-Letscher-Zomorodian 2002), Lyapunov exponent (systèmes dynamiques chaos), Ford-Fulkerson min-cut (théorie des flots)
  - **7e discipline : Tishby Information Bottleneck** — détecte passthrough fns (1c×1c, candidates inline) et information hubs (high score = points d'extension non-testés)
  - **Pattern mining auto-découvert** : 2 rules synthétisées par co-occurrence lift sur les facts (rather than human-designed)
  - Self-audit récursif : codegraph s'analyse lui-même via dogfood gate (`packages/codegraph/tests/self-invariants.test.ts`, budget 700)
  - 14 nouveaux extracteurs : module-centrality (PageRank), function-complexity (McCabe + SonarQube), allocation-in-loop, persistent-cycles, lyapunov-cochange, package-mincut, information-bottleneck, spectral-graph, symbol-entropy, signature-duplication, taint cross-function, crypto-algo, security-patterns, code-quality-patterns
  - **Multi-dir Datalog loader** : `runFromDirs({ rulesDir: [canonical, project] })` permet aux projets consumers de séparer rules toolkit et grandfathers locaux. Sentinel : 92 rules dupliquées → 0 (consume via npm link).
  - Documentation [`docs/CROSS-DISCIPLINE-METRICS.md`](docs/CROSS-DISCIPLINE-METRICS.md) — synthèse 7 disciplines avec théorèmes + applications + sources
  - Snapshot relations émises 37 → 74, suite tests toolkit 452 → 510

Pour le détail : [`CHANGELOG.md`](CHANGELOG.md).

---

## Liens

- [`packages/codegraph-mcp/README.md`](packages/codegraph-mcp/README.md) — détail des 14 MCP tools
- [`packages/invariants-postgres-ts/README.md`](packages/invariants-postgres-ts/README.md) — 91 rules Datalog packagées
- [`packages/datalog/README.md`](packages/datalog/README.md) — runtime Datalog interne (multi-dir loader)
- [`packages/salsa/README.md`](packages/salsa/README.md) — incremental computation
- [`packages/runtime-graph/README.md`](packages/runtime-graph/README.md) — runtime observability framework (OTel + 6 disciplines runtime)
- [`docs/CROSS-DISCIPLINE-METRICS.md`](docs/CROSS-DISCIPLINE-METRICS.md) — 7 disciplines mathématiques portées
- [`docs/REFACTOR-ANALYZER-PLAN.md`](docs/REFACTOR-ANALYZER-PLAN.md) — détail du refactor 3-phases (god-file → registry)
- [`docs/ENRICHMENT-5-AXES-PLAN.md`](docs/ENRICHMENT-5-AXES-PLAN.md) — plan des 5 axes Phase 1
- [`docs/PHASE-2-SQL-DETECTOR-PLAN.md`](docs/PHASE-2-SQL-DETECTOR-PLAN.md) — design du SQL detector

---

## Portabilité agents IA

Le toolkit a été pensé d'abord pour Claude Code, mais le cœur est agent-agnostique :

- **Mental map** : `BOOT-BRIEF.md` + `MAP.md` + `synopsis-level{1,2,3}.md` sont du markdown standard, lisibles par n'importe quel agent (Cursor, Aider, Cline, Copilot CLI, GPT-via-shell).
- **MCP server** : protocole standard, fonctionne avec tout client MCP. Les 14 outils sont exposés via JSON-RPC.
- **Datalog facts + rules** : `.facts` et `.dl` lisibles partout, runner pure-TS sans dépendance Claude.
- **Hooks** : les fichiers `.claude/settings.json` sont spécifiques Claude Code. Pour Cursor/Aider/Cline, les hooks équivalents sont au niveau git (`pre-commit`, `post-commit`) — installés automatiquement par `adr-toolkit install-hooks`.

Cf. [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) pour le portage à un agent non-Claude.
- [`docs/PHASE-5-COMPOSITE-BACKLOG.md`](docs/PHASE-5-COMPOSITE-BACKLOG.md) — 52 candidats Tiers 14-18
