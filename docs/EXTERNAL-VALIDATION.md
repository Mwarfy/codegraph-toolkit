# External validation runs

> Le toolkit a été calibré sur 1 projet (Sentinel — Node backend / Postgres /
> BullMQ / OAuth). Cette page documente les runs sur des projets TS OSS au
> shape différent, pour valider qu'il ne **crash pas** + qu'il ne **hallucine
> pas** des findings.

## Run #1 — Hono (web framework, web standards) — 2026-05-03

**Repo** : https://github.com/honojs/hono — v4.12.16, MIT, ~18k stars,
commit `8f027e5`

**Command** :

```bash
git clone --depth 1 https://github.com/honojs/hono.git /tmp/hono-test
cat > /tmp/hono-test/codegraph.config.json <<EOF
{
  "rootDir": ".",
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts", "**/node_modules/**", "**/dist/**"]
}
EOF
codegraph analyze --config /tmp/hono-test/codegraph.config.json
```

**Profile** :
- 186 source files (.ts hors tests)
- 98 test files (.test.ts) — non analysés
- 492 import edges
- Cold run : **3.5s** (vs Sentinel 4.8s — Hono est plus petit)
- 81 fact relations × 6724 tuples écrits

### ✓ Validations positives

| Check | Résultat | Pourquoi c'est juste |
|---|---|---|
| **Pas de crash** | ✓ Run complet en 3.5s | Le toolkit accepte un projet shape différent sans patcher |
| **Truth-points = 0** | ✓ 0 writers détectés | Hono n'a pas de DB → `TruthPointWriter.facts` vide. Sentinel a 50+. **Pas d'hallucination**. |
| **Hubs cohérents** | ✓ `types.ts` 52 in, `context.ts` 39, `hono.ts` 16 | Les hubs détectés correspondent EXACTEMENT au domaine Hono (Context API + types canonique + Hono router) |
| **5 cycles structurels** | ✓ détectés | streaming/text, jwt/jws-types, ssg/plugins-ssg, compose-types-hono-base, jsx/base — sont **vrais** cycles d'imports dans Hono |
| **6 orphans** | ✓ détectés | Légitime pour un framework avec exports optionnels (chaque adapter/middleware peut être orphan si non importé en interne) |
| **22 barrels (16 low-value)** | ⚠ partiel | Vrai count, mais "low-value" signal trop strict pour un framework où `index.ts` re-export est design intentionnel |
| **0 truth-point conflicts** | ✓ | Cohérent avec 0 truth-points |

### ⚠ Limites observées (vs Sentinel)

**1. Package-deps heuristique** — 17 deps flaggées `declared-unused` dont :

  - `@vitest/coverage-v8` — plugin chargé par `vitest.config.ts`, pas par script
  - `@hono/eslint-config` — chargé par `eslint.config.mjs`
  - `msw` — chargé par tests via setup file
  - `bun-types` — type-only dependency
  - `jsdom` — chargé par vitest dom env
  - etc.

  **Diagnostic** : notre `isReferencedInScripts()` regarde les `package.json
  scripts`, mais pas les `*.config.{ts,js,mjs}` files qui chargent les plugins.
  C'est un **trou heuristique connu**, pas un bug fondamental. Sur Sentinel
  ce pattern existait moins (config files plus simples).

  **Action** : noté pour amélioration future. Pour l'instant l'utilisateur
  Hono peut overrider via la config detector ou ignorer le warning.

**2. Seuils de barrel low-value** — 16/22 barrels flagged comme low-value.
  Sur Sentinel ce ratio est ~3/6. Le seuil `< 2 consumers` peut over-flag
  pour un framework où chaque feature exporte via barrel par convention.

  **Action** : seuil documenté dans `docs/THRESHOLDS.md`. Override possible
  via `computeBarrels(graph, { minConsumers: 1 })`.

**3. Cycles non-classés** — codegraph détecte les cycles mais ne sait pas
  s'ils sont **gated/intentional** ou **drift**. Pour un projet externe sans
  contexte historique, c'est attendu : on signale, le mainteneur juge.

### Conclusion run #1

**Le toolkit fonctionne sur un projet externe shape différent**, sans crash,
sans hallucination, avec des findings réels. Les limites observées sont
des heuristiques tunables (config-driven), pas des bugs fondamentaux.

C'est un signal honnête de portabilité — le toolkit n'a pas appris la
forme spécifique de Sentinel par accident. Il généralise raisonnablement.

## Run #1 — Hono FULL CHAIN test (codegraph + runtime-graph + datalog + MCP)

Ce run a testé toute la chaîne : pas seulement codegraph statique.

### ✓ Ce qui marche

**Codegraph static analysis** (cf. section précédente) :
  - 81 fact relations, 6724 tuples
  - 5 cycles structurels détectés
  - Hubs cohérents

**Disciplines mathématiques rigoureuses** (à distinguer des heuristiques
inspirées) :
  - **Fiedler λ₂** (SpectralMetric) : 16 sous-graphes calculés via power
    iteration sur Laplacien. Vrai calcul spectral. Déterministe (van der
    Corput init).
  - **Newman-Girvan modularity Q** : 1 score global + ImportCommunity (255
    rows) — vraie détection de communautés.
  - **Shannon entropy** (SymbolEntropy) : 77 rows — vraie entropie.
  - **NCD compression distance** : 61 rows — vrai NCD via gzip.
  - **Information Bottleneck heuristic** (407 rows) : log fan-in × log
    fan-out. **Heuristique inspirée**, pas le vrai Tishby IB (cf. disclaimer
    dans le code).

