// ADR-008
/**
 * TaintDetector — section 5l de analyze() migrée.
 *
 * Flux source non-trusté → sink dangereux sans passage par un sanitizer.
 * Désactivé par défaut — activer via `detectorOptions.taint.enabled: true`
 * et fournir `detectorOptions.taint.rulesPath` ou laisser le default
 * `<rootDir>/taint-rules.json` / `<rootDir>/codegraph/taint-rules.json`.
 *
 * Pas factsOnly-eligible.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Detector, DetectorRunContext } from '../detector-registry.js'
import { analyzeTaint } from '../../extractors/taint.js'
import type { TaintRules, TaintViolation } from '../types.js'
import {
  allTaintViolations as incAllTaint,
  taintRulesInput as incTaintRules,
} from '../../incremental/taint.js'
import { setInputIfChanged as incSetInputIfChanged } from '../../incremental/queries.js'

async function findTaintRules(rootDir: string): Promise<string | null> {
  const candidates = [
    path.join(rootDir, 'taint-rules.json'),
    path.join(rootDir, 'codegraph', 'taint-rules.json'),
  ]
  for (const c of candidates) {
    // await-ok: probe avec return on first match, séquentiel requis
    try { await fs.access(c); return c } catch { /* probe: try next location */ }
  }
  return null
}

export class TaintDetector implements Detector<TaintViolation[]> {
  readonly name = 'taint'
  readonly factsOnlyEligible = false

  async run(ctx: DetectorRunContext): Promise<TaintViolation[] | undefined> {
    const enabled =
      (ctx.config.detectorOptions?.['taint']?.['enabled'] as boolean | undefined) ?? false
    if (!enabled) return undefined

    const rulesPath =
      (ctx.config.detectorOptions?.['taint']?.['rulesPath'] as string | undefined)
      ?? await findTaintRules(ctx.config.rootDir)
    if (!rulesPath) return undefined

    const raw = JSON.parse(await fs.readFile(rulesPath, 'utf-8'))
    const rules: TaintRules = {
      sources: raw.sources ?? [],
      sinks: raw.sinks ?? [],
      sanitizers: raw.sanitizers ?? [],
    }

    if (ctx.options.incremental) {
      incSetInputIfChanged(incTaintRules, 'all', rules)
      return incAllTaint.get('all')
    }
    return await analyzeTaint(ctx.config.rootDir, ctx.files, ctx.sharedProject, rules)
  }
}
