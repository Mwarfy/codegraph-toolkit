# ADR-033: Sub-snapshots — fix du fat-blob `snapshot.json`

**Date:** 2026-05-11
**Status:** Accepted (Phase 1) — Phases 2-4 planned

## Rule

> Le `snapshot.json` cesse d'être un blob unique. Le graph core
> (`nodes`, `edges`, `stats`) reste dans `snapshot.json`. Les outputs
> de chaque detector vont dans des fichiers séparés sous
> `.codegraph/snapshot.detectors/<name>.ndjson`. Les métriques
> cross-discipline vont dans `.codegraph/snapshot.metrics.json`.
>
> Les consumers peuvent charger SEULEMENT ce dont ils ont besoin —
> pas tout le blob. L'invalidation cache devient partielle, pas
> tout-ou-rien.

## Why

Audit du 2026-05-11 — `snapshot.json` actuel = **2.4 MB** sur le
toolkit (377 files). Projection linéaire :

| Taille repo | snapshot.json | Parse time |
|---|---|---|
| 377 files (toolkit) | 2.4 MB | ~9 ms |
| 1 000 files | ~6.4 MB | ~25 ms |
| 5 000 files | **~32 MB** | **~125 ms** |
| 10 000 files | ~64 MB | ~250 ms |

Au-delà de 5k files, le pattern fat-blob devient bloquant :
1. Chaque consumer charge **2.4 → 64 MB**, même s'il n'utilise qu'1 champ
2. RAM pressure : 60+ MB persistants en mémoire par process consumer
3. Cache invalidation tout-ou-rien : modif d'1 detector → snapshot.json
   entier réécrit, tous les consumers re-load tout
4. Parse partiel impossible : pas de streaming, pas de lazy loading

Le pattern est documenté chez Glean (Meta) : facts par schema, chacun
queryable indépendamment. CodeQL : DBs layered. C'est le standard de
l'état de l'art.

ADR-027 (Phases 1-3) a posé les fondations (gitignored derived views,
content-addressed snapshot, content-addressed facts). Cette ADR
complète la trajectoire en attaquant le dernier blob restant.

