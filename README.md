# codegraph-toolkit

> **Rends ton projet TS lisible à un agent IA. Détecte les invariants architecturaux. Bloque les régressions structurelles avant qu'elles arrivent en prod.**

```bash
npm install -g @liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/codegraph-mcp
cd ton-projet
npx adr-toolkit init --with-claude-settings
```

C'est tout. Le toolkit détecte ta stack (Express/Hono/Next, raw SQL/Drizzle, mono ou monorepo), génère la config, installe les hooks git + Claude Code, et te livre une mental map déterministe régénérée à chaque commit.

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

### 3. Invariants Datalog ratchetés

Tu écris une règle déclarative (`fk-needs-index.dl`), elle s'exécute contre les facts émis par codegraph (`SqlForeignKey`, `SqlIndex`, etc.). La rule attrape **toute nouvelle violation** sans bloquer sur l'existant (pattern ratchet). Exemples livrés :
- **Cycles d'import non-gated** — bloqués au pre-commit
- **FK Postgres sans index** — détecte les futurs `DELETE CASCADE` en full scan
- **OAuth scopes hardcodés** — force l'usage du registry typé
- **Threshold runtime via `parseInt(process.env.X)` inline** — force `envInt(...)` typé

### 4. 9 MCP tools pour l'agent IA

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

### 5. Watch mode + hook PostToolUse

`codegraph watch &` maintient `.codegraph/snapshot-live.json` à jour à chaque save (~50ms warm via cache Salsa). Le hook PostToolUse Claude Code lit ce snapshot live et injecte le contexte structurel (HIGH-RISK header, importers, exports problématiques, co-change, activité git récente) AVANT chaque réponse de l'agent — il voit l'impact de son edit avant de répondre.

### 6. Stacks DB supportées (mêmes invariants partout)

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
# 1. Install global (une fois par machine)
npm install -g @liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/codegraph-mcp

# 2. Dans ton projet
cd ton-projet
npx adr-toolkit init --with-claude-settings

# 3. Premier ADR
cp docs/adr/_TEMPLATE.md docs/adr/001-mon-invariant.md
# édite : Rule, Why, asserts si pertinent
# pose `// ADR-001` au top d'un fichier source

# 4. Régen + commit
npx adr-toolkit regen
npx codegraph analyze
npx adr-toolkit brief
git commit -am "feat: ADR-001"
```

À partir d'ici : le pre-commit hook prend le relais. Régen + brief + facts Datalog + invariants checkés à chaque commit.

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
adr-toolkit init [--with-claude-settings]
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

Détails des 9 outils : voir [`packages/codegraph-mcp/README.md`](packages/codegraph-mcp/README.md).

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

### Mode incremental (Salsa)

`codegraph analyze --incremental` route le pipeline via `@liby-tools/salsa` (runtime de computation incrémentale ~600 LOC pure-TS). Cache per-file via mtime. Sur Sentinel : warm 149ms (vs 21s legacy → 99% plus rapide).

`codegraph watch` daemon = Salsa + fs.watch + persistence delta. Snapshot-live.json + facts régénérés ~50ms par save.

### Convention zéro LLM

Le synopsis builder (`buildSynopsis(snapshot, options)`) est **pur** : aucun I/O, aucun LLM, aucun random. Même snapshot → output JSON byte-équivalent. Test `synopsis-determinism` verrouille cette propriété. C'est le cœur de la mental map déterministe.

L'exception : `adr-toolkit bootstrap --apply` lance des agents Sonnet pour rédiger des **drafts** d'ADRs depuis les patterns détectés (l'agent ne décide pas du périmètre, codegraph le fait, l'humain est filtre final).

---

## Détecteurs déterministes additionnels

En plus de la cartographie de base :

- **todos** — TODO/FIXME/HACK/XXX/NOTE markers avec file + line + message
- **long-functions** — fonctions/méthodes >100 LOC (configurable)
- **magic-numbers** — littéraux hardcodés en positions suspectes (timeouts, thresholds)
- **test-coverage** — coverage structurel (pas runtime) : pour chaque fichier, liste les tests qui le couvrent
- **co-change** — paires de fichiers fréquemment co-modifiés (90j window) avec coefficient de Jaccard
- **sql-schema** — tables, colonnes, FK, indexes depuis migrations `.sql` raw
- **drizzle-schema** — tables, colonnes, FK, indexes depuis exports `pgTable(...)`
- **fk-without-index** — dérivé : FK sans index correspondant (= DELETE CASCADE en full scan)

---

## Hook Claude Code

Deux hooks installés via `init --with-claude-settings` :

### PreToolUse — `adr-hook.sh`
Avant chaque Edit/Write, injecte la liste des ADRs liés au fichier édité dans `additionalContext`. L'agent voit le bloc `📋 ADR check` AVANT de modifier.

### PostToolUse — `codegraph-feedback.sh`
Après chaque Edit/Write, injecte un bloc `📍 codegraph context` :
- HIGH-RISK header si fichier sensible (hub, truth-point writer, cycle)
- In/out degree, top importers, exports problématiques
- Cycles, truth-points participants
- Dette : long fns, magic numbers, FIXME, coverage gaps
- Co-change : fichiers souvent modifiés ensemble
- Activité git récente
- WIP intent depuis git diff

L'agent voit l'impact de son edit AVANT de répondre.

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
```

