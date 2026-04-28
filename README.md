# codegraph-toolkit

Outils partagés pour cartographier et gouverner les projets TypeScript de Marius+Liby.

## Pourquoi

Sans infra partagée, chaque projet recommence de zéro la cartographie + la gouvernance docs↔code. L'agent dérive, le projet est abandonné après quelques semaines. Avec : la mental map est rendue déterministe et les invariants tiennent. C'est une infra de *concentration* plus qu'une infra de code.

## Packages

- **@liby/codegraph** — analyseur statique : graph, synopsis C4, dead-exports, cycles, truth-points, taint, etc.
- **@liby/adr-toolkit** — système de gouvernance docs↔code : ADR anchors regen, ts-morph asserts, brief generator, hooks templates.

`@liby/codegraph` est utilisable seul (analyse pure). `@liby/adr-toolkit` dépend de `@liby/codegraph`.

## Setup

```bash
nvm use && npm install && npm run build && npm test
```

## Consommateurs

- [Sentinel](../Sentinel) — projet de référence (extrait depuis ici)
- [Morovar](../morovar) — MMORPG (consommateur cible Phase 6)

Voir `examples/minimal/` pour un projet vierge "hello world".

## Convention

- Node ≥ 22 (vitest 4 exige)
- TypeScript strict
- Zéro LLM dans la chaîne synopsis (cf. ADR-009 historique Sentinel — préservé)
