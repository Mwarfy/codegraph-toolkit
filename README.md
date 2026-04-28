# codegraph-toolkit

Outils partagés pour cartographier et gouverner les projets TypeScript.

## Pourquoi

Sans infra partagée, chaque projet recommence de zéro la cartographie + la gouvernance docs↔code. L'agent dérive, le projet est abandonné après quelques semaines. Avec : la mental map est rendue déterministe et les invariants tiennent — c'est une infra de **concentration** plus qu'une infra de code.

## Packages

- **[@liby/codegraph](packages/codegraph)** — analyseur statique : graph dépendances, synopsis C4, dead-exports, cycles, truth-points, taint, etc. Utilisable seul.
- **[@liby/adr-toolkit](packages/adr-toolkit)** — gouvernance docs↔code : marqueurs `// ADR-NNN` → section `## Anchored in` auto-régénérée, ts-morph asserts (claims sémantiques exécutables), boot brief generator. Dépend de `@liby/codegraph`.

## Quickstart (nouveau projet)

```bash
# 1. Cloner le toolkit (à côté de tes projets)
cd ~/Documents
git clone <url> codegraph-toolkit
cd codegraph-toolkit && nvm use && npm install && npm run build

# 2. Publier les packages localement
npm link --workspaces

# 3. Dans ton projet TS
cd ~/Documents/mon-projet
npm link @liby/codegraph @liby/adr-toolkit

# 4. Scaffold ADR governance
npx adr-toolkit init

# 5. Activer les hooks
npx adr-toolkit install-hooks

# 6. Premier ADR
cp docs/adr/_TEMPLATE.md docs/adr/001-mon-invariant.md
# édite, puis pose `// ADR-001` au top du fichier ancré

# 7. Régén + brief
npx adr-toolkit regen
npx codegraph analyze
npx adr-toolkit brief    # → CLAUDE-CONTEXT.md
```

Voir [examples/minimal](examples/minimal) pour un projet vierge complet.

## Configuration `.codegraph-toolkit.json`

Le toolkit lit ce fichier à la racine du projet consommateur. Tous les champs ont des défauts raisonnables.

```json
{
  "rootDir": ".",
  "adrDir": "docs/adr",
  "srcDirs": ["src"],
  "tsconfigPath": "tsconfig.json",
  "briefPath": "CLAUDE-CONTEXT.md",
  "anchorMarkerExtensions": ["ts", "tsx", "sh", "sql"],
  "skipDirs": ["node_modules", "dist", ".next", ".codegraph", "coverage", ".git"],
  "hubThreshold": 15,
  "invariantTestPaths": ["tests/unit/*-invariant.test.ts"],
  "briefCustomSections": [
    {
      "placement": "after-anchored-files",
      "markdown": "> Note projet-spécifique injectée dans le brief..."
    }
  ]
}
```

`briefCustomSections` permet d'injecter du markdown projet-spécifique dans le brief sans forker le toolkit. Placements : `after-anchored-files`, `after-invariant-tests`, `after-recent-activity`.

## API

```ts
import {
  loadConfig,
  regenerateAnchors,
  loadADRs, matches, findAdrsForFile,
  checkAsserts,
  generateBrief,
  initProject,
} from '@liby/adr-toolkit'

import {
  analyze,
  buildSynopsis,
  collectAdrMarkers,
} from '@liby/codegraph'
```

## CLI

```
npx adr-toolkit init                Scaffold un nouveau projet
npx adr-toolkit regen [--check]     Régen ## Anchored in
npx adr-toolkit linker <file>       ADRs qui couvrent ce fichier
npx adr-toolkit check-asserts       ts-morph asserts (frontmatter YAML)
npx adr-toolkit brief               Régénère le boot brief
npx adr-toolkit install-hooks       Set core.hooksPath + chmod +x

npx codegraph analyze               Snapshot + synopsis L1/L2/L3
npx codegraph synopsis              Génère synopsis depuis snapshot existant
npx codegraph orphans               Liste les nœuds orphelins
npx codegraph exports               Dead exports candidates
npx codegraph diff <prev> <new>     Compare 2 snapshots
```

## Hooks (Claude Code)

`adr-hook.sh` est un PreToolUse hook Claude Code qui intercepte chaque Edit/Write/MultiEdit, identifie les ADRs liés au fichier édité, et les injecte en `additionalContext` (vu par le modèle AVANT la modification).

Format JSON output protocol — c'est un **piège fréquent** : un hook qui imprime sur stdout texte brut est invisible côté modèle. Voir `packages/adr-toolkit/src/hooks/adr-hook.sh`.

À ajouter à ton `.claude/settings.json` :

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "scripts/git-hooks/adr-hook.sh" }]
      }
    ]
  }
}
```

## Pièges connus

### Node version

Vitest 4 + rolldown exigent Node ≥ 22. Les hooks pre-commit doivent **sourcer nvm** explicitement, sinon ils tournent avec le node de login shell (souvent v20) et plantent silencieusement (`SyntaxError: ... styleText`). Les hooks templates du toolkit incluent ce sourcing.

### `workspace:*`

npm 10+ ne supporte pas le protocole `workspace:*` de pnpm. Utiliser `"*"` à la place pour les deps inter-workspaces — npm 7+ résout en local automatiquement quand le package est déclaré dans `workspaces`.

### Marqueurs ADR — convention de format

Doivent être en **début de commentaire**, pas en prose :
- ✓ `// ADR-013`
- ✓ `// ADR-013, ADR-018`
- ✓ `// ADR-013: rôle court`
- ✓ `# ADR-013` (bash/sql/yaml)
- ✗ `// cf. ADR-013 pour le contexte` (prose, skip)

### Suffix matching strict

Anchor sans `/` (ex: `index.ts`) ne fait PAS de suffix match — sinon il matcherait 50 fichiers `index.ts` du repo. Match identique uniquement.

### `git config core.hooksPath` est local

Pas versionné. Un nouveau clone perd les hooks silencieusement. Le projet consommateur doit appeler `adr-toolkit install-hooks` (ou équivalent dans son script `setup`).

## Consommateurs

- **[Sentinel](../Sentinel)** — projet de référence (extrait depuis ce toolkit, 18 ADRs, 47 marqueurs, 11 ts-morph asserts).
- **[Morovar](../morovar)** — MMORPG TS (consommateur cible Phase 6).

Ajouter un consommateur : la convention est de cloner ce toolkit voisin du projet (`~/Documents/<projet>` + `~/Documents/codegraph-toolkit`), `npm link --workspaces` ici puis `npm link @liby/codegraph @liby/adr-toolkit` dans le projet.

## Setup en local

```bash
nvm use && npm install && npm run build && npm test
```

39 tests vitest doivent passer (codegraph: 10, adr-toolkit: 29).

## Convention zéro LLM

Le synopsis builder (`@liby/codegraph buildSynopsis`) est **pur** : aucun I/O, aucun LLM, aucun random. Même snapshot → output JSON byte-équivalent. C'est le cœur de la mental map déterministe et reproductible. Préserver cette propriété est non-négociable (cf. test `synopsis-determinism`).
