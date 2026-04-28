# codegraph-toolkit

> Garde la mental map de ton projet TypeScript synchrone avec le code, et donne à ton agent IA un brief précis avant chaque session.

```bash
# Install (à faire une fois)
curl -fsSL https://raw.githubusercontent.com/Mwarfy/codegraph-toolkit/master/install.sh | bash

# Dans n'importe quel projet TS
cd ton-projet
npm link @liby/codegraph @liby/adr-toolkit
npx adr-toolkit init --with-claude-settings
```

3 commandes. Tu écris ton premier ADR, tu poses un marqueur `// ADR-001` dans le code, et le toolkit régénère automatiquement la doc à chaque commit.

## Pourquoi

Sans infra partagée, chaque projet recommence de zéro la cartographie + la gouvernance docs↔code. L'agent IA dérive, le projet est abandonné après quelques semaines. Avec : la mental map est rendue déterministe et les invariants tiennent — c'est une infra de **concentration** plus qu'une infra de code.

## Ce que ça fait

- **Cartographie automatique** — `codegraph analyze` produit un snapshot des imports, événements, hubs, dead exports, cycles. Synopsis C4 (Level 1/2/3) markdown auto-généré, **zéro LLM**, déterministe.
- **ADRs gouvernés par le code** — tu poses `// ADR-013` au top d'un fichier, la section `## Anchored in` de l'ADR se régénère automatiquement. Renames absorbés gratuitement (le marqueur suit le code).
- **Asserts ts-morph** — les claims sémantiques d'un ADR (`fonction X existe`, `Y est de type Set<string>`) deviennent exécutables. Renomme un symbole, le check pète, l'ADR doit être mise à jour.
- **Boot brief** — `CLAUDE-CONTEXT.md` régénéré à chaque commit. Liste les ADRs actifs, les fichiers gouvernés, les hubs critiques, les invariants. C'est ce que ton agent IA lit en début de session.
- **Hook Claude Code** — `adr-hook.sh` intercepte chaque Edit/Write et injecte les ADRs liés au fichier édité directement dans le contexte du modèle (avant la modification).

## Exemple concret d'ADR

```md
---
asserts:
  - symbol: "kernel/scheduler#inFlightBlocks"
    type: "Set<string>"
---

# ADR-018: Scheduler anti-double-execution

## Rule
> Un même blockId ne peut JAMAIS tick deux fois en parallèle. Le verrou
> `inFlightBlocks: Set<string>` protège `jobHandler`.

## Why
Race condition vue le 2026-03-12 : deux ticks BullMQ concurrents pour le
même block ont écrit deux jobs à la queue → double exécution.

## How to apply
- Avant chaque tick : `if (inFlightBlocks.has(id)) return`
- Après le tick : `inFlightBlocks.delete(id)` dans `finally`

## Anchored in
<!-- AUTO-GÉNÉRÉ — ne pas éditer -->
- `kernel/scheduler.ts`
```

Tu poses `// ADR-018` au top de `kernel/scheduler.ts`. À chaque commit, le toolkit vérifie que `inFlightBlocks` est toujours un `Set<string>`. Si quelqu'un le renomme en `_inFlight`, le check pète.

## Quickstart détaillé

### 1. Installer le toolkit (une fois par machine)

```bash
curl -fsSL https://raw.githubusercontent.com/Mwarfy/codegraph-toolkit/master/install.sh | bash
```

Ça clone le repo dans `~/Documents/codegraph-toolkit`, build les 2 packages, et expose les binaires `codegraph` + `adr-toolkit` via `npm link`.

Alternative si tu préfères contrôler manuellement :
```bash
git clone https://github.com/Mwarfy/codegraph-toolkit.git ~/Documents/codegraph-toolkit
cd ~/Documents/codegraph-toolkit
nvm use && npm install && npm run build && npm link --workspaces
```

### 2. Activer dans ton projet

