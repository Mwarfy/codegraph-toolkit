// ADR-008
/**
 * CrossDisciplineDetector — wrap l'orchestrator des 11 disciplines
 * mathématiques en une Detector class compatible registry pattern.
 *
 * Étape 4/5 du backlog Phase d'après. Au lieu de créer 11 Detector classes
 * (1 par discipline), on wrap l'orchestrator existant qui fait déjà le
 * travail. Préserve la byte-identité des facts émis.
 *
 * Note : ce détecteur tourne APRÈS les détecteurs `complexity`, `symbol-
 * refs`, `typed-calls`, `co-change` — il consomme leurs outputs via
 * `ctx.snapshot.symbolRefs`, `ctx.snapshot.typedCalls`, etc. L'ordre
 * d'enregistrement dans le registry doit refléter cette dépendance.
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import {
  runCrossDisciplineDetectors,
  type CrossDisciplineResults,
} from '../../extractors/_shared/cross-discipline-orchestrator.js'
import type { CoChangePair } from '../../extractors/co-change.js'

export class CrossDisciplineDetector implements Detector<CrossDisciplineResults> {
  readonly name = 'cross-discipline'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<CrossDisciplineResults | undefined> {
    // L'orchestrator a besoin du `snapshot` partiel + `coChangePairs`.
    // Dans le registry, le snapshot est porté via ctx.results précédents
    // qui ont muté ctx.snapshot. coChange est dans snapshot.coChangePairs.
    const snapshot = (ctx as DetectorRunContext & { snapshot?: unknown }).snapshot as Parameters<typeof runCrossDisciplineDetectors>[0]['snapshot']
    if (!snapshot) {
      // Snapshot pas encore initialisé — skip (devrait pas arriver post-graph build)
      return undefined
    }

    const coChangePairs = (snapshot as unknown as { coChangePairs?: CoChangePair[] }).coChangePairs

    return await runCrossDisciplineDetectors({
      rootDir: ctx.config.rootDir,
      files: ctx.files,
      sharedProject: ctx.sharedProject,
      snapshot,
      coChangePairs,
      timing: { detectors: {} }, // timing local — patché dans le snapshot.timing par le caller
    })
  }
}
