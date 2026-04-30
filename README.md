# codegraph-toolkit

> Garde la mental map de ton projet TypeScript synchrone avec le code, et donne à ton agent IA un brief précis avant chaque session.

```bash
# Install (à faire une fois)
npm install -g @liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/codegraph-mcp

# Dans n'importe quel projet TS
cd ton-projet
npx adr-toolkit init --with-claude-settings
```

2 commandes. Tu écris ton premier ADR, tu poses un marqueur `// ADR-001` dans le code, et le toolkit régénère automatiquement la doc à chaque commit.

> **Mode dev** (contributeurs au toolkit) : utilise `curl -fsSL https://raw.githubusercontent.com/Mwarfy/codegraph-toolkit/master/install.sh | bash -s -- --dev` pour cloner + npm link en local.

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
npm install -g @liby-tools/codegraph @liby-tools/adr-toolkit @liby-tools/codegraph-mcp
```

Expose les binaires `codegraph`, `adr-toolkit`, `codegraph-mcp` globalement.

**Mode dev** (contribuer au toolkit) :
```bash
curl -fsSL https://raw.githubusercontent.com/Mwarfy/codegraph-toolkit/master/install.sh | bash -s -- --dev
```
Clone dans `~/Documents/codegraph-toolkit`, build, `npm link --workspaces`. Modifs au source sont live.

### 2. Activer dans ton projet

```bash
cd ton-projet
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
} from '@liby-tools/adr-toolkit'

import { analyze, buildSynopsis, collectAdrMarkers } from '@liby-tools/codegraph'
```

## Hook Claude Code

`adr-hook.sh` intercepte chaque Edit/Write/MultiEdit et injecte la liste des ADRs liés au fichier en `additionalContext`. L'agent IA voit le bloc `📋 ADR check` AVANT la modification.

`init --with-claude-settings` wire ça automatiquement. Vérification :
```bash
cat .claude/settings.json
```

## codegraph-mcp — architecture queryable on-demand

Au-delà du push automatique via hook, `@liby-tools/codegraph-mcp` expose le snapshot codegraph comme MCP server. 5 outils architecturaux complémentent un éventuel LSP MCP :

| Tool | Use case |
|---|---|
| `codegraph_context(file)` | Bloc de contexte d'un fichier on-demand (HIGH-RISK header, importers, exports problématiques, cycles, truth-points, long fns, magic, coverage). |
| `codegraph_who_imports(file)` | Liste FILE-level des dépendants (≠ LSP find_references qui est SYMBOL-level). |
| `codegraph_truth_point_for(file)` | Participation aux truth-points (writers/readers/mirrors par concept). |
| `codegraph_recent(file, weeks?)` | Git archaeology : commits, top contributor, file age. |
| `codegraph_uncovered(critical_only?)` | Fichiers sans test rankés par criticité (truth-point writers + hubs). |

Wire dans le `.mcp.json` du consommateur :

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph-mcp",
      "cwd": "/path/to/your/project"
    }
  }
}
```

LSP fait du **sémantique fin-grained** (symbols, types, refs). codegraph-mcp fait du **structurel coarse-grained** (fichiers, ADRs, SSOT, dette). Les deux ensemble : architecture push+pull symétrique.

## Mode incremental (Salsa)

`codegraph analyze --incremental` route le pipeline via `@liby-tools/salsa` (runtime de computation incrémentale maison, ~600 LOC pure-TS). Sur Sentinel : warm 149ms (vs 21s legacy → 99% plus rapide). Mode `codegraph watch` daemon avec fs.watch + persistence disque + delta saves pour usage IDE/dev local.

14/14 détecteurs Salsa-isés. Mode legacy entièrement préservé pour les outils qui en dépendent.

## Détecteurs déterministes additionnels

En plus de la cartographie de base, codegraph capture les signaux de dette assumée :

- **todos** — TODO/FIXME/HACK/XXX/NOTE markers avec file + line + message.
- **long-functions** — fonctions/méthodes >100 LOC (configurable). Complement de cyclomatic complexity.
- **magic-numbers** — littéraux hardcodés en positions suspectes (timeouts, thresholds, ratios). Candidats migration env-driven.
- **test-coverage** — coverage structurel (pas runtime) : pour chaque fichier source, liste les tests qui le couvrent (par naming convention OU par import).

## Pièges connus

- **`workspace:*`** : npm ne supporte pas le protocole pnpm. Utiliser `"*"` pour les deps inter-workspaces.
- **Node ≥22** : nécessaire pour vitest 4. Les hooks doivent sourcer nvm (déjà fait dans les templates).
- **Marqueurs en prose** : `// cf. ADR-013` ne match pas, le matcher exige `ADR-NNN` en début de commentaire.
- **Suffix matching strict** : anchor sans `/` (ex: `index.ts`) ne fait PAS de suffix match — sinon il matcherait 50 fichiers.
- **`git config core.hooksPath`** est local, pas versionné. `init` le set, mais sur un nouveau clone il faut relancer `npx adr-toolkit install-hooks`.

## Convention zéro LLM

Le synopsis builder (`@liby-tools/codegraph buildSynopsis`) est **pur** : aucun I/O, aucun LLM, aucun random. Même snapshot → output JSON byte-équivalent. C'est le cœur de la mental map déterministe et reproductible. Test `synopsis-determinism` verrouille cette propriété.

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

**Status v0.2.0** :
- ✅ Détection : `singleton` (private static instance + getInstance)
- ✅ Détection : `write-isolation` (truth-points avec UN seul writer — depuis snapshot codegraph)
- ✅ Détection : `hub` (in-degree ≥ threshold sans marqueur ADR existant)
- ⏳ Détection à venir : `fsm` (union string literals avec writes observables — AST analysis)
- ✅ Output : drafts avec Status: Proposed (relire avant Accepted)
- ✅ Confiance auto-calculée (high si Why cite source, low si TODO ou phrase générique)

## Roadmap

- **Détecteur `fsm`** — union string literals (`Status`, `State`, `Phase`, `Stage`) avec writes observables. AST analysis non-triviale, ~3-4h.
- **Spawn parallèle** des agents bootstrap (actuellement séquentiel).
- **Refactor profond `core/analyzer.ts`** — pattern visiteur / detector registry pour découper le god-file (1188 LOC, fonction `analyze()` à 855 lignes brutes / 591 LOC effectives). 2 sections déjà extraites en helpers, reste 13+ blocs. 1-2 jours dédiés, tests parité critiques.

## Done en v0.2.0

- ✅ Publication npm registry (`@liby-tools/*` sur npmjs.com)
- ✅ Détecteurs bootstrap `write-isolation` + `hub`
- ✅ Test invariant `GraphSnapshot` field set (ADR-006 — pas de breaking change sans deprecation)
- ✅ install.sh modernisé (`npm install -g` par défaut, `--dev` pour clone+link)

## Consommateurs

- **Sentinel** (référence) — 22 ADRs, 47+ marqueurs, 11 ts-morph asserts, 4 hooks Claude Code (PreToolUse ADR check + PostToolUse codegraph context + 2 MCP servers : LSP + codegraph).
- **Morovar** (en cours) — MMORPG TS.
- **<ton projet ?>** — ouvre une issue avec ton retour.
