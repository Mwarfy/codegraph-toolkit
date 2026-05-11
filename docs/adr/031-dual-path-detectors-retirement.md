# ADR-031: Retrait du dual-path detectors (Datalog devient le seul chemin)

**Date:** 2026-05-11
**Status:** Accepted (Phase 0 audit) — Phases 1-3 planned

## Rule

> Pour les détecteurs qui ont une version Datalog (cf. ADR-026 — 18/21
> détecteurs portés), la version **legacy** (extractors ts-morph
> classique) sera retirée progressivement. Datalog devient le seul
> chemin. Les 3 détecteurs cross-file non portables (`bin-shebangs`,
> `drizzle-schema`, `state-machines`) restent en legacy de manière
> permanente — c'est leur scope qui empêche le port, pas un choix de
> pipeline.

## Why

ADR-026 (mai 2026) a posé le pattern : "détecteurs comme rules Datalog
sur facts AST denormalisés" avec un plan de migration 18/21
BIT-IDENTICAL. Cette ADR annonçait :

> *"Legacy-mode sera deprecated en v0.6 et retiré en v1.0."*

État au 2026-05-11 (audit) — **on est en v0.6.2 et le retrait n'est
jamais fait** :

1. Tous les détecteurs portés ont **2 implémentations** :
   - `extractors/<name>.ts` (legacy batch, encore utilisé par défaut)
   - `datalog-detectors/rules/<name>.dl` + visitor dans
     `datalog-detectors/ast-facts/`
2. Le code legacy reste **le chemin principal** dans `analyzer.ts` —
   le runner Datalog ne fait qu'un **override de 3 fields seulement**
   (`envUsage`, `barrels`, `eventEmitSites`) via `buildSnapshotPatchFromDatalog`.
3. Les **15 autres rules Datalog** sont calculées mais leurs outputs
   ne sont **jamais consommés** en prod — ils servent uniquement au
   shadow comparator (= test de parité).

