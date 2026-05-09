# Release Plan — packages npm

> Liste des packages a publier sur npm + ordre recommande.
> Dernier update : 2026-05-09 (post merge PR #17).

## TL;DR — etat publication

| Package | Local | npm | Action | Priorite |
|---------|------:|----:|--------|----------|
| `@liby-tools/codegraph` | **0.6.1** | 0.6.0 | `npm publish` (republish) | **P0** |
| `@liby-tools/codegraph-mcp` | **0.3.1** | 0.3.0 | `npm publish` (republish) | **P0** |
| `@liby-tools/adr-toolkit` | **0.3.1** | 0.3.0 | `npm publish` (republish) | P1 |
| `@liby-tools/invariants-postgres-ts` | **0.1.0** | (404) | `npm publish` **premiere publication** | **P0** |
| `@liby-tools/datalog` | 0.3.0 | 0.3.0 | (rien — pas de change) | — |
| `@liby-tools/salsa` | 0.3.0 | 0.3.0 | (rien — pas de change) | — |
| `@liby-tools/runtime-graph` | 0.1.0-alpha.5 | 0.1.0-alpha.5 | (rien — alpha, pas de fix) | — |

## Ordre de publication recommande

L'ordre matters parce que les `peerDependencies` doivent resoudre vers
des versions deja publiees pour que les nouveaux installs marchent.

```bash
# 1) datalog + salsa (deja publies, pas de change → skip)

# 2) codegraph 0.6.1 (depend de datalog ^0.3.0 + salsa ^0.3.0 → deja en place)
cd packages/codegraph && npm publish

# 3) invariants-postgres-ts 0.1.0 — premiere publication
#    peer codegraph: >=0.3.0 → satisfait par 0.6.1 deja publie
cd packages/invariants-postgres-ts && npm publish

# 4) codegraph-mcp 0.3.1 (depend codegraph >=0.6.0 → satisfait par 0.6.1)
cd packages/codegraph-mcp && npm publish

# 5) adr-toolkit 0.3.1 (depend codegraph ^0.3.0 → satisfait par 0.6.1)
cd packages/adr-toolkit && npm publish
```

Auth requise : `npm login` avec un compte qui a access publish au scope
`@liby-tools`.

---

## Detail des changes par package

### `@liby-tools/codegraph` 0.6.0 → 0.6.1

**Findings resolus** :

- F-001 Janus — `datalog-check` TypeError (commit `0e83230`)
- F-009 Janus + Happenin — `proxy.ts` Next.js 16 reconnu comme entry-point
- F-002 Janus — peer range `codegraph: >=0.6.0` requis par codegraph-mcp (necessite republish)
- F-005 Janus — DEP-UNUSED faux positif sur CLI tools (packages avec `bin` field)
- F-006 Janus — `cross-check` auto-resolve `node_modules/@liby-tools/runtime-graph/rules/`

**OSS-AUDIT P0-P4** (5 projets externes : vercel/commerce, mcp-sdk, hono, trpc, tanstack-query) :

- P0 — visibility detecteurs : `codegraph detectors` + ligne `(graph base)`
- P1 — conventions OSS : `examples/`, `benchmarks/`, `www/`, `__testfixtures__/`,
  `*.test-d.ts`, `*.svelte.ts`, `test-setup.ts`, `*.examples.ts`, `*.bench.ts`,
  + Next.js 16 (`proxy.ts`) + Vercel 2026 (`vercel.ts`) + `tsdown.config`
- P2 — workspaces auto-detection (pnpm/npm/yarn/lerna) :
  - `packages/<pkg>/src/index.ts` reconnus via `package.json#main`/`exports`
  - `package-deps` exempte les workspaces internes + build-time tools
  - mapping `dist/X.mjs` → `src/X.ts` heuristique
- P3 — paires near-duplicate cross-workspace skip (adapter pattern intentionnel)
- P4 — pre-build sharedProject ts-morph en mode legacy → **-47% perf** sur tanstack-query

**Nouveau** : output **SARIF 2.1.0** via `--format sarif` (GitHub Code Scanning)

**Self-audit** : health 100%, 0 orphans, 0 cycles, 817 tests OK.

### `@liby-tools/codegraph-mcp` 0.3.0 → 0.3.1

**Findings resolus** :

- F-002 Janus — peer `@liby-tools/codegraph` bumpe `^0.2.0` → `>=0.6.0`
  (le code importe `./diff` qui n'existe que depuis 0.6.0)

### `@liby-tools/adr-toolkit` 0.3.0 → 0.3.1

**Findings resolus** :

- F-004 Janus — `init` detecte `nextjs` layout (avant : `flat` avec
  entryPoints `["index.ts","main.ts"]` qui n'existaient pas)
- F-007 Janus — `init` skip `tests/unit/datalog-invariants.test.ts` si
  vitest absent (avant : creation systematique → import casse au runtime)
- Bonus : detection `supabase/migrations/` pour activer auto sql-schema

### `@liby-tools/invariants-postgres-ts` 0.1.0 (premiere publication)

**Findings resolus** :

- F-008 Janus — package non publie (`npm install` retournait 404)

**Etat preparatoire** :
- `publishConfig.access: public` ✓
- `files: ["invariants", "README.md"]` ✓
- Peer deps : `@liby-tools/codegraph: >=0.3.0` (compatible 0.6.1)

**Validation pre-publish recommandee** :
```bash
cd packages/invariants-postgres-ts
npm pack --dry-run    # verifie le tarball content
```

---

## Verification post-publish

```bash
# Sanity check sur un projet propre
mkdir /tmp/release-smoke && cd /tmp/release-smoke
npm init -y
npm install --save-dev @liby-tools/codegraph @liby-tools/codegraph-mcp \
  @liby-tools/adr-toolkit @liby-tools/datalog @liby-tools/salsa \
  @liby-tools/invariants-postgres-ts

# Quickstart resolutions verifiees :
npx codegraph --version      # → 0.6.1
npx codegraph datalog-check  # → ne plante plus (F-001)
npx codegraph-mcp            # → demarre OK (F-002)
npx adr-toolkit init         # → layout='nextjs' si next.config (F-004)
```

---

## Findings restants apres release

Aucun finding code-side restant des dogfoods Happenin / dpl-rag /
Janus / OSS-AUDIT-2026-05-08. Pistes long terme uniquement (non
bloquantes) :

- Parallelisation orchestrateur de detecteurs (gain potentiel multi-core)
- Self-test avec config etendue (66 detecteurs au lieu de 6 par defaut
  affiches dans `Detectors:`)
- Re-audit nouveaux projets OSS pour valider la couverture des fixes
