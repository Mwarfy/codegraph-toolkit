# Changelog

> Pour l'activité commit-by-commit récente, voir [CHANGELOG-RECENT.md](./CHANGELOG-RECENT.md)
> (auto-généré post-commit). Cette page tient les **releases** (versions
> publiées sur npm).

## 0.3.0 — 2026-05-03 — Consolidation release

Première release publiable sur npm registry. Réponse aux 2 reviews
externes critiques (28 avril → 3 mai 2026) : déterminisme cassé, math
namedropping, quickstart fake, god files, CHANGELOG mort.

### Fixed (P0 — critical)

- **Déterminisme spectral graph** : `extractors/spectral-graph.ts` utilisait
  `Math.random()` pour init le power iteration → snapshot non byte-équivalent
  entre 2 runs. Remplacé par `vanDerCorput` (low-discrepancy déterministe).
  Test dédié `tests/spectral-determinism.test.ts` (2 tests, fixtures
  4-segment paths qui forcent le power iteration à tourner — l'ancien
  test E2E faisait skip via la garde `files.length < 3`).
- **Honesty disclaimers** sur 4 heuristiques mathématiques (lyapunov-cochange,
  information-bottleneck, persistent-cycles, granger-causality). Ce
  sont des **heuristiques inspirées**, pas les vrais objets mathématiques
  (pas de mutual information, pas de complexe simplicial, pas de test F
  formel). Disclaimers explicites en tête de chaque fichier.

### Changed (P1+P2+P3 — credibility)

- **README** : header status POC honest, quickstart `git clone + npm link`
  (au lieu de `npm install` qui était un 404 garanti), section "Packages"
  séparant **core** (4 publishable) vs **experimental** (3 dogfood-only).
- **Math labeling** : "discipline mathématique" → "heuristique inspirée"
  partout dans le README + LAUNCH-POST de runtime-graph.
- **Living CHANGELOG** : `scripts/regen-changelog.sh` génère
  CHANGELOG-RECENT.md depuis git log à chaque commit (post-commit hook).
- **docs/THRESHOLDS.md** : tous les seuils magiques (`> 50%`, `> 25 IB`,
  `λ ≤ 1.10`, etc.) maintenant documentés avec valeur, override, rationale.

### Added (Niveau auto-loop self-optim)

