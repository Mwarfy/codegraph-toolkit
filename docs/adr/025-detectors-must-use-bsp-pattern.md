# ADR-025: Tout nouveau détecteur per-file doit suivre le pattern BSP monoïdal

**Date:** 2026-05-04
**Status:** Accepted
**Supersedes:** étend ADR-005 (detector-pattern-bundle-per-file)

## Rule

> Tout NOUVEAU détecteur ajouté à `extractors/` (readFile-based) DOIT
> partir du template `_template.monoid.ts` + `_template.monoid.worker.ts`
> et utiliser `runPerFileExtractor`. Aucun for-loop séquentiel +
> sort manuel — pattern interdit.

## Why

L'audit BSP (cf. ADR-024) a démontré qu'un pattern monoïdal uniforme
permet :
- déterminisme cross-thread garanti par théorème (Church-Rosser)
- migration mécanique vers worker_threads (gain × N cores)
- tests d'invariant simples (output = sequential fold)
- réduction mécanique du code (~50% lignes par détecteur)

Sans cette règle, le port reste manuel et perd le ROI architectural :
chaque nouveau détecteur écrit en pattern legacy = dette qu'il faudra
re-porter. Pour le coût marginal d'un copy-paste de template au début,
on amortit la migration future à zéro.

## How to apply

- **NOUVEAU détecteur readFile-based** :
  ```bash
  cp packages/codegraph/src/extractors/_template.monoid.ts \
     packages/codegraph/src/extractors/my-detector.ts
  cp packages/codegraph/src/extractors/_template.monoid.worker.ts \
     packages/codegraph/src/extractors/my-detector.worker.ts
  ```
  Renomme `XxxItem`, `XxxFileBundle`, `extractXxx*`, `analyzeXxx`,
  `XXX_WORKER_MODULE`, etc. Implémente la logique métier dans
  `extractXxxFileBundle` (pure fn).

- **NOUVEAU détecteur Project ts-morph** : utilise
  `runPerSourceFileExtractor` (cf. ADR-024). Mode worker pas supporté
  (Project non-sérialisable cross-thread, re-parse trop coûteux). Le
  pattern monoïdal s'applique quand même — gain Promise.all main thread.

- **MIGRATION détecteur existant** : opt-in. Pas obligatoire de re-porter
  les détecteurs legacy en bloc, mais quand on touche un détecteur (refactor,
  fix bug), porter d'abord au pattern monoïdal puis modifier. Cumulatif.

- **CE QUI EST INTERDIT** :
  - `for (const sf of project.getSourceFiles()) { ...push(...); ...sort() }`
  - State partagé entre files (sauf via paramètre injection explicite)
  - Closures dans `runPerFileExtractor.workerFn` quand on veut le mode worker

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->


## Tested by

- `packages/codegraph/tests/parallel-determinism.test.ts` (théorème de
  base + sort canonique)
- `packages/codegraph/tests/parallel-workers.test.ts` (cross-thread
  determinism)

## Detail

**Pourquoi pas obligatoire en migration** : porter les 50+ détecteurs
legacy d'un coup = grosse PR risquée. Préférer l'incrémental (8/65
portés à date) avec ratchet : chaque commit qui touche un détecteur
peut le porter, au coût marginal de ~10 lignes.

**Pourquoi le worker mode reste opt-in (env var)** : les détecteurs
triviaux (< 5ms) sont plus lents en worker (overhead postMessage compense
le gain). Le user choisit `LIBY_BSP_WORKERS=1` quand il sait que les
détecteurs touchés sont CPU-heavy. Future Phase γ : auto-tuning basé sur
le runtime profile (cost model decide per-detector).

**Future direction (Phase γ)** : intégrer ts-imports / cycles / NCD
qui restent séquentiels. Stratégie : sub-parallelization au sein de
ces algos (Pregel-style pour cycles, parallel Louvain pour communities).
Pas planifié à court terme.
