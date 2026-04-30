<!-- AUTO-GÉNÉRÉ par @liby-tools/adr-toolkit — NE PAS éditer à la main -->

# Boot Brief — minimal

> **À lire AVANT toute action.** Ce fichier est le state-of-the-architecture.
> Si tu modifies un fichier listé dans "Fichiers gouvernés par un ADR" ci-dessous,
> lis l'ADR correspondant AVANT d'éditer.

## Règles architecturales actives (ADRs)

- **ADR-001** — Toute salutation passe par `formatGreeting()` — pas de string concat ad-hoc.
  → [`Format de salutation`](docs/adr/001-greeting-format.md)

## Fichiers gouvernés par un ADR (lookup pré-calculé)

- `src/greeting.ts` → ADR-001

## Tests d'invariant qui gardent ces règles

- (aucun invariant configuré — voir `invariantTestPaths` dans .codegraph-toolkit.json)

## Top hubs (fichiers les plus importés — gros risque de régression si touchés)

- (snapshot codegraph absent — `npx @liby-tools/codegraph analyze`)

## Activité récente (14 derniers jours)

```
3b023f7 feat(adr-toolkit): extracted + config-driven
7674c96 feat(codegraph): extracted from Sentinel
c4adce8 init: workspaces + tsconfig + skeletons
```

## Comment contribuer à ce brief

- Une nouvelle décision architecturale ? Crée un ADR via le template :
  `@liby-tools/adr-toolkit/templates/_TEMPLATE.md`
- Le brief sera régénéré au prochain commit.
- Pour forcer une régen : `npx @liby-tools/adr-toolkit brief`
