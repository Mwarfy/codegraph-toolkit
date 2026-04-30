# Changelog

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