**Datalog runner** : 90/100 rules tournent successfully sur Hono facts.
**312 violations détectées** par 15 types de rules, dont :
  - 74 COMPOSITE-MISPLACED-FILE
  - 33 COMPOSITE-COGNITIVE-BOMB
  - 31 NO-RETURN-THEN-ELSE (Sonar S1126 — vraies violations Hono)
  - 28 COMPOSITE-CYCLOMATIC-BOMB
  - 18 COMPOSITE-AWAIT-IN-LOOP
  - 15 NO-NEW-ARTICULATION-POINT
  - 12 COMPOSITE-BACK-EDGE
  - 11 NO-FLOATING-PROMISE
  - 11 CYCLES
  - + autres

**MCP tools** : 6/7 testés OK — `affected` (calcule reverse-deps),
`context`, `truth-point`, `recent`, `changes-since`, `co-changed`. Le
7e (`who-imports.ts`) est en réalité nommé `importers.ts` — bug naming
mineur.

### ✗ Ce qui pète (bugs trouvés sur Hono)

**Bug #1 — knownFiles filter cassé sur projets avec tests `.tsx`**

`extractors/co-change.ts` filtre les paires de co-change via `knownFiles`
set. Si knownFiles ne contient que les `.ts` (cas Hono où les tests sont
`.test.tsx` exclus du glob), TOUTES les paires test↔source sont rejetées.

  **Impact cascade** : 7 disciplines git-historiques retournent 0 rows :
  - LyapunovMetric, BayesianCoChange, GrangerCausality, FactKindStability,
    PersistentCycle, CompressionDistance partial, et + le `CoChange.facts`
    file lui-même est vide.

  **Vérification** : `analyzeCoChange()` direct sans knownFiles retourne
  bien des paires. Le bug est dans le filter.

  **Fix proposé** : OR au lieu de AND — accepter si au moins UN des deux
  côtés est dans knownFiles. Évite de filtrer les paires test↔source
  légitimes.

**Bug #2 — CLI datalog sans flag `--allow-recursion`**

5 rules utilisent la récursion (`composite-fk-chain-without-index`,
`composite-tainted-flow*`, `composite-cross-fn-*`, `composite-cross-function-taint`).
Le runner Datalog supporte `allowRecursion: true` au niveau API mais
**le CLI ne l'expose pas**. Ces rules sont mortes via CLI.

  **Fix proposé** : ajouter `--allow-recursion` à la CLI `datalog run`.

**Bug #3 — runtime-graph capture inutile sur tests unitaires**

Le driver `replay-tests` lance `npx vitest run` sous OTel auto-instrument.
Mais OTel capture HTTP/DB/Redis spans, **pas les appels JS internes**.
Les tests unitaires Hono (parsing URL, JWT decode, etc.) ne déclenchent
aucun span → 0 SymbolTouchedRuntime, 0 CallEdgeRuntime, 0 LatencySeries.

  **Implication** : runtime-graph est utile sur des **apps live avec routes
  HTTP**, pas sur les bibliothèques pures. Pour Hono lui-même, il faudrait
  démarrer une app demo + driver synthetic curl.

  **Action** : documenter cette limite. Pas un bug à fixer — design correct
  d'OTel.

**Bug #4 — `who-imports` nommé `importers` côté code MCP**

Inconsistance naming : la doc mentionne `who-imports`, le fichier est
`tools/importers.ts`. Mineur mais source de confusion.

### Métriques résumées Hono

  | Surface              | Status                               |
  | ─────────────────── | ──────────────────────────────────── |
  | Codegraph analyze    | ✓ 3.5s, 0 crash                      |
  | Static disciplines   | ✓ Fiedler, Newman-Girvan, Shannon, NCD |
  | Heuristiques         | ⚠ IB OK, Lyapunov-cochange/Granger morts (bug #1) |
  | Datalog rules        | ✓ 90/100 (5 récursives mortes via CLI bug #2) |
  | 312 violations real  | ✓ détectées sur Hono                 |
  | Runtime-graph capture | ✗ 0 spans (architecture limit, bug #3) |
  | MCP tools (6/7)      | ✓ affected, context, truth-point, etc. |

### Priorités d'amélioration (ordre)

1. **Bug #1 (knownFiles filter)** — débloque 7 disciplines git-historiques
   sur tout projet avec tests .tsx. ~30 min fix.
2. **Bug #2 (CLI --allow-recursion)** — débloque 5 rules sécurité
   importantes (tainted flow, fk chains). ~15 min fix.
3. **Bug #4 (naming who-imports)** — cosmétique, ~5 min.
4. **Bug #3 (runtime-graph)** — pas un bug fixable, mais doc à updater
   pour clarifier que runtime-graph nécessite app live HTTP, pas tests
   unitaires de bibliothèque.

### Verdict global

**Le système marche à 70%** sur un projet externe :
  - Static analysis ✓✓✓
  - Math disciplines rigoureuses ✓✓
  - Datalog rules ✓✓ (90/100)
  - MCP tools ✓✓ (6/7)
  - Heuristiques git-historiques ✗ (bug filter)
  - Runtime-graph capture ✗ (architecture mismatch sur libraries)

Les bugs trouvés sont **réparables** sans refactor majeur. Le toolkit
n'a PAS été conçu accidentellement pour Sentinel uniquement — il
**généralise**, mais 1 bug filter cause une cascade visible seulement sur
un projet shape différent. C'est exactement ce qu'un test externe est
censé révéler.

## Run #2 / #3 (différés)

Plus utile maintenant : fixer les 4 bugs trouvés que d'enchaîner Cal.com
+ Trigger.dev. Sans le bug #1 fix, ces runs montreront le même
"7 disciplines mortes" sur les tests externes.
