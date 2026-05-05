---
# ─── Métadonnées structurées (YAML frontmatter) ─────────────────────────
# Lu par scripts/audit-doc-claims.mjs et l'extractor doc-claims.ts.
# Tous les champs en `relatedRules` / `relatedFiles` / `relatedAdrs` sont
# cross-checkés contre le filesystem à chaque `codegraph analyze`.
# Si un target n'existe plus → fact `DocStaleClaim` émis → règle
# `composite-doc-stale.dl` flag la divergence.

# type — catégorie du document (informatif, pas de validation stricte).
#   backlog : liste d'items à faire (rules Datalog, refactors, etc.)
#   plan    : plan d'exécution d'un sprint/phase (concret, daté)
#   roadmap : vue stratégique long-terme (niveaux, priorités)
#   reference : doc de référence stable (thresholds, integrations, conventions)
#   sprint  : sprint en cours ou clôturé
type: reference

# status — état du document (CRITIQUE pour l'audit).
#   active     : doc à jour, claims valides
#   shipped    : tous les items du backlog/plan sont livrés (devrait être
#                soit archivé, soit converti en reference)
#   deferred   : reporté, ne pas remettre en question avant trigger
#   superseded : remplacé par un autre doc (renseigner supersededBy)
status: active

# created / lastVerified — dates ISO (YYYY-MM-DD).
# `lastVerified` est le dernier moment où QUELQU'UN a confirmé que les
# claims du doc sont alignés avec le code. À mettre à jour manuellement
# au moment d'une review.
created: 2026-XX-XX
lastVerified: 2026-XX-XX

# relatedRules — noms de rules Datalog citées dans le doc.
# Cross-check : chaque entry doit correspondre à un fichier .dl existant
# (composite-X.dl ou runtime-X.dl). Si absent du repo → claim "rule à
# coder", sinon → claim "rule shipped, à mentionner avec ✓".
relatedRules: []

# relatedFiles — chemins relatifs depuis la racine du repo.
# Cross-check : existence sur le filesystem. Renames non suivis (le doc
# devra être mis à jour à la main si un fichier bouge).
relatedFiles: []

# relatedAdrs — IDs `ADR-NNN`.
# Cross-check : existence de docs/adr/NNN-*.md.
relatedAdrs: []

# supersedes / supersededBy — chaînes de remplacement entre docs.
# Quand on retire un doc, plutôt que delete : status: superseded +
# supersededBy: docs/nouveau.md. Préserve git blame + permet de retrouver
# la décision originale.
supersedes: null
supersededBy: null
---

# <Titre du document>

> One-liner qui mord — quel problème ce doc résout, pour qui, et quand
> il devient périmé.

## Contexte

Pourquoi ce doc existe. 3-5 lignes. Idéalement un cas concret (date,
symptôme, impact mesuré).

## Verifiable claims

> Section structurée pour permettre l'audit déterministe. Chaque claim
> doit être cross-checkable contre le code/filesystem/git.

### Rules attendues

Liste des rules Datalog que ce doc vise à produire ou documenter. Format
checkbox markdown : `[x]` shipped, `[ ]` TODO.

- [ ] `composite-X` — description courte
- [x] `composite-Y` — shipped v0.X.0

### Fichiers concernés

> Liste les fichiers source/scripts que ce doc référence. Le path est
> relatif depuis la racine du repo. Cross-checké contre le filesystem
> au prochain `analyze` — un fichier qui n'existe plus → violation
> `COMPOSITE-DOC-STALE-FILE`.
>
> Exemples du template (commentés pour ne pas déclencher de violation
> sur le template lui-même) :
> - <!-- packages/codegraph/src/path/to/file.ts --> rôle dans le doc
> - <!-- scripts/script.mjs --> rôle dans le doc

### ADRs ancrés

- `ADR-NNN` — la règle architecturale qui justifie ce doc

## Body

Contenu libre. Sections autant qu'on veut. Tout ce qui est cross-checkable
doit être dans `Verifiable claims` ci-dessus, pas ici.

## Stale signals

> Quand ce doc devient périmé. Auto-référence : si l'un des cas listés
> survient, le status doit passer à `shipped` ou `superseded`.

- Si toutes les rules `[ ]` sont passées `[x]` → status: shipped, mover
  le doc en archive ou convertir en reference.
- Si plus de 6 mois sans `lastVerified` mis à jour → review forcée.
- Si supersédé par un nouveau doc → status: superseded + supersededBy.

## Detail (optionnel)

Si besoin de creuser : raisonnement long, alternatives rejetées, trade-offs.
Aucune obligation — un doc utile peut s'arrêter à `Stale signals`.
