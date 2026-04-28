/**
 * Runner du module `check` — phase 2 du PLAN.md.
 *
 * Expose `runCheck(before, after, config) → CheckResult`. Pur et
 * déterministe : donnée la même paire de snapshots + la même config,
 * produit la même liste de violations triée.
 *
 * La config `rules` est un mapping `ruleName → 'error' | 'warn' | 'off'`.
 * Les règles absentes utilisent leur `defaultSeverity`. Les règles `off`
 * sont sautées (et ne figurent pas dans `rulesRun`).
 */

import type { GraphSnapshot } from '../core/types.js'
import type { CheckRule, CheckResult, CheckRulesConfig, RuleSeverity, Violation } from './types.js'

import { noNewNonGatedCyclesRule } from './rules/cycles.js'
import { noNewOrphanStatesRule } from './rules/fsm-orphans.js'
import { noNewDeadStatesRule } from './rules/fsm-dead.js'
import { noNewCachelessTruthPointsRule } from './rules/truth-canonical.js'
import { typedCallsCoverageRule } from './rules/coverage.js'

export * from './types.js'

/**
 * Registry ordonné des règles. L'ordre détermine l'ordre d'exécution et
 * indirectement l'ordre initial des violations (retriées ensuite par
 * rule puis message pour stabilité).
 */
export const ALL_RULES: CheckRule[] = [
  noNewNonGatedCyclesRule,
  noNewOrphanStatesRule,
  noNewDeadStatesRule,
  noNewCachelessTruthPointsRule,
  typedCallsCoverageRule,
]

export function runCheck(
  before: GraphSnapshot,
  after: GraphSnapshot,
  config: CheckRulesConfig = {},
): CheckResult {
  const violations: Violation[] = []
  const rulesRun: string[] = []

  for (const rule of ALL_RULES) {
    const severity = resolveSeverity(rule, config)
    if (severity === 'off') continue

    rulesRun.push(rule.name)
    const ruleViolations = rule.run(before, after)
    for (const v of ruleViolations) {
      // La sévérité effective peut overrider la sévérité intrinsèque de
      // la règle (ex: passer `typed-calls-coverage` en error).
      violations.push({ ...v, severity: severity as 'error' | 'warn' })
    }
  }

  violations.sort((a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0
  })

  const counts = { error: 0, warn: 0 }
  for (const v of violations) counts[v.severity]++

  return {
    violations,
    passed: counts.error === 0,
    counts,
    rulesRun,
  }
}

function resolveSeverity(rule: CheckRule, config: CheckRulesConfig): RuleSeverity {
  const configured = config[rule.name]
  if (configured === 'error' || configured === 'warn' || configured === 'off') return configured
  return rule.defaultSeverity
}
