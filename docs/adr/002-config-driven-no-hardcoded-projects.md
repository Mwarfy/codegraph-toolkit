---
asserts:
  - symbol: "config#loadConfig"
    exists: true
  - symbol: "config#CONFIG_FILENAME"
    exists: true
---

# ADR-002: Config-driven obligatoire — pas de hardcoded projet dans le code des packages

**Date:** 2026-04-29
**Status:** Proposed

## Rule

> Aucun path / nom de projet consommateur (Sentinel, Morovar, etc.) ne
> doit apparaître dans le code des packages `@liby/codegraph` ou
> `@liby/adr-toolkit`. Tout vient de `.codegraph-toolkit.json` ou
> `codegraph.config.json` chargés depuis le rootDir du consommateur.

## Why

Phase A.1-A.3 du refactor a corrigé 5+ paths Sentinel hardcoded :
`ts-imports.ts:27` (`sentinel-web/tsconfig.json`), `analyzer.ts:142`
(idem), `unused-exports.ts:403-406` (`sentinel-core/src` etc.),
`http-routes.ts:113` (`file.includes('sentinel-web/')`),
`ts-imports.ts:264` (commentaire `sentinel-web`). Tant que ces refs
existaient, le toolkit produisait silencieusement 0 edges sur tout
projet non-Sentinel (cf. premier test sur Morovar — `Files: 178,
Edges: 0` avant le fix). Le fail était silencieux donc invisible à
l'install.

## How to apply

- Le code des packages publiés (`packages/*/src/`) ne contient JAMAIS
  les chaînes `sentinel`, `morovar`, ou tout nom de consommateur.
- Pour ajouter une heuristique projet (ex: détecter monorepo
  `backend+frontend`), passer par `init.detectLayout()` qui produit
  une config — pas par un check inline.
- Pour la config codegraph : `config.tsconfigPath`, `config.detectors`,
  `config.include` etc. Tout est passé au runtime, jamais inféré depuis
  des path-prefixes.
- ANTI-PATTERN : `if (file.includes('sentinel/'))`, `path.join(rootDir,
  'mon-projet/...')`, `const SRC_DIRS = ['<projet>/src', ...]`.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby/adr-toolkit. NE PAS éditer à la main. -->

- `packages/adr-toolkit/src/config.ts` — config-driven obligatoire, pas de hardcoded projet


## Tested by

- _(pas de test invariant dédié — un grep "sentinel\|morovar" sur
  packages/*/src/ retournerait juste les commentaires "convention" et
  les exemples de doc, pas du code actif. À ajouter en CI : grep
  `--include='*.ts' -r 'sentinel\|morovar' packages/*/src/` doit
  retourner 0 hit dans une ligne de code exécutable.)_
