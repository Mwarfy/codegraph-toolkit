# Magic thresholds — calibration & rationale

Cette page documente les **seuils numériques** utilisés par les extracteurs
et règles datalog du toolkit. Chaque seuil est explicité : valeur, où
il est utilisé, comment il a été dérivé, et comment le tweaker.

> ⚠ **Warning honnêteté** : la plupart de ces seuils sont **calibrés
> sur le toolkit lui-même + Sentinel**, pas sur un ensemble divers de
> projets TS open-source. Les valeurs sont des _estimates initiaux_,
> pas des constants validées par benchmark statistique. Si tu utilises
> le toolkit sur un projet de shape différent, surveille les false
> positives et override via config ou env var.

## Légende

- **Hard-coded** : seuil dans le code, demande un fork pour changer.
- **Config-overridable** : peut être passé via options du detector.
- **Env-overridable** : peut être passé via env var `LIBY_*`.

---

## Heuristiques mathématiques (avec disclaimers)

| Seuil | Valeur | Override | Rationale |
|---|---|---|---|
| `lyapunov-cochange` cliff | score > 2 | hard-coded | log(avg co-change + 1) > 2 ⇔ avg ≥ 6 fichiers co-changeant — calibré sur Sentinel (cluster `kernel/` cohabite avec `blocks/`, score moyen ~2.3) |
| `information-bottleneck` chokepoint | score > 25 | hard-coded | log₂(callers+1) × log₂(callees+1) > 25 ⇔ ~32 callers × 8 callees minimum, fan-in fan-out réel élevé — calibré sur top hubs Sentinel |
| `persistent-cycles` structural | frequency ≥ 50% snapshots | hard-coded | binary majority — moins de 50% = bruit refactor, plus = design intentionnel |
| `granger` lag-1 signal | excess ≥ 0.15 (× 1000 = 150) | option `minExcessX1000` | 15 percentage points au-dessus du baseline — choix arbitraire pragmatique, à valider avec significance test sur > 100 commits |
| `granger` min observations | ≥ 3 | option `minObservations` | ratchet bayésien : exclu les patterns 1-shot statistiquement non-fiables |
| `spectral` λ₂ low connectivity | < 0.10 (×1000 = 100) | hard-coded | Cheeger : sous-graphe presque déconnecté, candidate split natural |

## Architecture / hubs

| Seuil | Valeur | Override | Rationale |
|---|---|---|---|
| `barrel` low-value | < 2 consumers | option `minConsumers` | seul barrel à 1 consumer = wrapper inutile, inline-able |
| `articulation-points` skip | none | — | tous emis, ranking côté consumer |
| Hub fan-in (governance gate) | ≥ 3 importeurs | hard-coded dans `tests/hubs-have-adr-invariant.test.ts` | seuil minimum pour qu'un fichier mérite gouvernance — 3 = pattern établi (cf. test invariant) |
| Top hub fan-in (split alarm) | > 100 | hard-coded | le `core/types.ts` du toolkit est à ~75 — 100 laisse marge évolution |

## Performance / runtime

| Seuil | Valeur | Override | Rationale |
|---|---|---|---|
| Self-runtime hot detector | mean ≥ 200ms warm | hard-coded `tests/self-runtime-regression.test.ts` | seuil pratique pour valoir l'investissement Salsa-isation (gain attendu ~99% × mean) |
| Self-runtime no-cache λ | λ_lyap ≤ 1.10 | hard-coded | preuve mathématique d'absence de cache (p95 ≈ median) |
| `analyze` total budget | < 10s warm sur Sentinel | informational | mesure post-optim Salsa γ : warm = 2.1s, cold = 4.8s |

## SQL / sécurité

| Seuil | Valeur | Override | Rationale |
|---|---|---|---|
| `magic-numbers` threshold | ≥ 1000 (literal) | hard-coded | catch ms timeouts / large-int, < 1000 = bruit (offsets, indices) |
| `function-complexity` McCabe | > 10 alert | hard-coded | seuil SonarQube standard, McCabe 1976 |
| `long-functions` LOC | > 100 | hard-coded | seuil SonarQube standard |

## Comment override les seuils

### 1. Via options de detector (recommandé)

```ts
import { computeBarrels } from '@liby-tools/codegraph/extractors/barrels'
const barrels = computeBarrels(graph, { minConsumers: 5 })
```

### 2. Via config du toolkit

Les détecteurs project-specific (ADR-003) ne tournent que si activés
via `codegraph.config.json` :

```json
{
  "detectors": ["ts-imports", "barrels", "lyapunov-cochange"]
}
```

### 3. Pour les seuils hard-coded

Fork du toolkit + modification directe + dogfood-test sur ton projet.
Les seuils inscrits ici sans `Override` colonne demandent ce path.
Une issue GitHub demandant que le seuil devienne configurable est
recevable.

## Plan calibration future

- [ ] Run le toolkit sur 5 projets TS OSS divers (Next.js, Astro, Hono,
  Remix, monorepo Turborepo) pour collecter une distribution réelle
  de chaque score.
- [ ] Calculer percentile-based thresholds (p95 sur la distribution
  inter-projets) pour remplacer les valeurs hardcoded.
- [ ] Documenter par seuil : source distribution + sample size + p50/p95/p99.

D'ici là, ces seuils sont **best-effort honest** : ils signalent dans
la pratique sur les 2 projets dogfoodés, mais peuvent over-flag ou
sous-flag sur d'autres shapes.