---

## Consommateurs

- **Sentinel** (référence) — Express + raw SQL Postgres. 22 ADRs, 47+ marqueurs, 11 ts-morph asserts, 7 invariants Datalog actifs (cycles, OAuth, events, thresholds, FK indexes, …), 4 hooks Claude Code.
- **Morovar** — Hono + Drizzle ORM + Postgres. MMORPG 2D. Validé Phase 3 portabilité (rule SQL Sentinel marche identiquement sur facts Drizzle).
- **Ton projet ?** — ouvre une issue avec ton retour.

---

## Roadmap

- **Détecteur Prisma** (`schema.prisma`) — émet les mêmes facts SQL que sql-schema/drizzle-schema. ~3-4h.
- **Détecteur TypeORM** (decorators `@Entity()`) — idem. ~4-5h.
- **Reconstruction transitions FSM (V2)** — actuellement le détecteur `fsm` capture les write sites + le contexte fonction. V2 : reconstruire `read state X → write state Y` par control flow analysis.
- **PR diff GitHub Action template** — workflow YAML générique à `npx adr-toolkit init-ci` qui poste le diff structurel auto sur les PR.
- **codegraph_changes_since incremental** — actuellement reload les deux snapshots, possible streaming live.

---

## Versioning

- `v0.1.0` — premier release npm
- `v0.2.0` — détecteurs bootstrap (singleton + write-isolation + hub) + types invariant + install.sh moderne
- `v0.3.0` — détecteur fsm bootstrap, refactor analyzer.ts (Phase A+B+C), 13 axes d'enrichissement (Phase 1+2+3 multi-projet)

Pour le détail : [`CHANGELOG.md`](CHANGELOG.md).

---

## Liens

- [`packages/codegraph-mcp/README.md`](packages/codegraph-mcp/README.md) — détail des 9 MCP tools
- [`packages/datalog/README.md`](packages/datalog/README.md) — runtime Datalog interne
- [`packages/salsa/README.md`](packages/salsa/README.md) — incremental computation
- [`docs/REFACTOR-ANALYZER-PLAN.md`](docs/REFACTOR-ANALYZER-PLAN.md) — détail du refactor 3-phases (god-file → registry)
- [`docs/ENRICHMENT-5-AXES-PLAN.md`](docs/ENRICHMENT-5-AXES-PLAN.md) — plan des 5 axes Phase 1
- [`docs/PHASE-2-SQL-DETECTOR-PLAN.md`](docs/PHASE-2-SQL-DETECTOR-PLAN.md) — design du SQL detector