Conséquence pratique : chaque modification d'un détecteur porté
demande de toucher les 2 implémentations (ou accepter la divergence
silencieuse). Le test de parité (`datalog-legacy-parity.test.ts`
ajouté en PR #39) protège contre la dérive mais ne supprime pas
le coût de maintenance.

À chaque nouveau détecteur ajouté, on hérite du pattern → 2× le
code. À 30 détecteurs → 60 sources de vérité. La dette est
**non-linéaire dans le nombre de détecteurs**.

**Pré-requis remplis** :
- ADR-026 — pattern Datalog formalisé
- Test parité Datalog/legacy (PR #39) — preuve BIT-IDENTICAL sur 18 ports
- ADR-029 — signaux propres avant refonte (= on agit sur du connu)
- ADR-030 — JSON public vs TS interne (= retrait code interne libre)
- ADR-032 — cross-package contracts (= cascade impossible)

## How to apply

### Phase 0 (cette ADR — Accepted) — Audit + plan

L'audit a déjà identifié :
- **18 détecteurs portés** : version Datalog existe, BIT-IDENTICAL prouvé
- **3 détecteurs override actifs** : `envUsage`, `barrels`, `eventEmitSites`
- **15 détecteurs shadow seulement** : Datalog calculé mais output non utilisé
- **3 détecteurs non portables** : `bin-shebangs`, `drizzle-schema`,
  `state-machines` (cross-file / IO-heavy aggregators — cf. ADR-026 § Detail)

Le retrait sera fait par **batch de 3-5 détecteurs** à la fois pour
limiter le blast radius par PR. Pas de big-bang.

### Phase 1 (planned) — Étendre les overrides actifs aux 15 détecteurs shadow

- Pour chaque détecteur porté actuellement en shadow seulement, faire
  passer son output Datalog en override actif (= ajouter au
  `buildSnapshotPatchFromDatalog`).
- Le test parité (PR #39) garantit BIT-IDENTICAL pour les fields
  patchés.
- À la fin de Phase 1 : 18 détecteurs en override actif, 3 en shadow
  legacy (non portables).
- Tous les outputs viennent de Datalog. Le code legacy continue de
  s'exécuter mais ses outputs sont **systématiquement overrides**.
- **Aucune régression observable** côté snapshot.json (= contrat
  externe), test invariant ADR-030 protège.

### Phase 2 (planned) — Retirer le code legacy des détecteurs portés

- Pour chaque détecteur porté, supprimer le fichier
  `packages/codegraph/src/extractors/<name>.ts` + wrapper Salsa
  `incremental/<name>.ts`.
- Le runner `analyzer.ts` ne charge plus ces détecteurs côté legacy.
- Le runner Datalog devient le seul chemin pour ces détecteurs.
- Le test parité (PR #39) **devient obsolète pour ces détecteurs**
  (plus rien à comparer) — il reste valide pour les 3 non portables.

### Phase 3 (planned, optionnel) — Retirer le shadow comparator

- Une fois Phase 2 stable (= N releases sans régression), on peut
  retirer l'infrastructure du shadow comparator
  (`datalog-detectors/shadow.ts`, `datalog-shadow` flag).
- Garder uniquement le code Datalog "live" pour les 18 portés +
  le code legacy pour les 3 non portables.

### Garde-fous pendant la migration

- Chaque PR de Phase 1/2 doit faire péter le test parité si elle
  introduit une régression
- Le canary fixture (`examples/canary-project/validate.sh`) doit
  rester vert
- `vitest run` complet doit rester vert
- Test invariant snapshot-schema (ADR-030) doit rester vert
- Tests cross-package (ADR-032) doivent rester verts

## Anti-patterns

- **Retirer tous les détecteurs en une PR** : blast radius non gérable.
  Pattern ADR-027 = batch progressif.
- **Retirer le legacy avant l'override actif** : pète l'output snapshot.
  Faire Phase 1 (override) AVANT Phase 2 (retrait).
- **Retirer le test parité avant la fin de Phase 2** : on perd le
  garde-fou pendant qu'on retire le code. Test parité retiré seulement
  quand le code legacy l'est aussi.
- **Toucher les 3 non portables** : ils restent legacy permanent.
  Pas de tentative de les porter en Datalog (cf. ADR-026 § Detail —
  cross-file aggregation incompatible avec le pattern per-file).

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->


## Tested by

- Existant : `packages/codegraph/tests/datalog-legacy-parity.test.ts` —
  preuve BIT-IDENTICAL des fields patchés. Reste pertinent pendant
  Phase 1 (= override des 15 shadow), devient obsolète en Phase 2.
- Existant : `packages/codegraph/tests/datalog-shadow.test.ts` — test
  du shadow comparator. Reste pertinent jusqu'à Phase 3.

## Detail

### Détecteurs concernés (recensement Phase 0)

**Portés actifs (3 — déjà en override)** :
- `env-usage` → `EnvVarReadOut` rule
- `barrels` → `BarrelFileOut` rule
- `event-emit-sites` → `EventEmitSiteOut` rule

**Portés shadow (15 — à passer en override actif en Phase 1)** :
magic-numbers, dead-code (identical-subexpr), eval-calls, crypto-algo,
boolean-params, sanitizers, taint-sinks, long-functions,
function-complexity, hardcoded-secrets, event-listener-sites,
constant-expressions, arguments (tainted-args + params), tainted-vars
(decls + arg-calls), resource-balance, security-patterns (4 sub),
drift-patterns (4 sub), code-quality-patterns (4 sub).

**Non portables (3 — restent legacy permanent)** :
- `bin-shebangs` — filesystem walk + JSON parse, pas d'AST
- `drizzle-schema` — cross-file resolution (varNameToTable), multi-pass
- `state-machines` — cross-file aggregation (concept ↔ writes via
  state values), async SQL file scan

### Estimation effort

| Phase | Scope | Effort | PRs |
|---|---|---|---|
| Phase 1 | Étendre 15 overrides | 1-2 semaines | 4-5 PRs (3-4 détecteurs par PR) |
| Phase 2 | Retirer 18 fichiers legacy + wrappers Salsa | 1 semaine | 4-5 PRs |
| Phase 3 | Retirer shadow infra | 2-3 jours | 1 PR |

**Total : 3-4 semaines sur 10-11 PRs.** Pattern ADR-027 = progression
sur plusieurs sprints, pas un blocage.

### Pourquoi pas garder le dual-path indéfiniment ?

Considéré. Rejeté parce que :
1. **Cost compound** : chaque nouveau détecteur ajouté hérite. À 30
   détecteurs, 60 sources de vérité.
2. **Code legacy ralentit l'analyse** : pour le toolkit, le pipeline
   legacy + Datalog = ~2× le travail (Datalog calcule mais sa sortie
   est ignorée pour 15 détecteurs).
3. **ADR-026 a déjà annoncé le retrait** : 8 mois de gestation, time
   to deliver.
4. **Risque maîtrisé** : test parité prouve BIT-IDENTICAL, donc
   l'override Phase 1 est mécanique. Phase 2 retire du code dont la
   non-régression est testée.

### Pourquoi pas pas commencer immédiatement ?

Considéré. Différé parce que :
1. **Sprint dette architecturale en cours** : ADR-030, test invariant,
   ADR-032, ADR-033 P1 — chaque pré-requis est encore frais. Faire
   ADR-031 maintenant ajouterait du bruit aux gardes-fous mis en place.
2. **ADR-033 P1 (sub-snapshots écriture parallèle) débloque le pipeline
   pour des refontes futures** — y compris cette migration. Faisons
   ADR-033 P1 d'abord.
3. **Phase 1 de ADR-031 est mécanique mais répétitive** : 4-5 PRs.
   Demande session(s) dédiée(s) pour ne pas casser le flow.

L'audit Phase 0 est fait (= cette ADR). Phase 1 démarrera dans
une session dédiée quand le sprint actuel sera clos.

## References

- ADR-026 — pattern Datalog déclaratif (= source du plan)
- ADR-029 — signaux propres avant refonte (= preuve via test parité)
- ADR-030 — JSON public vs TS interne (= refonte interne légitime)
- ADR-032 — cross-package contracts (= cascade impossible)
- ADR-033 — sub-snapshots (= pré-requis pour les phases suivantes)
- PR #39 — test parité Datalog/legacy bit-identical
