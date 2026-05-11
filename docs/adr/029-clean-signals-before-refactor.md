# ADR-029: Signaux propres avant toute refonte motivée par codegraph

**Date:** 2026-05-11
**Status:** Accepted

## Rule

> Avant toute refonte motivée par un signal codegraph (co-change,
> complexity, dead-code, hub, doc-stale, etc.), vérifier que le signal
> n'est pas pollué par un artefact dérivé ou un détecteur cassé. Si le
> signal est pollué, **fix le détecteur d'abord** — c'est le chantier
> prioritaire absolu, car le toolkit ne peut pas violer sa propre
> raison d'être (= aider à décider sur des bases fiables).

## Why

Audit du 2026-05-11 — les 15 premiers co-change pairs du toolkit étaient
**tous** sur `CLAUDE-CONTEXT.md` ou `CHANGELOG-RECENT.md` :

```
j=19  CLAUDE-CONTEXT.md ↔ ast-facts-visitor.ts
j=17  CLAUDE-CONTEXT.md ↔ runner.ts
j=16  CLAUDE-CONTEXT.md ↔ core/types.ts
... [12 autres pareil]
```

Ces deux fichiers sont des vues dérivées (régénérées par `adr-toolkit
brief` au post-commit, gitignored depuis ADR-027 Phase 1). Ils
co-changent **mécaniquement** avec tout fichier source touché — pas
parce que les deux ont une dépendance logique, mais parce que le hook
les régénère.

Conséquence concrète : une décision "refactor ast-facts-visitor.ts
parce qu'il co-change beaucoup avec X" aurait été basée sur du bruit.
Les VRAIS co-change (= fichiers source qui bougent ensemble, indiquant
une abstraction manquante) étaient noyés sous les pairs CLAUDE-CONTEXT.

Le toolkit est conçu pour aider Marius + l'équipe à prendre des
décisions structurelles. Si le toolkit lui-même prend (ou suggère) des
décisions basées sur des signaux pollués, il viole sa raison d'être.
Tier-1 absolu.

## How to apply

- **Avant tout chantier "refacto X parce que signal Y"** : ouvrir les
  données brutes du détecteur Y (`codegraph synopsis`, `datalog-check
  --json`, lecture directe du snapshot). Confirmer que la liste top-N
  n'est pas dominée par des artefacts dérivés ou des cas non-représentatifs.

- **Tout détecteur qui consomme l'historique git** (co-change, churn,
  granger) DOIT respecter le `.gitignore` au moment du run (filtrer
  les paths gitignored, pas seulement les tracked-mais-deleted). Les
  vues dérivées sont une catégorie : ajouter un filtre `derivedPaths`
  configurable dans `codegraph.config.json` si besoin de marge.

- **Si un signal est pollué et coûte > 1h à fixer** : marquer le chantier
  cleanup en tier-1 absolu dans la prochaine batch de PRs. Ne pas
  empiler des refactors basés sur ce signal en attendant.

- **Ne JAMAIS écrire une liste de chantiers dans une ADR**. L'ADR
  codifie la RÈGLE d'évaluation (= ce processus), pas la liste de
  dette identifiée à un instant T. Les listes de TODO en ADR vieillissent
  en 1-2 mois et deviennent de la dette qui se prétend décision
  architecturale.

- **Cas limite : signal légitimement biaisé**. Ex. `dashboard-web/main.tsx`
  flaggé orphan = c'est un entry point React. Soluion = `entryPoints`
  dans config, pas un workaround dans l'analyse. Le détecteur reste
  correct ; on le calibre via config.

## Anti-patterns

- **Refacto sur "gut feeling"** sans pointer un signal mesuré et audité.
  Le toolkit existe pour éviter ça — l'utiliser à demi vide son intérêt.
- **Ignorer un signal pollué** parce que "trop compliqué à fixer maintenant"
  → la pollution se propage à tous les autres signaux qui en dépendent.
- **Confondre "signal indique X"** avec **"X est vraiment problème"** sans
  audit de la calibration du signal.
- **ADRs qui listent des chantiers** au lieu de codifier des règles.
  Ces ADRs deviennent stale en quelques mois et polluent l'INDEX.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->


## Detail

### Signaux à auditer en priorité (état au 2026-05-11)

Non-exhaustif. Cette liste documente ce qui a déclenché l'ADR — pas un
engagement de cleanup.

| Signal | Bug suspecté | Impact si on l'utilise tel quel |
|---|---|---|
| `coChangePairs` | Inclut vues dérivées gitignored | Top pairs faux → priorisation refacto inutile |
| `barrels low-value` | Flag les `packages/*/src/index.ts` (= APIs publiques) | Suggérerait de supprimer les barrels d'export |
| `orphan` | Flag `dashboard-web/src/main.tsx` (= entry React) | Suggérerait de supprimer le code utilisé |
| `await-in-loop` | Ne distingue pas streaming ordonné (légit) de I/O séquentiel (à fixer) | Liste de violations 50% faux positifs |

### Pourquoi pas une ADR par signal pollué ?

Considéré. Rejeté parce que :
1. Le pattern est unique (= "signal pollué"), pas N variations à codifier.
2. Une ADR par signal créerait du bruit (la liste vieillit, l'audit
   change).
3. La règle générique scale : tout nouveau détecteur ajouté hérite de
   l'exigence de calibration sans nouvelle ADR.

### Pourquoi pas un test automatisé ?

Possible mais hors scope de cette ADR. Idée future : une rule Datalog
qui pète si un fichier `derivedPath` (CLAUDE-CONTEXT.md, dist/,
.codegraph/) apparaît dans le top-N des co-change pairs. Ferait passer
la règle "signal propre" d'une discipline humaine à un gate CI. À
considérer si la discipline humaine glisse.

### Compatibilité avec le tooling existant

Cette ADR ne change AUCUN comportement runtime. Elle codifie un
processus d'évaluation pré-refonte. Aucune migration nécessaire.

## References

- ADR-001 — Synopsis builder pur (= signaux déterministes par construction)
- ADR-010 — Datalog runtime pure-TS déterministe (= reproductibilité des rules)
- ADR-027 Phase 1 — vues dérivées hors git (= origine de l'incident
  co-change pollué)