**Pré-requis remplis** :
- ADR-030 (PR #45) — sépare contrat externe (JSON) de couplage interne
  (TS). La refonte de la shape JSON est désormais légitime (via bump
  de `meta.version`).
- Test snapshot-schema-invariant (PR #46) — garde-fou structurel CI
  qui pète si la shape sérialisée dévie sans bump explicite.
- ADR-032 (PR #47) — tests cross-package qui empêchent les cascades
  silencieuses lors d'une refonte format.

## How to apply

### Architecture cible

```
.codegraph/
├── snapshot.json              ← Graph core : nodes, edges, stats, meta
├── snapshot.meta.json         ← sidecar meta (P2 — fast staleness check)
├── snapshot.detectors/        ← NOUVEAU — 1 NDJSON par detector
│   ├── magicNumbers.ndjson
│   ├── cycles.ndjson
│   ├── envUsage.ndjson
│   ├── truthPoints.ndjson
│   ├── eventEmitSites.ndjson
│   ├── ... (~18 fichiers)
├── snapshot.metrics.json      ← NOUVEAU — métriques cross-discipline
│                                (modularité, IB, Lyapunov, etc.)
├── facts.store.ndjson         ← P3 — content-addressed facts (inchangé)
├── facts.head.json            ← P3 (inchangé)
└── facts.bases/<sha>.json     ← P3 (inchangé)
```

**Pourquoi NDJSON pour detectors** : un fact par ligne, streamable,
parse partiel possible, append-friendly si on veut un mode incremental
plus tard.

**Pourquoi JSON simple pour metrics** : ~10-20 KB total, structuré
profondément (objets imbriqués), pas streamable utilement.

### Phase 1 (cette ADR — Accepted) — Écriture parallèle

- `analyze` écrit TOUJOURS le fat blob `snapshot.json` (= legacy
  format, backward-compat 100%) ET en parallèle les nouveaux sub-files.
- Aucun consumer ne change.
- Bump `SnapshotMeta.version` à **3** pour identifier les snapshots
  qui ont les sub-files.
- Migration douce : v2 (= fat blob seul) reste lisible par
  `loadStoredSnapshot`.
- Effet : sub-files disponibles pour consumers futurs, zéro régression.

### Phase 2 (planned) — Loader lazy

- `loadSnapshotPayload(snapshotDir)` retourne toujours un
  `GraphSnapshot` complet (= back-compat absolue avec consumers
  actuels).
- Nouvelle API : `loadGraphCore(snapshotDir)` → renvoie juste
  `{ nodes, edges, stats }` (= ~10× plus petit).
- Nouvelle API : `loadDetectorOutput(snapshotDir, detectorName)` →
  retourne juste les outputs de ce detector via NDJSON streaming.
- Nouvelle API : `loadMetrics(snapshotDir)` → métriques cross-discipline.
- Si sub-files absents (= snapshot v2 legacy), fallback transparent
  vers le fat blob (= lecture complète mais via `loadSnapshotPayload`).

### Phase 3 (planned) — Migration des consumers

- Audit : pour chaque consumer cross-package + CLI command, lister
  les champs réellement utilisés.
- Migrer un consumer à la fois vers les nouvelles APIs. Chaque
  migration = mesure de la réduction RAM/parse pour ce consumer.
- Ne PAS toucher les consumers complexes (e.g. `serve`, `dashboard`)
  qui ont besoin de plusieurs champs — ils restent sur
  `loadSnapshotPayload` (= fat blob).
- Tests cross-package (ADR-032) garantissent la non-régression.

### Phase 4 (planned, optionnel) — Retrait du fat blob

- Si Phase 3 montre que >80% des consumers ont migré, on peut bumper
  à v4 et supprimer le fat blob (= snapshot.json devient juste le
  graph core, pas la concaténation de tout).
- Migration douce comme P2 ADR-027 : v3 (= fat blob + sub-files)
  reste lisible pendant N releases avant suppression.

## Anti-patterns

- **Bump `meta.version` sans migration douce** : casse les consumers
  externes (Sentinel, MCP). Toujours garder v(N-1) lisible pendant
  au moins 2 releases.
- **Faire Phase 1 et Phase 2 dans un seul PR** : trop gros, blast
  radius non maîtrisable. Pattern ADR-027 = une phase, une PR (ou
  groupe de petites PRs).
- **Migrer un consumer dans le PR de Phase 2** : couple loader nouveau
  + nouveau pattern d'usage. Faire Phase 2 SEULE d'abord, valider
  qu'elle marche, PUIS migrer en Phase 3.
- **Retirer le fat blob trop vite** : la migration douce est précisément
  ce qui permet à des consumers externes (e.g. Sentinel qui peut ne
  pas être à jour) de continuer à fonctionner. Phase 4 attend.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->


## Tested by

- Existant : `tests/snapshot-schema-invariant.test.ts` (ADR-030) — la
  shape JSON globale reste stable au passage à v3 (= les sub-files sont
  PLUS, pas un remplacement)
- À ajouter en P2 : test du loader lazy — `loadGraphCore` retourne juste
  le graph, `loadDetectorOutput(name)` retourne juste ce detector,
  fallback v2 transparent

## Detail

### Impact mesuré attendu

| | Avant | Après P2 (cible) |
|---|---|---|
| **Parse `loadSnapshotPayload` complet** | 9-25 ms / 2.4-6.4 MB | inchangé (back-compat) |
| **`loadGraphCore` (nodes/edges seulement)** | n/a | 1-3 ms / 200-500 KB |
| **`loadDetectorOutput('magicNumbers')`** | doit charger 2.4 MB | 1-5 ms / 10-50 KB stream |
| **`loadMetrics`** | doit charger 2.4 MB | <1 ms / 10-20 KB |

Sur un repo 5k files : passe de 32 MB chargés en RAM par consumer
à 200 KB - 2 MB selon le besoin. **10-100× moins de mémoire**.

### Pourquoi pas un format binaire ?

Considéré. Rejeté pour la simplicité :
- NDJSON reste lisible humainement (debug, inspection manuelle)
- Parse natif JSON dans tous les langages (consumers externes)
- Streamable ligne par ligne sans lib spéciale
- Pas de schema separé à maintenir (= ADR-031 facts content-addressed
  démontre que JSON streamable scale OK jusqu'à 100k entrées)

Binaire (msgpack, cbor, parquet) viendrait en Phase 4+ si la perf
JSON reste un bottleneck — mais l'audit montre que parse JSON est
loin d'être le bottleneck actuel (~25 ms pour 6 MB).

### Pourquoi un fichier par detector et pas un fichier par fact ?

Considéré : `snapshot.detectors/magicNumbers/<file>.ndjson` (=
sharding par fichier source). Rejeté pour ce projet :
- Trop de petits fichiers (= file system overhead non-trivial)
- Use case "tous les magic numbers du projet" demande lecture
  combinée → on revient au pattern fat blob
- Sharding utile à 100k+ tuples par detector — pas le cas actuel

### Pourquoi pas continuer à charger tout systématiquement ?

C'est le statu quo. Le coût se manifeste à l'échelle :
- Hook PostToolUse (codegraph-feedback.sh) charge 2.4 MB à chaque
  Edit → 240 MB sur 100 edits dans une session
- MCP tool calls font pareil
- Dashboard server tient le snapshot en RAM permanente

À 5k files, ces patterns deviennent ingérables.

### Migration depuis Phase 3 ADR-027 (facts content-addressed)

Aucune. ADR-033 et ADR-027 P3 sont orthogonaux :
- ADR-027 P3 = facts AST primitifs (input du runner Datalog)
- ADR-033 = outputs des détecteurs (= résultats consommés par
  CLI/dashboard/MCP/Sentinel)

Les deux co-existent. La Phase 3 fact store reste pour les rules
Datalog ; ADR-033 facilite la consommation des outputs.

## References

- ADR-027 Phase 1-3 — fondations (gitignored, content-addressed, facts)
- ADR-030 — schéma JSON vs TS interne (= permet la refonte de shape)
- ADR-032 — cross-package contracts (= empêche les cascades)
- [Glean — Engineering at Meta](https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/)
  facts par schema, chacun queryable
- [Incrementalizing Production CodeQL](https://arxiv.org/pdf/2308.09660) —
  pattern DBs layered
