/**
 * Types du module `check` — phase 2 du PLAN.md.
 *
 * Le check tourne sur deux snapshots (before, after) et émet une liste de
 * violations. Chaque règle est un `CheckRule` pur : `run(before, after) → Violation[]`.
 *
 * Les règles sont déterministes et n'ont accès qu'aux snapshots — pas au
 * système de fichiers, pas au réseau, pas au graphe runtime. Cela garantit
 * qu'une même paire (before, after) produit toujours la même sortie.
 */

import type { GraphSnapshot } from '../core/types.js'

/** Sévérité configurable par règle. `off` désactive la règle. */
export type RuleSeverity = 'error' | 'warn' | 'off'

/**
 * Une violation d'une règle — message lisible + détail structuré pour
 * consommation programmatique. `severity` est copié depuis la config
 * au moment du run, pour que le reporter sache quel code de sortie utiliser.
 */
export interface Violation {
  rule: string
  severity: 'error' | 'warn'
  message: string
  detail?: Record<string, unknown>
}

/**
 * Contract d'une règle. Les règles reçoivent les deux snapshots et la
 * config résolue. Elles renvoient les violations trouvées (sans trier —
 * le runner trie le résultat final pour stabilité).
 */
export interface CheckRule {
  /** Nom stable (slug) — sert de clé de config et d'identifiant de violation. */
  name: string
  /** Sévérité par défaut si la config ne la définit pas. */
  defaultSeverity: RuleSeverity
  /** Description courte (1 ligne) — affichée en verbose. */
  description: string
  /** Runner pur. `after` est le snapshot courant, `before` la référence. */
  run(before: GraphSnapshot, after: GraphSnapshot): Violation[]
}

/**
 * Config du check — mapping `ruleName → severity`. Les règles absentes
 * utilisent leur `defaultSeverity`.
 */
export type CheckRulesConfig = Record<string, RuleSeverity>

export interface CheckResult {
  /** Toutes les violations trouvées, triées (rule, message). */
  violations: Violation[]
  /** True si aucune violation `error`. Les `warn` ne font pas échouer. */
  passed: boolean
  /** Nombre de violations par sévérité. */
  counts: { error: number; warn: number }
  /** Les règles qui ont tourné (hors `off`). */
  rulesRun: string[]
}