- `scripts/self-runtime-probe.ts` — profile par detector + λ_lyap analysis.
- `scripts/inject-self-optim-brief.ts` — injecte ROI rank dans BOOT-BRIEF.
- `scripts/scaffold-salsa.sh` — squelette Salsa wrapper.
- `scripts/synth-aggregation.ts` — synth complet pour ~70% des détecteurs.
- `scripts/effect-analysis.ts` — classification 1-pass / 2-pass auto (42% net).
- `scripts/static-cost-estimator.ts` — log-linear cost prediction (R² ~0.20,
  utile comme outil d'investigation `--rank`, pas remplaçant du probe).

### Performance

- Salsa-isation de 4 nouveaux détecteurs (code-quality-patterns,
  security-patterns, dead-code, deprecated-usage) → warm runtime sur le
  toolkit lui-même : **4870ms → 2066ms (−58%)**, λ_lyap des 4 cibles
  passe de ~1.0 à 20-43 (cache cliff confirmé).

### Math gate / governance

- Test invariant `tests/hubs-have-adr-invariant.test.ts` : tout fichier
  fan-in ≥ 3 dans src/ DOIT avoir un marqueur ADR. Auto-découvre
  les nouveaux hubs en CI. **34/34 hubs governed (100%)**.
- Test invariant `tests/self-runtime-regression.test.ts` : aucun
  détecteur ne peut avoir mean ≥ 200ms warm + λ_lyap ≤ 1.10. Bloque
  toute régression Salsa-isation.
- Test E2E `tests/analyze-determinism-e2e.test.ts` (5 tests sur 3
  fixtures réelles) + `tests/git-extractors-determinism.test.ts`
  (4 tests avec fixture git stable, dates fixées) — couvre le pipeline
  COMPLET (pas seulement `buildSynopsis`).

### Removed / deferred

- `runtime-graph` retiré du quickstart README (reste experimental dans
  monorepo). Le pitch "OSS alternative to Datadog" est abandonné — c'est
  un POC pour joindre static + OTel, pas un APM replacement.
- Niveau 6 (parallel Salsa via worker_threads) déféré : Node single-threaded
  JS, gain négligeable sur le profile actuel.
- Niveau 7 (AST binary serialization) déféré : 1-2 sem effort, gain ~2s
  cold start. Niveau 7-alt déjà en place (skip si mtimes inchangés).

### Status pour adoption externe

**Ce que tu obtiens en publiant 0.3.0** :
  ✓ Pipeline déterministe testé bout-en-bout
  ✓ ADR anchoring + brief generation testés sur 1 projet réel (Sentinel)
  ✓ Datalog runner pure-TS sans binaire native

**Ce qui reste à faire pour 1.0** :
  - Tester sur ≥ 3 projets TS externes au shape différent (Next.js, Hono,
    monorepo Turborepo) avant de prétendre "production-ready"
  - Calibration des seuils magic via distribution réelle inter-projets
  - god-file `cli/index.ts` (2176 LOC) à découper en `cli/commands/*.ts`
    (PoC fait, pattern documenté dans le header — split complet = 3 commits
    futurs)
  - `runtime-graph` à mûrir ou à archiver selon usage observé

---

## 0.1.0 — 2026-04-28

Initial extraction depuis Sentinel.

### Added

- `@liby-tools/codegraph` — analyseur statique TS extrait du repo Sentinel. 13 sous-commandes CLI (analyze, synopsis, orphans, exports, taint, dsm, deps, diff, check, reach, arch-check, serve, map). API publique : `analyze`, `buildSynopsis`, `collectAdrMarkers`.
- `@liby-tools/adr-toolkit` — système de gouvernance ADR config-driven : `regenerateAnchors`, `loadADRs`, `findAdrsForFile`, `checkAsserts` (ts-morph), `generateBrief`, `initProject`. CLI : `init`, `regen`, `linker`, `check-asserts`, `brief`, `install-hooks`.
- `briefCustomSections` dans la config — permet d'injecter du markdown projet-spécifique dans le brief sans forker le toolkit. Placements : `after-anchored-files`, `after-invariant-tests`, `after-recent-activity`.
- Hooks templates portables (pre-commit, post-commit, adr-hook.sh) avec sourcing nvm + JSON output protocol pour Claude Code.
- `examples/minimal` — projet hello-world consommateur, valide le scénario complet init → premier ADR → brief en <10 min.
- 39 tests vitest (codegraph: 10, adr-toolkit: 29) + 15 tests legacy node:assert (exclus de `npm test`, runnables via tsx).

### Consumers

- **Sentinel** — extrait depuis ce toolkit. 18 ADRs, 47 marqueurs, 11 ts-morph asserts. Suite invariants 35/35 verts via le nouveau path d'import.

### Decisions

- Repo séparé : `~/Documents/codegraph-toolkit/` (vs sous-dossier d'un projet — survit à la mort du consommateur).
- Scope npm : `@liby-tools/` (nom partagé Marius+Liby qui survit aux projets).
- npm workspaces (vs pnpm/Lerna/Turborepo) — alignement npm partout, pas de complexité ajoutée.
- ts-morph pour les asserts (vs LSIF/SCIP — overkill).
- Vitest (vs Jest — alignement Sentinel).
- commander pour les CLIs (vs yargs/oclif — déjà utilisé).
- Pas de publication npm registry au début — consommation via `npm link` ou `file:` deps.
- `noUncheckedIndexedAccess` retiré du base tsconfig — Sentinel ne l'utilise pas, le code n'est pas écrit pour cette rigueur. Follow-up éventuel.

### Pièges documentés

Cf. `README.md` § Pièges connus :
- npm ne supporte pas `workspace:*` (pnpm-only) → utiliser `"*"`.
- Hooks doivent sourcer nvm (vitest 4 + rolldown exigent Node ≥22).
- `execSync('cat')` cap à 1 MB — utiliser `readFileSync`.
- Marqueurs ADR en début de commentaire seulement (pas en prose).
- Suffix matching strict (anchor sans `/` ne fait pas de suffix match).
- `git config core.hooksPath` est local, pas versionné.
