<!-- AUTO-GÉNÉRÉ par @liby/adr-toolkit — NE PAS éditer à la main -->

# Boot Brief — codegraph-toolkit

> **À lire AVANT toute action.** Ce fichier est le state-of-the-architecture.
> Si tu modifies un fichier listé dans "Fichiers gouvernés par un ADR" ci-dessous,
> lis l'ADR correspondant AVANT d'éditer.

## Règles architecturales actives (ADRs)

- **ADR-001** — Le synopsis builder (`@liby/codegraph buildSynopsis`) ne fait aucun I/O, > n'invoque aucun LLM, n'utilise aucune source non-déterministe. Même > snapshot d'entrée → même output JSON byte-équivalent.
  → [`Synopsis builder = pur, zéro LLM`](docs/adr/001-synopsis-builder-pure.md)
- **ADR-002** — Aucun path / nom de projet consommateur (Sentinel, Morovar, etc.) ne > doit apparaître dans le code des packages `@liby/codegraph` ou > `@liby/adr-toolkit`. Tout vient de `.codegraph-toolkit.json` ou > `codegraph.config.json` chargés depuis le rootDir du consommateur.
  → [`Config-driven obligatoire — pas de hardcoded projet dans le code des packages`](docs/adr/002-config-driven-no-hardcoded-projects.md)
- **ADR-003** — Le default detector set (`createDetectors([])` ou `defaultDetectorNames()`) > exclut tous les détecteurs marqués `projectSpecific: true`. Pour les > activer, le consommateur doit les nommer explicitement dans > `codegraph.config.json` → `"detectors": [...]`.
  → [`Détecteurs généralistes par défaut, project-specific opt-in`](docs/adr/003-detectors-generaliste-vs-project-specific.md)
- **ADR-004** — Le bootstrap agentique sépare 3 rôles, et aucun ne franchit son périmètre : > > 1. **OÙ regarder** : codegraph + pattern detectors (déterministe). Le > LLM ne décide jamais quels fichiers méritent un ADR. > 2. **COMMENT formuler** : un agent Sonnet par candidat avec prompt > cadré et output JSON forcé. Le LLM rédige Rule + Why + asserts depuis > le code, rien d'autre. > 3. **QUOI accepter** : humain (CLI revue + `--apply` confirmé). Les > ADRs sont écrits avec `Status: Proposed`, jamais `Accepted`.
  → [`Bootstrap = 3 rôles séparés (codegraph détecte / LLM rédige / humain valide)`](docs/adr/004-bootstrap-trois-roles-separes.md)

## Fichiers gouvernés par un ADR (lookup pré-calculé)

- `packages/adr-toolkit/src/bootstrap-writer.ts` → ADR-004
- `packages/adr-toolkit/src/bootstrap.ts` → ADR-004
- `packages/adr-toolkit/src/config.ts` → ADR-002
- `packages/codegraph/src/detectors/block-loader.ts` → ADR-003
- `packages/codegraph/src/detectors/index.ts` → ADR-003
- `packages/codegraph/src/synopsis/builder.ts` → ADR-001

> **Dogfooding** : ce repo gouverne sa propre architecture via le toolkit qu'il publie. Les 4 ADRs ci-dessus encadrent les invariants critiques (zéro LLM dans synopsis, config-driven, séparation détecteurs, 3 rôles bootstrap).

## Tests d'invariant qui gardent ces règles

- `packages/*/tests/*.test.ts`

## Top hubs (fichiers les plus importés — gros risque de régression si touchés)

- `packages/codegraph/src/core/types.ts` (in: 45)
- `packages/adr-toolkit/src/config.ts` (in: 9) · gov by ADR-002
- `packages/codegraph/src/diff/types.ts` (in: 8)
- `packages/codegraph/src/check/types.ts` (in: 7)
- `packages/adr-toolkit/src/bootstrap.ts` (in: 3) · gov by ADR-004
- `packages/adr-toolkit/src/check-asserts.ts` (in: 3)
- `packages/codegraph/src/detectors/bullmq-queues.ts` (in: 3)
- `packages/codegraph/src/map/dsm-renderer.ts` (in: 3)

## ⚠ ADR anchor suggestions

Fichiers load-bearing (in-degree élevé ou truth-point) **sans aucun marqueur `// ADR-NNN`** dans le code. Intentionnel ? Sinon poser un marqueur ou créer un ADR :

- **45** `packages/codegraph/src/core/types.ts` _(top-hub)_

## Activité récente (14 derniers jours)

```
41f2ebd fix(bootstrap): 4 frictions identifiées sur test « fresh user »
6d4679c feat(adr-toolkit): bootstrap supporte Claude CLI (auto auth keychain)
d47beef docs: install.sh URL pointe sur /master/ (le repo GitHub utilise master)
7ff0154 docs: pointer install.sh + README vers github.com/Mwarfy
12c13c2 feat(adr-toolkit): bootstrap agentique MVP — singleton drafts via Sonnet (Phase D)
f738340 feat: install.sh one-liner + README "frère friendly" (Phase B+C)
8ea9073 feat(adr-toolkit): init scaffolde codegraph.config + .claude/settings (Phase A.4-A.5)
642f3fc fix(codegraph): départager généraliste / Sentinel-spécifique (Phase A.1-A.3)
4af6841 docs: README + CONTRIBUTING + CHANGELOG (Phase 7)
2f74c84 feat(adr-toolkit): briefCustomSections — injection markdown projet-spécifique
da487b1 feat(example): minimal hello-world consommateur
3b023f7 feat(adr-toolkit): extracted + config-driven
```

## Comment contribuer à ce brief

- Une nouvelle décision architecturale ? Crée un ADR via le template :
  `@liby/adr-toolkit/templates/_TEMPLATE.md`
- Le brief sera régénéré au prochain commit.
- Pour forcer une régen : `npx @liby/adr-toolkit brief`
