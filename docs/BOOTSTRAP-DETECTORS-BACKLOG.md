# Bootstrap Detectors — Backlog

Suite à ADR-004 (bootstrap = 3 rôles séparés : codegraph détecte / LLM
rédige / humain valide), 4 détecteurs de patterns architecturaux sont
prévus pour alimenter le bootstrap des ADRs. Status :

| Detector | Status | Pattern | Output |
|---|---|---|---|
| `singleton` | ✅ Livré v0.1.0 | private static instance + getInstance | candidate ADR sur la classe |
| `write-isolation` | ✅ Livré v0.2.0 | un seul writer pour un truth-point (depuis snapshot.truthPoints) | candidate ADR sur la propriété d'isolation |
| `hub` | ✅ Livré v0.2.0 | fichier avec in-degree ≥ N (default 20) sans marqueur ADR | candidate ADR sur le contract hub |
| `fsm` | ⏳ À faire | union string literals avec suffixe `Status\|State\|Phase\|Stage` + writes observables | candidate ADR sur transitions |

**Pour le détecteur fsm restant** : voir le **plan détaillé** dans
`SPRINT-13-FSM-DETECTOR-PLAN.md` (boot brief dédié pour reprise à froid).
Estimé 3-4h dédiées. Heuristique de détection complète, fixtures de test,
pièges connus (suffix-only false positives, numeric enums, cross-référencement),
prompt template, plan d'attaque en 6 étapes.

## Pourquoi ces 3 détecteurs en particulier

Chacun capture un **invariant architectural implicite** que l'on découvre
en grep sur le code mais qui n'est pas formalisé. Le LLM ne peut pas les
inventer (il dériverait), donc codegraph les détecte déterministiquement
puis le LLM rédige le draft.

### `fsm` — pourquoi

Les unions de littéraux avec suffixe Status/State/Phase/Stage sont
typiquement des FSMs. Si on observe les écritures (SQL UPDATE, object
literal `{ status: 'X' }`), on peut reconstruire les transitions. Un ADR
sur cette FSM verrouille les transitions valides — exactement ce qui
manque souvent dans Sentinel (`DeployLogPhase`, `BlockStatus`, etc.).

Heuristique de détection (à implémenter) :
1. Walk les `TypeAliasDeclaration` et `EnumDeclaration` ts-morph
2. Filter sur le naming convention (`Status`, `State`, `Phase`, `Stage`)
3. Cross-référencer avec les writes dans le code (taint detector déjà existant peut aider)
4. Output : `{ name, values, transitions[] }`

### `write-isolation` — pourquoi

Un truth-point avec UN SEUL writer est un invariant fort : "personne
d'autre ne touche cette donnée". Le toolkit a déjà `truthPoints[]` dans
le snapshot, il suffit de filter ceux où `writers.length === 1`.

Heuristique :
1. Charger `snapshot.truthPoints`
2. Filter `tp => tp.writers.length === 1`
3. Output : candidate ADR pour chaque truth-point isolé

### `hub` — pourquoi

Un fichier avec in-degree ≥ 20 et sans marqueur ADR est exactement le
profil "load-bearing infrastructure sans guard-rail" — précisément le
problème qui a justifié ADR-006 (`core/types.ts`). Détecter
automatiquement et proposer un ADR.

Heuristique :
1. Compute in-degree depuis `snapshot.edges` (type='import')
2. Filter `f => inDegree[f] >= threshold`
3. Cross-check avec `collectAdrMarkers` — exclure ceux qui ont déjà un marqueur
4. Output : candidate ADR "X est canonical contract, modifications conservatrices"

## Architecture (pattern à suivre)

Chaque détecteur vit dans `packages/adr-toolkit/src/bootstrap/detect-<pattern>.ts` :

```ts
export interface FsmCandidate {
  // Données structurées extraites par codegraph
}

export function detectFsmCandidates(snapshot: GraphSnapshot, project: Project): FsmCandidate[] {
  // Pure : pas d'I/O, pas de LLM
}
```

Chaque détecteur a un prompt template dans `packages/adr-toolkit/src/bootstrap/prompts/`:
```ts
export const FSM_PROMPT_TEMPLATE = (candidate: FsmCandidate) => `...`
```

Le runner `bootstrap.ts` orchestre :
```ts
const candidates = [
  ...detectSingletonCandidates(...),
  ...detectFsmCandidates(...),         // ← à ajouter
  ...detectWriteIsolationCandidates(...),  // ← à ajouter
  ...detectHubCandidates(...),         // ← à ajouter
]
```

Pour chaque candidate, spawn un agent Sonnet, valide via `checkAsserts`,
écrit Status: Proposed.

## Estimation

Chacun ~3-4h dédié (détection + prompt template + tests + intégration).
Total : 1-2 jours pour les 3 restants. Refactor du runner pour gérer
multiple types de candidates : 2-3h en plus.

## Tests à écrire

Pour chaque détecteur, fixture minimal qui contient :
- Un cas POSITIF (devrait être détecté)
- Un cas NÉGATIF strict (ressemble mais ne devrait pas être détecté)
- Un cas LIMITE (à la frontière, vérifier la décision)

Cf. `tests/bootstrap-detect.test.ts` pour le pattern existant sur `singleton`.

## Reprise

Quand on attaque ces détecteurs :
1. Lire ADR-004 (`packages/adr-toolkit` ADR-004) pour rappel des 3 rôles
2. Lire `packages/adr-toolkit/src/bootstrap.ts` (runner)
3. Lire `detect-singleton.ts` comme référence
4. Implémenter dans l'ordre suggéré (write-isolation le plus simple — déjà des données, juste un filter — puis hub, puis fsm).
