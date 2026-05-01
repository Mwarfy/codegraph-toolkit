# Cross-discipline metrics — codegraph

> 6 disciplines mathématiques portées vers les analyzers TS/JS pour la
> première fois (à notre connaissance). Chaque métrique = signal
> orthogonal aux autres, fondé sur un théorème classique.

## Pourquoi ces métriques n'existaient pas

Les analyzers code TS/JS du marché (CodeQL, ESLint, SonarQube, Semgrep,
ts-prune, jscpd) capturent tous des patterns AST + des heuristiques
ad-hoc. Aucun n'utilise les métriques mathématiques classiques de :

- **Théorie spectrale des graphes** (Fiedler 1973, eigenvalues du Laplacien)
- **Théorie de l'information** (Shannon 1948, entropie distribution)
- **Théorie des codes** (Hamming 1950, distance entre signatures)
- **Topological Data Analysis** (Edelsbrunner et al. 2002, persistent homology)
- **Systèmes dynamiques** (Lyapunov 1892, exposants chaos)
- **Théorie des flots** (Ford-Fulkerson 1956, max-flow min-cut)

Ce ne sont pas des limites théoriques — ce sont des disciplines
classiques. C'est un silence interdisciplinaire : personne n'a fait
l'effort de les composer dans un analyzer code.

## Les 6 métriques + leurs rules

### 1. Algebraic connectivity (Fiedler λ₂)

**Théorème** : λ₂ du Laplacien d'un graphe = connectivité algébrique.
Cheeger inequality : λ₂/2 ≤ h(G) ≤ √(2λ₂).

**Application** : par sous-graphe (scope = 3 path segments), λ₂ très
bas signale une quasi-déconnexion (frontière artificielle ou split
naturel). λ₂ très haut = monolithe latent.

**Rule** : `composite-spectral-bottleneck` (λ₂ × 1000 < 50, scope ≥ 5 nodes).

**Source** : `extractors/spectral-graph.ts` (~140 LOC, power iteration projetée).

### 2. Shannon entropy de callees

**Théorème** : H(X) = -Σ p(x) log p(x). Mesure l'imprévisibilité d'une
distribution.

**Application** : pour chaque fonction, H(callees) sur la distribution
des callees appelés. H haute = god dispatcher (orchestre N actions
hétéroclites). H basse = répétition.

**Rule** : `composite-god-dispatcher` (entropy × 1000 > 4000 ∧ ≥ 10 callees).

**Source** : `extractors/symbol-entropy.ts` (~75 LOC).

**Composition** : avec McCabe cyclomatic = signal orthogonal. Aucune
des 2 disciplines seule ne capture le pattern god-dispatcher.

### 3. Hamming near-duplicate

**Théorème** : distance de Hamming entre 2 vecteurs binaires = nb de
positions différentes. Permet codes correcteurs (Hamming codes).

**Application** : encoder la "shape" de chaque fonction (paramCount +
kind + returnKind + line bucket) sur ~10 bits. Hamming = 0 entre 2
files distincts (avec sameName) = copy-paste fork.

**Rule** : `composite-copy-paste-fork` (Hamming = 0).

**Source** : `extractors/signature-duplication.ts` (~100 LOC).

**Validation** : Sentinel — 2 vrais positifs (admin/project-manager
pauseProject + 2 reset cache helpers).

### 4. Persistent homology (TDA)

**Théorème** : Edelsbrunner-Letscher-Zomorodian 2002. Persistent
homology étudie comment les invariants topologiques (composantes,
cycles) apparaissent et disparaissent au cours d'une filtration.

**Application** : pour chaque cycle d'imports identifié, compter
combien de snapshots historiques git le contiennent. Persistence > 50%
= INVARIANT TOPOLOGIQUE (design implicite). Persistence < 10% =
accidentel (refactor récent).

**Rule** : `composite-structural-cycle-persistent` (>50% ∧ !gated).

**Source** : `extractors/persistent-cycles.ts` (~120 LOC).

**Validation** : toolkit — détecté un cycle bootstrap.ts ↔ bootstrap-fsm.ts
à 72% persistence (cycle qui existait pendant 36 commits avant que
notre fix de session le casse).

### 5. Lyapunov exponent (chaos detection)

**Théorème** : λ_Lyapunov mesure la divergence exponentielle de
trajectoires initialement proches. λ > 0 = chaos déterministe.

**Application** : λ_file = log(avg co-change + 1). Files où une touche
déclenche en moyenne > e ≈ 2.7 co-changes = amplificateurs de chaos
(cascade refactor automatique).

**Rule** : `composite-chaos-amplifier` (λ × 1000 > 2000).

**Source** : `extractors/lyapunov-cochange.ts` (~75 LOC).

**Validation** : toolkit top λ confirmé empiriquement par l'expérience
de session (facts/index.ts, types.ts, analyzer.ts ont effectivement
déclenché des cascades de modifications).

### 6. Min-cut / max-flow

**Théorème** : Ford-Fulkerson 1956. Max-flow = min-cut entre 2
ensembles. Min-cut = nb minimum d'arêtes à supprimer pour déconnecter.

**Application** : pour chaque paire de packages npm, calculer le
min-cut sur le graphe d'imports. Donne le coût OBJECTIF de séparation.

**Rule** : `composite-package-coupling` (minCut > 5).

**Source** : `extractors/package-mincut.ts` (~140 LOC, Edmonds-Karp BFS).

**Validation** : toolkit — `codegraph → salsa` minCut=19 confirmé,
correspond à l'usage intensif de Salsa pour memoization de queries.

## Composition orthogonale

| Métrique | Mesure | Orthogonal à |
|---|---|---|
| PageRank (Brin/Page) | Centralité globale | Fiedler, Min-cut |
| Fiedler λ₂ | Connectivité interne d'un sous-graphe | PageRank, Shannon, Min-cut |
| Shannon H(callees) | Imprévisibilité distribution | Cyclomatic, Fiedler |
| Hamming sig | Similarité structurelle | tous (mesure de paire) |
| Persistent homology | Invariance temporelle | tous (axe temporel) |
| Lyapunov λ | Amplification dynamique | Persistent (différent axe temporel) |
| Min-cut | Coût séparation 2 ensembles | PageRank (centralité globale) |

Aucune redondance — chaque discipline ouvre un angle d'observation
distinct. Combinées, elles produisent des composites multi-rule
high-confidence qu'aucune discipline seule ne peut capturer.

## Ce que ça démontre

L'asymptote des analyzers actuels n'est pas mathématique — c'est le
silence interdisciplinaire. Le déterminisme + composition de
disciplines = espace bien plus large que l'industrie n'exploite.

Suite possible (non implémentée) :
- **Information bottleneck** (Tishby) : I(input; output) par fonction.
  Mesure quantitative de l'info effectivement traitée.
- **Free energy minimization** (Friston) : stabilité architecturale
  via modèle thermodynamique.
- **Graph neural networks** : prédire les hot zones via embedding
  appris sur snapshots historiques.

Chaque ajout = nouveau signal orthogonal. Le plafond effectif est
beaucoup plus haut que ce que la littérature software-engineering
classique laisse penser.
