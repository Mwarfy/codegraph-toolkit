# minimal-example

Hello-world consommateur de `@liby-tools/codegraph` + `@liby-tools/adr-toolkit`.

Démontre le scénario "j'ai un projet TS vierge, je veux poser un premier ADR
gouverné par marqueurs et un boot brief auto-généré".

## Setup

Depuis la racine du monorepo `codegraph-toolkit/` :

```bash
nvm use && npm install && npm run build
```

Ça install les workspaces, build les 2 packages, et symlinke les binaires
`codegraph` + `adr-toolkit` dans `node_modules/.bin/` de chaque package
(donc accessibles via `npx` ici).

## Le scénario en 5 étapes

### 1. Init

```bash
cd examples/minimal
npx adr-toolkit init
```

Crée :
- `docs/adr/_TEMPLATE.md` (modèle pour nouveaux ADRs)
- `docs/adr/INDEX.md` (squelette d'index)
- `scripts/git-hooks/{pre,post}-commit` + `adr-hook.sh`

`.codegraph-toolkit.json` est déjà commité dans cet example — `init` le
détecte et skip. Pour un projet vierge, il sera créé.

### 2. Premier ADR

`docs/adr/001-greeting-format.md` est déjà présent comme exemple. Le format :

```md
# ADR-001: Format de salutation

## Rule
> Toute salutation passe par `formatGreeting()` — pas de string concat ad-hoc.

## Anchored in
- (à régénérer)
```

### 3. Marqueur dans le code

`src/greeting.ts` porte un marqueur en tête :

```ts
// ADR-001: format canonique des salutations
export function formatGreeting(name: string): string { ... }
```

Le marqueur est un **commentaire** au top du fichier — pas une référence
prose. Convention : `// ADR-NNN[: rôle court]`.

### 4. Régénération

```bash
npx adr-toolkit regen
```

Effet :
- Walk le code, collecte tous les `// ADR-NNN`
- Réécrit `## Anchored in` dans chaque ADR depuis ces marqueurs
- Survit aux renames (le marqueur suit le code)

### 5. Brief

```bash
npx codegraph analyze   # snapshot + synopsis
npx adr-toolkit brief   # CLAUDE-CONTEXT.md
```

`CLAUDE-CONTEXT.md` est le boot brief que l'agent (Claude) lit en début de
session avant toute action. Il liste :
- Les ADRs actifs (Rule + lien vers le doc)
- Les fichiers gouvernés (lookup file → ADRs[])
- Les top hubs (depuis codegraph synopsis)
- L'activité git récente

## Inspect

```bash
# Voir quels ADRs couvrent un fichier
npx adr-toolkit linker src/greeting.ts

# Output:
# # ADRs linked to src/greeting.ts
# ## ADR-001 — Format de salutation
# > Toute salutation passe par `formatGreeting()` — pas de string concat ad-hoc.
```

## Hooks

Le `init` a posé 3 hooks dans `scripts/git-hooks/`. Pour les activer :

```bash
git init    # si pas déjà un repo
npx adr-toolkit install-hooks   # set core.hooksPath + chmod +x
```

Effet :
- **pre-commit** : `regen --check` + `brief` (auto-stage les régen)
- **post-commit** : `codegraph analyze` + `brief`
- **adr-hook.sh** : intercepte les Edit/Write Claude Code et injecte la
  liste des ADRs liés au fichier édité (cf. `.claude/settings.json` dans le
  projet consommateur)
