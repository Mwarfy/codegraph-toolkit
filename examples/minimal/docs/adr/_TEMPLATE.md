# ADR-NNN: <Titre court de la décision>

**Date:** YYYY-MM-DD
**Status:** Accepted | Superseded by ADR-XXX | Deprecated
**Supersedes:** ADR-XXX (optionnel)

## Rule

> Une seule phrase qui mord. La règle qu'un dev relira en début de session
> et qui dictera son comportement sans lire le reste.

## Why

3-5 lignes. La raison concrète, idéalement un cas vécu (date, symptôme, impact).
Pas de "pour la cohérence" / "pour la maintenabilité" — du factuel reproductible.

## How to apply

3-5 puces actionnables :
- Ce qu'on FAIT (avec import / fonction concrète)
- Ce qu'on NE FAIT PLUS (anti-pattern)
- Cas limite + résolution

## Anchored in

> **AUTO-GÉNÉRÉ depuis les marqueurs du code.** Ne pas remplir cette section
> à la main — `scripts/regenerate-adr-anchors.ts` la réécrit à chaque commit
> depuis les marqueurs `// ADR-NNN` (ou `# ADR-NNN` pour bash/sql) posés au
> top des fichiers source.
>
> Pour ancrer un fichier à cet ADR : poser un marqueur en début de fichier :
> ```ts
> // ADR-NNN
> ```
> Multi-ADR sur le même fichier : `// ADR-NNN, ADR-MMM`.
> Le pre-commit hook régénère + auto-stage la section. Si le marqueur dans
> le code est supprimé, le fichier disparaît de la liste automatiquement.
> Renames de fichiers absorbés gratuitement (le marqueur suit le code).

## Tested by

> Optionnel mais fortement recommandé. Si `## Tested by` cite un fichier
> `tests/unit/*.test.ts`, ajoute-le aussi à la liste du pre-commit hook
> (`scripts/git-hooks/pre-commit`) — sinon le test existe mais ne gate pas
> les commits.

- `tests/unit/X-invariant.test.ts` (test qui pète si la règle est violée)
- `kernel/Y.ts:assertX()` (boot guard, optionnel)

## Detail

Si besoin de creuser : raisonnement long, alternatives rejetées, migration,
trade-offs. Aucune obligation — un ADR utile peut s'arrêter à `Tested by`.
