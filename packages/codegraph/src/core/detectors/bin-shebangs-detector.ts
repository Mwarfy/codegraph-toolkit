/**
 * BinShebangsDetector — publish hygiene.
 *
 * Détecte les bin entries de `package.json` que npm publish supprimerait
 * silencieusement (pas de shebang `#!/usr/bin/env node` en tête du fichier
 * cible) ou dont la cible n'existe pas sur disque.
 *
 * Pas factsOnly-eligible — pas (encore) de fact Datalog associé. Si
 * besoin futur (invariant ADR "tout package publishé doit avoir des bins
 * valides"), promote en `factsOnlyEligible: true` et émettre depuis
 * `facts/index.ts`.
 */

import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeBinShebangs } from '../../extractors/bin-shebangs.js'
import type { BinShebangIssue } from '../types.js'

export class BinShebangsDetector implements Detector<BinShebangIssue[]> {
  readonly name = 'bin-shebangs'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<BinShebangIssue[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['binShebangs']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined
    return await analyzeBinShebangs(ctx.config.rootDir)
  }
}
