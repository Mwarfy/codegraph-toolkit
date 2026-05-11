# ADR-031: Retrait du dual-path detectors (Datalog devient le seul chemin)

**Date:** 2026-05-11 (révisé après audit code post-merge)
**Status:** Accepted — Phases 1+2 complete (PRs #51, #53-#59), Phase 3 planned

## Erratum (révision post-audit)

L'audit Phase 0 décrivait un état du code **dépassé d'une release**.
Diagnostic original : *"override actif sur 3 fields seulement, 15 en
shadow only"*. Audit code post-merge (PR #51) révèle que :

- **20 fields snapshot consomment déjà Datalog en prod** quand
  `useDatalog=true` (= default depuis ADR-026 phase E / commit `608d725`).
- 3 fields via overrides directs au début de `runDeterministicDetectors`
  (`analyzer.ts` L942-944).
- 17 fields via cascade `incremental ? salsa : datalogPatch ? dl.X : legacy`
  dans phases 1-6 d'`analyzer.ts` (L1000-1227) — branchements posés
  par ADR-026 phases A.3, A.4 et E.

Le diagnostic Phase 0 a été écrit en regardant uniquement
`runner-adapter.ts` + les 3 overrides directs, sans constater le
branchement cascade dans les phases.

**Conséquence sur les phases :**
- Phase 1 telle qu'initialement décrite ("étendre les overrides aux
  15 shadow") = déjà faite par ADR-026 A.3/A.4/E. Il restait un trou
  de **garde-fou CI** (test parité bit-identical limité à 3/20 fields)
  → PR #51 ferme ce trou.
- Phase 2 (retrait du code legacy) inchangée — exécutée en 7 batches
  (PRs #53-#59) protégée par garde-fou bit-identical 20 fields.
- Phase 3 inchangée.

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

État au 2026-05-11 (audit révisé) — **on est en v0.6.2 et le retrait
du code legacy n'est pas fait** :

1. Tous les détecteurs portés ont **2 implémentations** :
   - `extractors/<name>.ts` (legacy batch, **encore présent**, mais
     ses outputs sont écrasés par Datalog en cascade quand
     `useDatalog=true`)
   - `datalog-detectors/rules/<name>.dl` + visitor dans
     `datalog-detectors/ast-facts/`
2. Le **runtime consomme déjà Datalog** pour 20/21 fields portés
   quand `useDatalog=true` (default depuis ADR-026 phase E). Le legacy
   continue de tourner mais ses outputs ne sont jamais utilisés —
   gaspillage de cycles CPU.
3. **driftSignals** transite par `adaptDriftSignalsFromDatalog`
   (assemblage de 4 sub-arrays Datalog + Pattern 3 todo-no-owner
   cross-file).
4. **Le garde-fou CI bit-identical (`datalog-legacy-parity.test.ts`)
   ne verrouillait que 3 fields** jusqu'à PR #51 (Phase 1) — laissait
   17 fields à la dérive silencieuse potentielle.

Conséquence pratique : chaque modification d'un détecteur porté
demande de toucher les 2 implémentations (ou accepter la divergence
silencieuse). Le shadow comparator (`datalog-shadow.test.ts`)
protège la couverture sémantique sur 32 checks, mais avant PR #51
le bit-identical CI ne couvrait que 3 fields.

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

L'audit révisé (post-merge) identifie :
- **18 détecteurs portés** : version Datalog existe, BIT-IDENTICAL prouvé
- **20 fields snapshot** consomment déjà Datalog en prod via cascade
  (`useDatalog=true` default) — 3 overrides directs + 17 branchements
  cascade dans phases 1-6 d'`analyzer.ts`
- **3 détecteurs non portables** : `bin-shebangs`, `drizzle-schema`,
  `state-machines` (cross-file / IO-heavy aggregators — cf. ADR-026 § Detail)
- **Trou Phase 1 originel** : garde-fou CI bit-identical limité à 3/20
  fields (cf. §Why)

Le retrait du code legacy sera fait par **batch de 3-5 détecteurs**
à la fois pour limiter le blast radius par PR. Pas de big-bang.

### Phase 1 (done via PR #51) — Verrouiller le garde-fou bit-identical

Audit révisé : les overrides actifs (= "extension du patch") sont
déjà faits par ADR-026 phases A.3, A.4, E. Le vrai travail Phase 1
qui restait = **élargir le garde-fou CI** pour ne pas retirer le
code legacy à l'aveugle :

- `datalog-legacy-parity.test.ts` voit sa liste `patchedFields`
  passer de 3 → 20.
- Nouveau test sur la fixture `canary-project` (la fixture `cycles`
  était trop creuse) — déclenche réellement 11+/20 détecteurs.
- Échoue si parité diverge OU si la coverage canary tombe sous 10/20.

Cette PR ne change PAS le runtime — uniquement le garde-fou test.
Aucune régression possible côté snapshot.json (test invariant
ADR-030 protège).

### Phase 2 (done via PRs #53-#59) — Retirer le code legacy des détecteurs portés

- Pour chaque détecteur porté, supprimer le fichier
  `packages/codegraph/src/extractors/<name>.ts` + wrapper Salsa
  `incremental/<name>.ts`.
- Le runner `analyzer.ts` ne charge plus ces détecteurs côté legacy.
- Le runner Datalog devient le seul chemin pour ces détecteurs.
- Le test parité (PR #39) **devient obsolète pour ces détecteurs**
  (plus rien à comparer) — il reste valide pour les 3 non portables.

### Phase 3 (planned, optionnel) — Retirer le shadow comparator

- Une fois Phase 2 stable, on peut retirer l'infrastructure du shadow
  comparator (`datalog-detectors/shadow.ts`, `datalog-shadow` flag).
- Garder uniquement le code Datalog "live" pour les 18 portés +
  le code legacy pour les 3 non portables.

### Triggers

> **Audit dette 2026-05-12 §T3.2.** "N releases sans régression" était
> vague. Concrétisé ici pour éviter l'inertie indéfinie.

- **Phase 3 trigger** : démarrer au PLUS TÔT des deux conditions :
  - **v0.8.0** publiée (= 2 minor releases après v0.6.2 où Phase 2 a
    été complétée — soit ~2026-09 si cadence trimestrielle)
  - OU `datalog-shadow.test.ts` rapporte 0 divergence sur 4 mois
    consécutifs ET 0 modification du shadow comparator (= signal que
    la couverture n'apporte plus de signal nouveau)
- **Critère "fait"** : `datalog-detectors/shadow.ts` supprimé, le flag
  `datalogShadow` retiré de `AnalyzeOptions`, et `datalog-shadow.test.ts`
  supprimé. La parité reste protégée par `datalog-legacy-parity.test.ts`
  pour les 3 détecteurs non portables (= scope réduit mais conservé).

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
- **Retirer le legacy avant le verrouillage du garde-fou** : pète
  potentiellement l'output snapshot en silence. Faire Phase 1 (garde-fou
  CI étendu à 20 fields) AVANT Phase 2 (retrait du code legacy). PR #51
  remplit ce pré-requis.
- **Retirer le test parité avant la fin de Phase 2** : on perd le
  garde-fou pendant qu'on retire le code. Test parité retiré seulement
  quand le code legacy l'est aussi.
- **Toucher les 3 non portables** : ils restent legacy permanent.
  Pas de tentative de les porter en Datalog (cf. ADR-026 § Detail —
  cross-file aggregation incompatible avec le pattern per-file).

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->


## Tested by

- `packages/codegraph/tests/datalog-legacy-parity.test.ts` —
  preuve BIT-IDENTICAL des fields patchés. Élargi à 20 fields + fixture
  canary par PR #51 (Phase 1). Reste pertinent jusqu'à la fin de Phase 2
  (= moment où plus aucun legacy à comparer pour les 18 portés).
- `packages/codegraph/tests/datalog-shadow.test.ts` — test du shadow
  comparator. Reste pertinent jusqu'à Phase 3.

## Detail

### Détecteurs concernés (recensement révisé)

**Fields snapshot servis par Datalog en prod (20 — déjà branchés)** :

1. Overrides directs en début de `runDeterministicDetectors`
   (`analyzer.ts` L942-944) :
   - `envUsage` → `EnvVarReadOut` rule
   - `barrels` → `BarrelFileOut` rule
   - `eventEmitSites` → `EventEmitSiteOut` rule

2. Cascade `datalogPatch ? dl.X : legacy` dans phases 1-6
   (`analyzer.ts` L1000-1227) :
   - **phase 1** : `longFunctions`, `magicNumbers`
   - **phase 2** : `evalCalls`, `cryptoCalls`, `securityPatterns`,
     `eventListenerSites`, `codeQualityPatterns`, `functionComplexity`
   - **phase 4** : `hardcodedSecrets`, `booleanParams`, `deadCode`,
     `constantExpressions`
   - **phase 5** : `resourceImbalances`
   - **phase 6** : `taintSinks`, `sanitizerCalls`, `taintedVars`,
     `argumentsFacts`

3. `driftSignals` via `adaptDriftSignalsFromDatalog`
   (`analyzer.ts` L1065) — assemblage 4 sub-arrays + Pattern 3 todo
   cross-file.

**Code legacy à retirer en Phase 2** : `packages/codegraph/src/extractors/<name>.ts`
+ wrapper Salsa `incremental/<name>.ts` pour chacun des 18 détecteurs
portés (env-usage, barrels, event-emit-sites, magic-numbers,
long-functions, eval-calls, crypto-algo, security-patterns,
event-listener-sites, code-quality-patterns, function-complexity,
hardcoded-secrets, boolean-params, dead-code, constant-expressions,
resource-balance, taint-sinks, sanitizers, tainted-vars, arguments,
drift-patterns).

**Non portables (3 — restent legacy permanent)** :
- `bin-shebangs` — filesystem walk + JSON parse, pas d'AST
- `drizzle-schema` — cross-file resolution (varNameToTable), multi-pass
- `state-machines` — cross-file aggregation (concept ↔ writes via
  state values), async SQL file scan

### Estimation effort (révisée)

| Phase | Scope | Effort | PRs |
|---|---|---|---|
| Phase 1 | Verrouiller garde-fou bit-identical 20 fields | 1 session | 1 PR (#51) |
| Phase 2 | Retirer 18 fichiers legacy + wrappers Salsa | 1 semaine | 4-5 PRs (3-4 détecteurs par PR) |
| Phase 3 | Retirer shadow infra | 2-3 jours | 1 PR |

**Total révisé : 1-2 semaines sur 6-7 PRs.** Le gros de Phase 1
(branchement runtime) ayant été pris en charge par ADR-026, le
budget se rééquilibre vers Phase 2. Pattern ADR-027 = progression
sur plusieurs sprints, pas un blocage.

### Pourquoi pas garder le dual-path indéfiniment ?

Considéré. Rejeté parce que :
1. **Cost compound** : chaque nouveau détecteur ajouté hérite. À 30
   détecteurs, 60 sources de vérité.
2. **Code legacy ralentit l'analyse** : pour le toolkit, le pipeline
   legacy + Datalog = ~2× le travail (le legacy tourne et écrit dans
   snapshot, ses outputs sont ensuite écrasés par Datalog en cascade —
   cycles CPU gaspillés sur 18 détecteurs).
3. **ADR-026 a déjà annoncé le retrait** : 8 mois de gestation, time
   to deliver.
4. **Risque maîtrisé** : test parité élargi (PR #51) prouve
   BIT-IDENTICAL sur 20 fields. Phase 2 retire du code dont la
   non-régression est testée en CI.

### Statut migration au 2026-05-11

- Phase 0 (audit) : ✓ fait (cette ADR)
- Phase 1 (verrouillage garde-fou bit-identical) : ✓ fait via PR #51
- Phase 2 (retrait code legacy) : ✓ fait via 7 batches (PRs #53, #54, #55,
  #56, #57, #58, #59) — 18 détecteurs portés legacy retirés + 3 overrides
  directs.
- Phase 3 (retrait shadow comparator) : différé à N releases après
  Phase 2 stable.

## References

- ADR-026 — pattern Datalog déclaratif (= source du plan ; phases A.3/A.4/E
  ont posé les branchements runtime)
- ADR-029 — signaux propres avant refonte (= preuve via test parité)
- ADR-030 — JSON public vs TS interne (= refonte interne légitime)
- ADR-032 — cross-package contracts (= cascade impossible)
- ADR-033 — sub-snapshots (= pré-requis pour les phases suivantes)
- PR #39 — test parité Datalog/legacy bit-identical (initial 3 fields)
- PR #51 — Phase 1 verrouille parité bit-identical (3→20 fields, fixture
  canary)
