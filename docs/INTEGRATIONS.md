# Intégrations agents IA — portage Cursor / Aider / Cline / Copilot CLI

Le toolkit a été initialement écrit avec Claude Code en tête (hooks
`.claude/settings.json`, brief `CLAUDE-CONTEXT.md`, MCP server). Mais le
**cœur est agent-agnostique**. Cette page documente comment porter à un
autre agent IA sans patch du toolkit.

---

## Ce qui est portable nativement

| Surface | Format | Compatibilité |
|---|---|---|
| Mental map (`<briefPath>`, `MAP.md`, `synopsis-level{1,2,3}.md`) | Markdown standard | **Tout agent** lisant des fichiers |
| Datalog facts (`.codegraph/facts/*.facts`) | TSV | **Tout outil** — runner pure-TS sans dépendance Claude |
| Datalog rules (`*.dl`) | Texte plat | Idem |
| Snapshot (`.codegraph/snapshot-*.json`) | JSON | **Tout client MCP** ou consumer JSON |
| Hooks git (`pre-commit`, `post-commit`) | Bash | **Tout repo git** |

## Ce qui est Claude Code-specific

| Surface | Spécificité |
|---|---|
| `.claude/settings.json` hooks PreToolUse/PostToolUse | Format propre à Claude Code |
| Naming `CLAUDE-CONTEXT.md` | Convention Claude (configurable) |
| MCP server `@liby-tools/codegraph-mcp` | Protocole MCP — fonctionne avec **tout client MCP** (pas seulement Claude) |

---

## Portage à Cursor

Cursor lit le contexte projet via `.cursorrules` ou `.cursor/rules/`. Wire le brief :

**1. Renommer le brief** dans `.codegraph-toolkit.json` :
```json
{
  "rootDir": ".",
  "briefPath": ".cursor/rules/architecture.mdc"
}
```

Le brief sera désormais émis dans `.cursor/rules/architecture.mdc` à
chaque commit (post-commit hook). Cursor le pickera automatiquement
en début de session.

**2. Hooks git** : le toolkit installe des `pre-commit` + `post-commit`
hooks via `npx adr-toolkit install-hooks`. Pas spécifique Claude — ils
tournent au niveau git, indépendants de l'agent.

**3. MCP** : Cursor supporte MCP nativement. Ajoute dans `.cursor/mcp.json` :
```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph-mcp",
      "cwd": "."
    }
  }
}
```

---

## Portage à Aider

Aider lit `CONVENTIONS.md` et tout fichier dont le nom est listé via `--read`.

**1. Renommer le brief** dans `.codegraph-toolkit.json` :
```json
{
  "rootDir": ".",
  "briefPath": "CONVENTIONS.md"
}
```

**2. Lancer aider avec** :
```bash
aider --read MAP.md --read .codegraph/synopsis-level1.md
```

Aider n'a pas de support MCP natif — pour exposer les queries du toolkit,
utiliser le CLI direct dans une terminal-tool ou une sub-instance.

---

## Portage à Cline (VS Code extension)

Cline lit les fichiers du workspace standard. Le brief est lu au démarrage
de session si nommé `.clinerules` ou via `.cline/system-prompt.md`.

**1. Renommer le brief** :
```json
{
  "briefPath": ".clinerules/architecture.md"
}
```

**2. MCP** : Cline supporte MCP via la config VS Code de l'extension.
Format identique à Cursor.

---

## Portage à GPT / Claude API direct (pas d'agent)

Si tu fais un script qui appelle GPT/Claude directement :

```ts
import { readFileSync } from 'node:fs'

const systemPrompt = `
${readFileSync('CLAUDE-CONTEXT.md', 'utf-8')}

${readFileSync('.codegraph/synopsis-level1.md', 'utf-8')}
`
// Send to your chosen LLM with this prompt as context.
```

Le brief est ~10kB markdown — économique à inclure en system message.

---

## Tableau de mapping

| Tu utilises | Renomme `briefPath` en | Hook MCP |
|---|---|---|
| Claude Code | `CLAUDE-CONTEXT.md` (default) | `.mcp.json` racine |
| Cursor | `.cursor/rules/architecture.mdc` | `.cursor/mcp.json` |
| Aider | `CONVENTIONS.md` | — (pas de MCP natif) |
| Cline | `.clinerules/architecture.md` | VS Code config |
| Copilot CLI | `BOOT-BRIEF.md` (lecture manuelle) | — |

---

## Roadmap portabilité

- [ ] Hook generator générique (cible : équivalent `.claude/settings.json` mais format de l'agent)
- [ ] CLI `adr-toolkit init --agent cursor|aider|cline|claude` qui détecte ou demande, puis génère la bonne config
- [ ] Doc séparée par agent dans `docs/integrations/<agent>.md` avec captures + exemples PR

Pour proposer le portage à un agent non listé : ouvrir une issue avec
ton workflow + ce qui te manque.
