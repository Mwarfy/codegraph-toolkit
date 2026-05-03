# Self-optim roadmap — niveaux d'automatisation

État actuel des niveaux d'automatisation du self-optim mathématique :

## Niveau 1 — Math gate + brief inject ✓ shipped

  - `self-runtime-probe.ts` mesure les timings par détecteur
  - λ_lyap auto-découvre les candidats (mean ≥ 200ms + λ ≤ 1.10)
  - `inject-self-optim-brief.ts` injecte le ROI rank dans BRIEF
  - Hook PostToolUse permet à Claude de voir au début de session
  - Test `hubs-have-adr-invariant` gate les nouveaux hubs sans ADR

## Niveau 2A — Static cost estimator ✓ shipped

  - `static-cost-estimator.ts` modèle log-linéaire 4 features
  - Calibration via OLS sur DetectorTiming.facts
  - **Limites** : R² ~0.20 (dataset 48 datapoints), MAPE 354%
  - Utile comme outil d'investigation (`--rank` révèle anomalies)
  - PAS un remplaçant du probe

## Niveau 2B — Salsa disk persist ✓ existing

  - `incremental/persistence.ts` : full + delta save
  - Couvre TOUS les derived
  - **Limite résiduelle** : ~2.7s irréductibles cold start = ts-morph
    Project rebuild. Optim demande AST binary serialization (Niveau 7).

## Niveau 4 — Aggregation synthesis ✓ shipped

  - `synth-aggregation.ts` introspection ts-morph Bundle interface
  - Génère wrapper Salsa complet pour ~70% des détecteurs
  - Validé : régénère `dead-code.ts` identique à manuel
  - **Limite** : pattern concat-only, pas 2-pass cross-fichier

## Niveau 5 — Effect analysis ✓ shipped (this commit)

  - `effect-analysis.ts` reaching definitions simplifiée via ts-morph
  - Détecte 1-pass / 2-pass / cross-snapshot / unknown
  - Sur 52 détecteurs codegraph :
      - 19 = 1-pass (synthesizable direct)
      - 3 = 2-pass (synthesizable avec décomposition)
      - 30 = unknown (heuristique syntactique limitée)
  - **Précision honnête** : 42%, pas 70% (le critique avait raison sur
    cette nuance)

## Niveau 6 — Parallel Salsa eval (déféré)

  - **Pourquoi déféré** : Node single-threaded JS → `Promise.all` sur
    détecteurs CPU-bound ne paralléllise rien. Vrai gain demande
    `worker_threads` pool.
  - **Coût estimé** : 3-4h refactor (sérialiser le ts-morph Project
    par worker, gérer les caches Salsa cross-worker).
  - **Gain attendu sur notre profile** : faible. La majorité des
    détecteurs sont Salsa-cached à ~0ms warm. Les non-cachés restants
    (persistent-cycles, deprecated-usage) sont séquentiellement courts.
  - **Quand l'attaquer** : si on ajoute des détecteurs CPU-lourds non-
    cacheables (ML embeddings, complex graph algos > 500ms).

## Niveau 7 — AST binary serialization (déféré)

  - **Pourquoi déféré** : sérialiser ts-morph Project en binaire
    avec gestion des références cycliques = projet de plusieurs jours.
  - **Coût estimé** : 1-2 semaines (custom serializer + lazy node
    materialization + tests round-trip).
  - **Gain attendu** : élim ~2s cold start (ts-morph reparse).
  - **Alternative pragmatique** : skip ts-morph Project rebuild si TOUS
    les mtimes sont inchangés depuis le dernier baseline (i.e. tous les
    derived sont cache hits). ~30 min de refactor, gain ~2s cold quand
    rien n'a changé. Dégrade gracefully si 1+ fichier modifié.

## Roadmap d'effort vs gain

  | Niveau | Effort   | Gain runtime          | Status |
  | ────── | ──────── | ──────────────────── | ────── |
  | 1      | 2h       | math gate (qualitative) | ✓     |
  | 2A     | 1h       | tooling investigation   | ✓     |
  | 2B     | existing | -2.7s (déjà appliqué)   | ✓     |
  | 4      | 2h       | gain dev workflow       | ✓     |
  | 5      | 1h       | classification 42% auto | ✓     |
  | 6      | 4h       | low (current profile)   | déféré |
  | 7      | 1-2 sem  | -2s cold start          | déféré |
  | 7-alt  | 30 min   | -2s cold quand rien changé | TODO |

Decision rule : Niveau 6 et 7 demandent un trigger réel (nouveau
détecteur lourd ou plainte cold start) avant de mériter l'effort.

## Reste manuel après tout

Même au max théorique, ces 2 étapes restent humaines :

  - **Wiring dans analyzer.ts** : 3 lignes par nouveau détecteur Salsa.
    Pourrait être automatisé via codemod ts-morph mais le ROI est faible.

  - **Compléter scaffold pour 30% d'unknown patterns** : les détecteurs
    qui n'ont ni la signature `extract<X>FileBundle` ni le pattern
    `for (const sf of project.getSourceFiles())` demandent review humain.
    C'est intentionnel : ces détecteurs sont les cas où les heuristiques
    syntactiques se trompent (lyapunov-cochange sur CoChangePair, granger
    sur git execSync, etc.).

  - **Calibration des seuils** : aucun modèle ne peut deviner que λ_lyap
    > 1.10 = "pas de cache" SANS expérimenter et valider sur des projets
    réels. Niveau 1 met le seuil ; les humains observent les FP/FN sur
    leur projet et tweakent.
