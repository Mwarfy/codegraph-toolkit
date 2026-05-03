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

## À venir

- Run #2 : Cal.com sub-package (`packages/lib/` ou `packages/features/bookings/`)
  pour stresser le pattern monorepo Turborepo + Prisma truth-points.
- Run #3 : Trigger.dev sub-package pour valider sur un shape proche
  de Sentinel (jobs orchestration) mais codebase indépendante.

Quand ces 3 runs passent sans crash + 0 hallucination, on aura un signal
défendable que le toolkit est **portable au-delà de son projet de
calibration**, pas juste un dogfood Sentinel.
