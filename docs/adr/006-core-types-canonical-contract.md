# ADR-006: `core/types.ts` est le contract canonique — modifications conservatrices uniquement

**Date:** 2026-04-30
**Status:** Accepted

## Rule

> `packages/codegraph/src/core/types.ts` est importé par 57+ fichiers
> (top hub absolu du toolkit). Tout type exporté depuis ce fichier est
> un contrat avec :
>   - Les détecteurs (extractors/) qui produisent ces structures
>   - Les consumers (synopsis/, facts/, diff/, check/) qui les lisent
>   - Le snapshot.json sérialisé sur disque (consommé par Sentinel,
>     codegraph-mcp, hooks bash, possibles consumers externes)
>
> RÈGLE : pas de breaking change sans deprecation explicite. On ajoute
> des champs optionnels, on ne supprime ni ne modifie la sémantique
> d'un champ existant.

## Why

Découvert en audit méta de l'architecture (avril 2026) :

`core/types.ts` est apparu comme top hub avec in-degree 57 — sans aucun
marqueur ADR. C'est précisément le profil "load-bearing infrastructure
sans guard-rail" : un Claude futur peut le modifier en pensant que ce
n'est qu'une définition de types, sans réaliser qu'il casse 57 sites
en aval ET le format du snapshot sérialisé.

Le bug truth-points hook (mai 2026) a illustré le problème : la shape
de `TruthPoint` a évolué dans `extractors/truth-points.ts` sans que
`core/types.ts` reflète exactement la structure (`tp.file` au niveau
racine n'existe pas, l'info est dans `writers[]/readers[]/mirrors[]`).
Le hook PostToolUse Sentinel a silencieusement raté tous les
truth-points pendant des semaines.

L'absence d'ADR sur ce hub a transformé un changement structurel
incrémental en bug de prod silencieux. Pas reproduisible.

## How to apply

- **AJOUTER un champ** : OK toujours. Marquer `?` (optional) pour ne
  pas casser les snapshots antérieurs. Documenter dans le JSDoc
  pourquoi le champ existe + qui le produit + qui le consomme.
- **RENOMMER un champ** : NON. Si vraiment nécessaire, faire un
  deprecation cycle :
  1. Ajouter le nouveau champ avec semantic identique.
  2. Faire écrire les producers SUR LES DEUX champs simultanément.
  3. Migrer tous les consumers vers le nouveau.
  4. Marquer l'ancien `@deprecated`.
  5. Au release suivante (major version bump), retirer l'ancien.
- **MODIFIER la sémantique** d'un champ existant : NON. Créer un
  nouveau champ avec le nouveau sens.
- **AJOUTER une method** sur un type : seulement si le type est
  consommé exclusivement en interne au toolkit. Si exporté via
  snapshot JSON → NON (les methods ne survivent pas la sérialisation).
- **MODIFIER core/types.ts** : avant de toucher, lancer
  `lsp_find_references` sur le type que tu vas modifier. Si > 5 sites,
  pesée explicite : est-ce que la modif est conservative ?
- **ANTI-PATTERN** : modifier `EdgeType` / `NodeType` / `EdgeKind`
  union types pour retirer un cas existant. Tous les snapshots
  antérieurs deviendront invalides.
- **ANTI-PATTERN** : changer la shape d'un type d'output de detector
  (`TruthPoint`, `EventEmitSite`, `EnvVarUsage`, `Cycle`, etc.) sans
  mettre à jour SIMULTANÉMENT le detector qui le produit ET les
  consumers qui le lisent.

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby/adr-toolkit. NE PAS éditer à la main. -->

- `packages/codegraph/src/core/types.ts`


## Tested by

- `packages/codegraph/tests/parity.test.ts` — vérifie que la shape du
  snapshot reste cohérente cross-mode (legacy vs --incremental). Si
  un type change brut, ce test pète.
- _(à ajouter : un test invariant qui vérifie qu'aucun champ documenté
  dans `GraphSnapshot` n'a été retiré sans deprecation)_

## Detail

### Pourquoi 57 imports ?

`core/types.ts` définit ~30 interfaces / types unions :
  - GraphNode, GraphEdge, GraphSnapshot, GraphStats
  - EdgeType, NodeType, NodeStatus, EdgeKind
  - SymbolRef, TypedCalls, Cycle, TruthPoint, DataFlow, StateMachine
  - EnvVarUsage, EnvVarReader, EventEmitSite, OauthScopeLiteralRef
  - ModuleMetrics, ComponentMetrics, TaintViolation, DsmResult
  - PackageDepsIssue, BarrelInfo, ExportSymbol, ExportConfidence

Ces types sont produits par les ~28 fichiers de `extractors/` et
`detectors/`, et consommés par les ~25 fichiers de `synopsis/`,
`facts/`, `diff/`, `check/`, `incremental/`, `core/analyzer.ts`.

C'est notre "ground truth schema". Le format que Sentinel et tout
consumer externe attend.

### Anti-pattern observé : drift detector → snapshot consumer

Sprint 11.2 a révélé deux drifts silencieux :
  1. `TruthPoint.writers[].file` : présent et utilisé. OK.
  2. `TruthPoint.file` au niveau racine : absent dans la shape réelle,
     mais le hook bash le lisait quand même → toujours undefined.

Ces drifts ne pètent ni au compile ni au runtime — ils retournent
silencieusement undefined. Difficile à attraper sans test invariant
explicite ou audit auto-référentiel.

### Raison de l'ADR

À 50 ans de codegraph (horizon long terme), ce fichier sera modifié
des centaines de fois. Sans guardrail explicite, chaque modification
est une roulette russe. Avec cet ADR + marker `// ADR-006` au top du
fichier, le hook PreToolUse alertera tout futur Claude qui s'apprête
à modifier core/types.ts : "lis cet ADR avant de toucher".
