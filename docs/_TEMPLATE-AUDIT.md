---
type: reference
status: active
created: 2026-XX-XX
lastVerified: 2026-XX-XX
relatedRules: []
relatedFiles: []
relatedAdrs: []
---

# Audit <PROJET ou TOOLKIT> — <DATE>

> Snapshot empirique : compte de violations Datalog / findings karpathy /
> métriques codegraph à un moment T. Document immuable une fois écrit
> (sauf erreur factuelle) — un nouvel audit produit un nouveau fichier.

## Contexte

3-5 lignes : qu'est-ce qui est audité, sur quel commit, avec quelle commande.
Inclure les chiffres bruts (nb violations totales, nb tests, durée run).

Exemple :
- Cible : `/Users/smurfy/jules/happenin` @ commit `abc1234`
- Outil : `codegraph datalog-check --rules-dir <toolkit>/packages/invariants-postgres-ts/invariants`
- Run : 919ms, 438 violations totales, 67 par-rule

## Findings

Lister par sévérité ou par règle. Format flexible — l'important est qu'on
puisse retrouver chaque finding dans le code.

### F-XXX — <titre court>

- **Fichier** : `path/to/file.ts:LINE`
- **Règle** : `COMPOSITE-XXX`
- **Sévérité** : critical | high | medium | low
- **Description** : 1-2 lignes
- **Action** : (à remplir dans Plan d'action)

## Plan d'action

> ⚠️ **Convention obligatoire `verify:`** — chaque step doit avoir une
> commande mesurable qui prouve sa résolution. Sans `verify:`, le step
> est ignoré par `goal_verifier.py` (skill `karpathy-coder`) et flag
> l'audit comme "MISSING".
>
> Run pour scorer : `python3 ~/.claude/plugins/cache/claude-code-skills/karpathy-coder/<version>/skills/karpathy-coder/scripts/goal_verifier.py docs/AUDIT-XXX.md`
>
> Cible : score ≥ 24/36 (verdict PASS).

### <Section logique — projet ou priorité>

1. **<Action concrète>**
   - **Files** : `path/to/file.ts:42`, `path/to/other.ts:128`
   - **Pattern** : `ADR-NNN` ou rule `COMPOSITE-XXX`
   - **verify:** `<commande shell qui retourne 0/non-zero>` → expect <résultat>

2. **<Autre action>**
   - **verify:** `codegraph datalog-check --json | jq '.byRule["COMPOSITE-XXX"]'` → expect 0

### Exemples de `verify:` selon le type d'action

| Type d'action | `verify:` exemple |
|---|---|
| Refactor god-module | `wc -l <file>` → expect <500 |
| Split function trop longue | `python3 .../complexity_checker.py <file> --json \| jq '.findings[] \| select(.kind=="function-length")'` → expect 0 |
| Réduire violations Datalog | `codegraph datalog-check --json \| jq '.total'` → expect <N |
| Ajouter test | `npx vitest run <test-file>` → expect 0 failed |
| Fix cycle | `codegraph reach <from> <to> --json \| jq '.paths \| length'` → expect 0 |
| Supprimer dead exports | `codegraph exports --json \| jq '.totalUnused'` → expect <N |
| Pose marker `// await-ok` | `grep -c "// await-ok" <file>` → expect ≥ N |

## Métriques (avant/après)

> Si l'audit est un re-audit, comparer avec la baseline précédente.

| Métrique | Baseline | Aujourd'hui | Δ |
|---|---:|---:|---:|
| Violations Datalog | 423 | 438 | +15 |
| Tests qui passent | 820 | ? | ? |
| Durée analyze | ?s | ?s | ?s |

## Stale signals

- Tous les steps `verify:` retournent OK → ce doc passe `status: shipped`
- Plus de 30 jours sans re-audit → re-run pour mettre à jour les chiffres
- Le code analysé a changé de >20% → audit invalidé, refaire