```bash
cd ton-projet
npm link @liby/codegraph @liby/adr-toolkit
npx adr-toolkit init --with-claude-settings
```

`init` détecte ton layout (simple `src/`, monorepo `backend+frontend`, `apps/*`, `packages/*`) et scaffolde tout :
- `.codegraph-toolkit.json` — config du toolkit
- `codegraph.config.json` — config du codegraph (include/exclude/detectors)
- `docs/adr/_TEMPLATE.md` + `INDEX.md` — modèle d'ADR
- `scripts/git-hooks/{pre,post}-commit` + `adr-hook.sh` — hooks
- `git config core.hooksPath` — active les hooks
- `.claude/settings.json` — wire le hook Claude Code (avec `--with-claude-settings`)

### 3. Premier ADR

```bash
cp docs/adr/_TEMPLATE.md docs/adr/001-mon-invariant.md
# édite : Rule, Why, asserts si pertinent
```

Pose un marqueur au top du fichier ancré :
```ts
// ADR-001: rôle court (optionnel)
export class FooService { ... }
```

### 4. Régénération + brief

```bash
npx adr-toolkit regen     # met à jour ## Anchored in dans l'ADR
npx codegraph analyze     # snapshot + synopsis
npx adr-toolkit brief     # CLAUDE-CONTEXT.md
git commit -am "feat: ADR-001"
```

Le pre-commit hook prend le relais à chaque commit suivant : régen + brief automatiques, drift bloqué.

## Layouts supportés

| Layout | Détection | Config générée |
|---|---|---|
| Simple | `src/` à la racine | `srcDirs: ["src"]`, tsconfig: `tsconfig.json` |
| Fullstack monorepo | `backend/src/` + `frontend/` | `srcDirs: ["backend/src", "shared/src", "frontend"]`, tsconfig: `backend/tsconfig.json` |
| Workspaces monorepo | `apps/*` ou `packages/*` | `srcDirs: ["apps", "packages"]` |
| Flat | Rien d'évident | Fallback minimal — ajuste `srcDirs` à la main |

## Configuration

Le toolkit lit `.codegraph-toolkit.json` à la racine :

```json
{
  "rootDir": ".",
  "adrDir": "docs/adr",
  "srcDirs": ["src"],
  "tsconfigPath": "tsconfig.json",
  "briefPath": "CLAUDE-CONTEXT.md",
  "anchorMarkerExtensions": ["ts", "tsx", "sh", "sql"],
  "hubThreshold": 15,
  "invariantTestPaths": ["tests/unit/*-invariant.test.ts"],
  "briefCustomSections": [
    {
      "placement": "after-anchored-files",
      "markdown": "Note projet-spécifique injectée dans le brief..."
    }
  ]
}
```

`briefCustomSections` permet d'injecter du markdown projet-spécifique dans le brief (ex: liens vers ta MAP.md, notes sur les hooks Claude Code) sans forker le toolkit.

## CLI

```
adr-toolkit init [--with-claude-settings]
adr-toolkit regen [--check]
adr-toolkit linker <file>
adr-toolkit check-asserts [--json]
adr-toolkit brief
adr-toolkit install-hooks

codegraph analyze [-c <config>] [--map] [--no-save]
codegraph synopsis [snapshot] [--level 1|2|3]
codegraph orphans [snapshot]
codegraph exports [snapshot]
codegraph diff <prev> <new>
```

## API programmatique

```ts
import {
  loadConfig, regenerateAnchors,
  loadADRs, matches, findAdrsForFile,
  checkAsserts, generateBrief, initProject,
} from '@liby/adr-toolkit'

import { analyze, buildSynopsis, collectAdrMarkers } from '@liby/codegraph'
```

## Hook Claude Code

`adr-hook.sh` intercepte chaque Edit/Write/MultiEdit et injecte la liste des ADRs liés au fichier en `additionalContext`. L'agent IA voit le bloc `📋 ADR check` AVANT la modification.

