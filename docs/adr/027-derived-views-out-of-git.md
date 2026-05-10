# ADR-027: Vues dérivées hors git — direction Glean

**Date:** 2026-05-10
**Status:** Accepted (Phase 1) — Phases 2-4 planned

## Rule

> Toute donnée dérivable du code source par une fonction pure (snapshot,
> brief, changelog, vues structurelles) vit en `.codegraph/` (gitignored),
> est déterministe par construction, et **n'est jamais commitée dans git**.
> Les sources canoniques sont : `packages/**/src`, `docs/adr/**`, configs.

## Why

Symptôme observé le 2026-05-10 : 51 snapshots `snapshot-*.json` accumulés en
5 jours (~170 MB), conflit Git récurrent sur `CLAUDE-CONTEXT.md` à chaque
PR concurrente, pre-commit hook qui régénère + auto-stage des vues à chaque
commit (effet de bord caché : le commit qu'on push ≠ celui qu'on a staged).

Cause racine : le projet maintient deux modes opérationnels qui se
chevauchent — l'incrémental Salsa (ADR-007, `codegraph watch`, sub-50ms
warm) coexiste avec un mode batch (`codegraph analyze` cold + snapshot
JSON cumulatif post-commit). Le batch trahit l'incrémental.

État de l'art étudié (2026-05-10) — convergence claire :

| Système | Persistence du graph | Vues dérivées commitées ? |
|---|---|---|
| rust-analyzer (= ton Salsa) | RAM only, refus délibéré du disk | Non |
| TypeScript `.tsbuildinfo` | Fichier local | Non |
| Bazel | CAS + AC local, optionnel remote | Non |
| Turborepo | Local + remote HTTP optionnel | Non |
| **Glean** (Meta, datalog-inspired) | RocksDB local | Non |
| Unison | DB content-addressed | Non (le code lui-même est hashé) |
| CodeQL (GitHub) | DB layered base+delta | Non |

**Aucun de ces systèmes ne commite la vue dérivée dans le SCM.** Le projet
est seul à le faire, et c'est ce qui crée les conflits structurels.

## How to apply

### Phase 1 (cet ADR — Accepted)

- **Gitignore** : `CLAUDE-CONTEXT.md`, `CHANGELOG-RECENT.md` retirés du
  tracking. Ce sont des projections paresseuses du snapshot+ADRs.
- **CLAUDE.md** root reste tracked (bootstrap Claude Code au clone) mais
  le pre-commit ne le régénère plus auto. L'humain le commit explicitement
  lors d'une release ou d'un changement structurel notable.
- **Pre-commit** : régénère le brief pour validation (drift warning sur
  stderr) mais **ne stage jamais** de vue dérivée. Le commit qu'on push
  est exactement celui qu'on a staged.
- **Snapshots cumulatifs** : `.codegraph/snapshot-<ts>-<sha>.json` ne sont
  plus accumulés. Le post-commit garde uniquement le snapshot HEAD (un
  seul fichier `snapshot-latest.json`, ou les 3 derniers pour debug).

### Phase 2 (planned, future ADR)

- Storage SQLite (ou JSON indexé) au lieu de blob JSON 3.3 MB.
- inputHash = content-hash des fichiers source qui ont produit ce snapshot.
- Hook `post-checkout` / `post-merge` : applique le delta Salsa si HEAD
  a bougé (sub-100ms typique).

### Phase 3 (planned, future ADR)

- Facts immutables identifiés par hash content-addressed (à la Glean / Unison).
- Layered DBs pour incremental PR review (à la CodeQL : base + delta).
- Vues paresseuses (brief, CLAUDE.md, dashboard) = queries sur la DB,
  jamais matérialisées en fichiers persistents.

### Phase 4 (optionnel, scaling)

- Si performance / collaboration le demande : passage RocksDB + query
  language Angle-like (Glean direct), ou remote cache HTTP (Turborepo /
  Bazel style) pour partager le snapshot du master HEAD via CI.

## Anti-patterns

- **Commiter une vue dérivée** "pour la visibilité GitHub". La visibilité
  s'obtient via un endpoint dashboard ou une commande CLI, pas en versionnant
  un fichier qui dérive du code.
- **Auto-stager dans un git hook**. Le commit doit être ce que l'humain
  a staged. Tout le reste est un effet de bord caché qui crée des conflits.
- **Accumuler des snapshots historiques en local**. Le déterminisme du
  pipeline garantit qu'à tout moment, `git checkout <sha> && codegraph
  analyze` reproduit le snapshot de ce commit. Pas besoin de stocker
  les anciens.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph-mcp/src/snapshot-loader.ts`
- `packages/codegraph-mcp/src/tools/changes-since.ts`
- `packages/codegraph/src/cli/_shared.ts`
- `packages/codegraph/src/cli/commands/diff.ts`
- `packages/codegraph/src/cli/commands/refresh.ts`
- `packages/codegraph/src/incremental/input-hash.ts`
- `packages/codegraph/src/incremental/snapshot-store.ts`
- `packages/dashboard-server/src/routes/diff.ts`
- `packages/dashboard-server/src/routes/snapshot.ts`


## Detail

### Pourquoi pas un trust-store SHA-256 (à la RTK) ?

Considéré et rejeté. La surface d'injection (ADR title + rule) est étroite
et déjà couverte par la sanitization (PR #33). Un trust-store ajouterait
~250 lignes + UX `trust` pour protéger 2 strings courtes. ADR-027 traite
un problème différent (architecture des vues dérivées), pas la sécurité
des inputs.

### Pourquoi pas un daemon LSP-style (rust-analyzer) ?

Considéré mais sous-optimal pour ce projet. rust-analyzer est un IDE
single-process ; codegraph-toolkit a plusieurs consumers (hooks, dashboard,
CLI, watch). Glean's approach (RocksDB partagée multi-process) scale mieux.
Le `codegraph watch` reste pertinent comme file-watcher qui maintient la DB
à jour, mais il n'est plus la source d'autorité — c'est la DB qui l'est.

### Pourquoi Glean comme référence dominante ?

Glean fait *exactement* ce que codegraph-toolkit fait : facts about code,
Datalog-like query (Angle), schémas user-defined, incremental indexing par
DB layering. La convergence n'est pas un emprunt esthétique — c'est la
reconnaissance que Meta a déjà résolu ce problème spécifique en production.
Le projet construit littéralement un mini-Glean ; autant adopter ses
patterns prouvés.

### Migration

Aucune donnée n'est perdue. Les vues dérivées sont régénérables à tout
moment depuis le code source. Phase 1 ne change que :
1. Le contenu de `.gitignore`
2. Le comportement du pre-commit hook (validation, pas auto-stage)
3. Le comportement du post-commit hook (pas d'accumulation)

Les phases 2-4 sont planifiées séparément et auront leurs propres ADRs.

## References

- [Glean — Engineering at Meta](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/)
- [Incremental indexing with Glean](https://glean.software/blog/incremental/)
- [Unison — code as hashes](https://www.unison-lang.org/docs/the-big-idea/)
- [Incrementalizing Production CodeQL (arXiv 2308.09660)](https://arxiv.org/pdf/2308.09660)
- [rust-analyzer: Three Architectures for a Responsive IDE](https://rust-analyzer.github.io/blog/2020/07/20/three-architectures-for-responsive-ide.html)
- [Salsa serialization to disk · salsa-rs/salsa#10](https://github.com/salsa-rs/salsa/issues/10)
- ADR-007 (Salsa incremental) — préfigure cette direction
