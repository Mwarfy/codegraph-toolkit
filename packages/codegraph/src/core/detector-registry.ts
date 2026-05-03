// ADR-008
/**
 * Detector Registry — pattern visiteur pour découper analyze() (god-file).
 *
 * Phase A (Sprint X) : scaffolding minimal + 1 détecteur PoC migré
 * (`oauth-scope-literals`). Les autres détecteurs restent inline dans
 * analyze() — Phase B les migrera un par un avec parité bit-pour-bit.
 *
 * Architecture cible :
 *   - `Detector` : contract uniforme (name + factsOnlyEligible + run)
 *   - `DetectorRunContext` : carrier mutable porté de détecteur en
 *     détecteur. Contient config, files, sharedProject, options + un
 *     `results` map où chaque détecteur écrit son output.
 *   - `DetectorRegistry.runAll()` : itère les détecteurs registered,
 *     skip ceux non-factsOnly-eligible si options.factsOnly, gère
 *     timing + error logging uniformément.
 *
 * Le code post-detector dans analyze() lit `ctx.results[name]` au lieu
 * d'une local var, puis patch le snapshot comme avant. Parité préservée.
 *
 * NB : `dependsOn` n'est PAS implémenté en Phase A — KISS, on garde
 * l'ordre d'enregistrement = ordre d'exécution. Phase B introduira
 * topological sort si nécessaire.
 */

import type { CodeGraphConfig } from './types.js'
import type { Project } from 'ts-morph'
import type { CodeGraph } from './graph.js'

export interface DetectorRunContext {
  /** Config du projet courant */
  config: CodeGraphConfig
  /** Files relatifs au rootDir, pré-discovery */
  files: string[]
  /** Project ts-morph partagé (déjà construit) */
  sharedProject: Project
  /**
   * Graph builé (nodes + edges + orphan status). Les détecteurs aval
   * (cycles, truth-points, data-flows) en lisent `getAllEdges()` ; les
   * détecteurs unused-exports/complexity en mutent les nodes via
   * `setNodeExports` / `setNodeMeta`.
   */
  graph: CodeGraph
  /** tsconfig.json path résolu (pour aliases). undefined si non trouvé. */
  tsConfigPath: string | undefined
  /** readFile helper (fileCache-backed) — utilisé par certains détecteurs deterministes. */
  readFile: (relativePath: string) => Promise<string>
  /** Options runtime (factsOnly, incremental, etc.) */
  options: { factsOnly?: boolean; incremental?: boolean }
  /**
   * Résultats produits par les détecteurs. Indexé par `Detector.name`.
   * Un détecteur écrit ici via `run()` retournant son output (le runner
   * stocke automatiquement). Le code post-detector lit depuis ce map.
   */
  results: Record<string, unknown>
}

export interface Detector<TResult = unknown> {
  /**
   * Nom unique du détecteur. Sert de :
   *   - clé dans `ctx.results`
   *   - clé dans `timing.detectors`
   *   - tag dans les error logs
   */
  name: string

  /**
   * Si true, le détecteur tourne aussi en mode `options.factsOnly`.
   * Sinon il est skip. Reflète le pattern actuel de analyze() où
   * certains détecteurs (event-emit-sites, env-usage, oauth-scope-literals,
   * module-metrics) sont nécessaires aux Datalog facts.
   */
  factsOnlyEligible: boolean

  /**
   * Exécute le détecteur. Peut retourner `undefined` si le détecteur
   * est désactivé via `config.detectorOptions[name].enabled = false` —
   * dans ce cas rien n'est stocké dans ctx.results.
   */
  run(ctx: DetectorRunContext): Promise<TResult | undefined>
}

export class DetectorRegistry {
  private detectors: Detector[] = []

  register(detector: Detector): this {
    this.detectors.push(detector)
    return this
  }

  /**
   * Exécute tous les détecteurs enregistrés dans l'ordre d'enregistrement.
   *
   * Comportement :
   *   - Skip si `options.factsOnly && !detector.factsOnlyEligible`
   *   - Track timing dans `timing.detectors[detector.name]`
   *   - Catch errors, log via console.error (ne stoppe pas le pipeline)
   *   - Stocke result dans `ctx.results[detector.name]` si retour !== undefined
   *
   * NB : pas d'await en parallèle — l'ordre déterministe est nécessaire
   * pour la parité (certains détecteurs read mutations faites par les
   * précédents via ctx.results ou config-derived state).
   */
  async runAll(
    ctx: DetectorRunContext,
    timing: Record<string, number>,
  ): Promise<void> {
    const factsOnly = ctx.options.factsOnly ?? false
    for (const detector of this.detectors) {
      if (factsOnly && !detector.factsOnlyEligible) continue
      const t0 = performance.now()
      try {
        const result = await detector.run(ctx)
        if (result !== undefined) {
          ctx.results[detector.name] = result
        }
        timing[detector.name] = performance.now() - t0
      } catch (err) {
        timing[detector.name] = performance.now() - t0
        console.error(`  ✗ ${detector.name} failed: ${err}`)
      }
    }
  }
}
