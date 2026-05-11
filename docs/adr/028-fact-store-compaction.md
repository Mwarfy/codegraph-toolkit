# ADR-028: Compaction du fact-store content-addressed

**Date:** 2026-05-11
**Status:** Accepted

## Rule

> Le fichier `.codegraph/facts.store.ndjson` (ADR-027 Phase 3) est
> append-only par construction (immuabilité content-addressed). Pour
> que sa taille reste bornée, on supprime périodiquement les facts qui
> ne sont plus référencés par AUCUN head/base actif :
>
>   `referenced = facts.head.json ∪ (N derniers facts.bases/*.json)`
>
> avec N configurable (default 10, LRU par mtime). La compaction
> s'auto-déclenche au post-analyze si `orphans/total > 30%` OU
> `store > 50 MB`. Une commande manuelle `codegraph compact` reste
> disponible pour forcer.

## Why

Sans compaction, chaque PR ajoute ~3 000 facts en moyenne au store. Au
rythme observé sur le toolkit (plusieurs PR/jour à 2 devs + IA), la
projection donne :

| Cadence | 1 mois | 3 mois | 1 an |
|---|---|---|---|
| 5 PR/jour | 150 MB | 450 MB | 1.5 GB |
| 10 PR/jour | 300 MB | 900 MB | **3 GB** |

À 1 an, le store devient ingérable (parse lent, RAM, GC pressure).
Pourtant la grande majorité des facts accumulés ne sont jamais
re-référencés — ce sont des états transitoires de fichiers édités.

Le content-addressing rend la compaction triviale : un fact est
réutilisable seulement s'il est listé dans un head/base actif. Tout le
reste est de l'historique sans valeur.

État de l'art : Glean (Meta) compacte RocksDB en arrière-plan via les
mécanismes natifs de la lib ; CodeQL purge les DBs PR après merge ;
Git GC supprime les blobs unreferenced après expiration des reflogs.
Le pattern est universellement reconnu.

## How to apply

### Algorithme

```text
1. referenced = union(
     facts.head.json.byRelation.values(),
     facts.bases/<sha>.json[*].byRelation.values()  for last N bases (LRU)
   )
2. Stream facts.store.ndjson line-by-line.
3. Garde line.id ∈ referenced, drop sinon.
4. Écrit tmp file, rename atomique.
5. Logue stats : removedCount, freedBytes, durationMs.
```

### Triggers

- **Manuel** : `codegraph compact [--dry-run]`
- **Auto post-analyze** : déclenché si une des conditions est vraie :
  - `orphans / total > 0.30` (default)
  - `store size > 50 MB` (default)
- **Configurable** via `codegraph.config.json` :
  ```json
  {
    "factStore": {
      "maxOrphanRatio": 0.30,
      "maxSizeBytes": 52428800,
      "keepBases": 10
    }
  }
  ```

### Bases gardées (N=10 LRU)

Au-delà de N bases, les `.json` les plus anciens (par mtime) sont
supprimés AVANT compaction. Les fact_ids qu'ils référenaient deviennent
orphelins éligibles à compaction.

Justification N=10 : à 5 PR/jour, ça donne 2 jours de bases (raisonnable
pour PR review concurrente). À 1 PR/semaine, ça donne 10 semaines
(largement). L'utilisateur peut tuner via config.

### Atomicité

- Tmp file `facts.store.ndjson.compacting` écrit ligne par ligne.
- `fs.rename(tmp, final)` est atomique sur tous les FS UNIX et NTFS.
- En cas de crash entre stream + rename : le tmp est orphelin, le store
  original reste intact. Le prochain `compact` cleanup le tmp.
- Pas de lock global : 2 analyzes concurrents peuvent compacter en
  parallèle ; un perd, l'autre gagne (file disparu = no-op silencieux).

### Migration

Aucune. Les stores existants restent lisibles. La première compaction
réécrit le fichier en gardant les fact_ids référencés.

## Anti-patterns

- **Compacter à la lecture** : trop coûteux à chaque `analyze`. La
  compaction est un sous-process distinct, déclenché par seuil.
- **Compacter dans un git hook bloquant** : les hooks sont déjà charged
  (analyze cold + brief regen). La compaction est best-effort au
  post-analyze (skip si déjà OK).
- **Supprimer les bases sans LRU** : casserait les PRs en cours sur des
  bases anciennes. N=10 minimum, configurable upward.
- **Modifier le format du store** : la compaction ne change PAS le format
  NDJSON. Un fact_id ré-émis plus tard sera ré-ajouté tel quel
  (déterminisme préservé).

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/cli/commands/compact.ts`
- `packages/codegraph/src/incremental/fact-store-compaction.ts`


## Detail

### Pourquoi pas un index séparé `facts.index.json` ?

Considéré : maintenir un Set<id> en parallèle du NDJSON pour O(1)
lookup. Rejeté pour la simplicité — le full scan reste sub-50ms pour
100k facts (cf. benchmarks Phase 3). On gagnerait quelques ms au prix
d'un état dérivé à maintenir cohérent.

### Pourquoi pas une compaction mark-and-sweep en arrière-plan ?

Considéré façon Go GC : background thread qui marque + sweep
incrémentalement. Rejeté pour ce projet — pas de daemon long-lived (ADR-027 a
rejeté l'approche LSP-style). La compaction synchrone au post-analyze
suffit pour les volumes visés (sub-seconde).

### Compatibilité avec Phase 4 (RocksDB)

Si Phase 4 migre vers RocksDB, la compaction natif Lib remplace ce
mécanisme. Cette ADR reste applicable à la phase JSON-indexée (= état
courant et probablement plus de 80% des usages).

## References

- [Glean — compaction RocksDB native](https://glean.software/blog/incremental/)
- [Git GC — pruning blobs unreferenced](https://git-scm.com/docs/git-gc)
- [CodeQL — DB lifecycle post-merge](https://arxiv.org/pdf/2308.09660)
- ADR-027 Phase 3 — content-addressed fact store (pré-requis)