`init --with-claude-settings` wire ça automatiquement. Vérification :
```bash
cat .claude/settings.json
```

## Pièges connus

- **`workspace:*`** : npm ne supporte pas le protocole pnpm. Utiliser `"*"` pour les deps inter-workspaces.
- **Node ≥22** : nécessaire pour vitest 4. Les hooks doivent sourcer nvm (déjà fait dans les templates).
- **Marqueurs en prose** : `// cf. ADR-013` ne match pas, le matcher exige `ADR-NNN` en début de commentaire.
- **Suffix matching strict** : anchor sans `/` (ex: `index.ts`) ne fait PAS de suffix match — sinon il matcherait 50 fichiers.
- **`git config core.hooksPath`** est local, pas versionné. `init` le set, mais sur un nouveau clone il faut relancer `npx adr-toolkit install-hooks`.

## Convention zéro LLM

Le synopsis builder (`@liby/codegraph buildSynopsis`) est **pur** : aucun I/O, aucun LLM, aucun random. Même snapshot → output JSON byte-équivalent. C'est le cœur de la mental map déterministe et reproductible. Test `synopsis-determinism` verrouille cette propriété.

## Bootstrap agentique (auto-rédaction de drafts)

`adr-toolkit bootstrap` lance des agents Sonnet ciblés pour rédiger des **drafts** d'ADRs depuis les patterns détectés. L'agent ne décide pas du périmètre (codegraph le fait), l'humain reste le filtre final.

**3 modes d'invocation** :
- `--mode auto` (default) — utilise **Claude CLI** s'il est installé (auth via keychain, pas besoin de clé), sinon fallback sur Anthropic SDK.
- `--mode cli` — force Claude CLI (échoue si absent).
- `--mode sdk` — force Anthropic SDK avec `ANTHROPIC_API_KEY`.

```bash
# Si tu as Claude Code installé, ça marche directement :
npx adr-toolkit bootstrap --max 5             # dry-run, 5 candidats
npx adr-toolkit bootstrap --apply --only-confidence high,medium    # écrit ADRs + marqueurs

# Sinon avec une clé API :
export ANTHROPIC_API_KEY=sk-ant-...
npx adr-toolkit bootstrap --mode sdk --max 5
```

**Architecture en 3 rôles séparés (le cadrage)** :

| Niveau | Qui décide | Quoi |
|---|---|---|
| OÙ regarder | codegraph + pattern detectors | détecte les candidats (singleton, hubs, FSM, etc.) |
| COMMENT formuler | agent Sonnet (prompt cadré, output JSON) | rédige Rule + Why + asserts depuis le code |
| QUOI accepter | humain (CLI revue + `--apply`) | valide / édite / rejette |

**Garde-fous anti-dérive** :
- Why halluciné → forcer à citer commentaire/git OU "TODO" → flag basse confiance
- Asserts inventés → checkAsserts AVANT d'écrire l'ADR
- Sur-génération → candidat vient de codegraph, pas du LLM
- Rule générique ("for consistency", "best practice") → flag basse confiance

**Status MVP** :
- ✅ Détection : pattern `singleton` (private static instance + getInstance)
- ⏳ Détection à venir : `fsm` (union string literals), `write-isolation` (seul writer DB), `hub` (in-degree ≥ threshold)
- ✅ Output : drafts avec Status: Proposed (relire avant Accepted)
- ✅ Confiance auto-calculée (high si Why cite source, low si TODO ou phrase générique)

## Roadmap

- **Détecteurs additionnels** pour bootstrap (fsm, write-isolation, hub).
- **Spawn parallèle** des agents (actuellement séquentiel).
- **Publication npm registry** — pour passer du `npm link` vers `npm install @liby/...`.

## Consommateurs

- **Sentinel** (référence) — 18 ADRs, 47 marqueurs, 11 ts-morph asserts.
- **Morovar** (en cours) — MMORPG TS.
- **<ton projet ?>** — ouvre une issue avec ton retour.
