<!-- AUTO-GÉNÉRÉ par @liby-tools/adr-toolkit — NE PAS éditer à la main -->
<!-- Compact boot pour Claude Code. Pour le détail, voir CLAUDE-CONTEXT.md ou les tools codegraph_* -->

# codegraph-toolkit

`364 files · 859 edges · 1 orphans · 19 tensions · health 100%`

## ADRs actives

- **ADR-001** — Synopsis builder = pur, zéro LLM
- **ADR-002** — Config-driven obligatoire — pas de hardcoded projet dans le code des packages
- **ADR-003** — Détecteurs généralistes par défaut, project-specific opt-in
- **ADR-004** — Bootstrap = 3 rôles séparés (codegraph détecte / LLM rédige / humain valide)
- **ADR-005** — Pattern détecteurs codegraph — bundle per-file + agrégat pure
- **ADR-006** — `core/types.ts` est le contract canonique — modifications conservatrices uniquement
- **ADR-007** — Salsa incremental — fileContent + sharedDb sont contrats canoniques
- **ADR-008** — detector-registry est le SEUL point d'enregistrement de détecteurs
- **ADR-009** — runtime-graph/core/types.ts = contrat canonique runtime
- **ADR-010** — Datalog runtime — pure-TS, deterministic, zero binary
- **ADR-011** — runtime-graph capture pipeline — OTel attach + span-to-fact projection
- **ADR-012** — Extractors `_shared/` — helpers ts-morph mutualisés
- **ADR-024** — Parallélisme déterministe par algèbre monoïdale (BSP)
- **ADR-025** — Tout nouveau détecteur per-file doit suivre le pattern BSP monoïdal
- **ADR-026** — Détecteurs comme rules Datalog sur facts AST denormalisés

> Texte complet d'un ADR : voir `docs/adr/` ou tool `codegraph_adr(N)`.
> Liste fichiers gouvernés : tool `codegraph_files_governed_by_adr(N)`.

## Top hubs (in-degree élevé — modifs à blast radius)

- `packages/codegraph/src/core/types.ts` (in: 85) · gov by ADR-006
- `packages/codegraph/src/incremental/queries.ts` (in: 42) · gov by ADR-007
- `packages/codegraph/src/incremental/database.ts` (in: 41) · gov by ADR-007

## Pour creuser (tools on-demand)

| Besoin | Tool |
|---|---|
| Synopsis ranké pour un focus | `codegraph synopsis --focus <file> --tokens N` |
| Top fichiers liés à un focus | `codegraph rank --focus <file>` |
| Violations live | `codegraph datalog-check` |
| Diff vs ref | `codegraph diff <ref>` |
| Affected files par BFS reverse | `codegraph affected <files>` |
| Brief complet historique | lire `CLAUDE-CONTEXT.md` |

## Hard rules (gotchas non-évidents — would removing cause mistakes ?)

- Snapshots `.codegraph/snapshot-*.json` sont auto-générés post-commit. Ne pas committer manuellement.
- Ce fichier (`CLAUDE.md`) ET le brief complet sont auto-régénérés. Ne pas éditer à la main.
- Datalog `.dl` rules : modifs cassent le baseline. Re-baseline avec `codegraph datalog-check --update-baseline`.
- Le hook codegraph-feedback (PostToolUse) injecte le contexte structurel à chaque Edit. Le hook adr-hook (PreToolUse) injecte l'ADR concerné si fichier gouverné.
