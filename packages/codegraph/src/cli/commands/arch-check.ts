// ADR-005
/**
 * `codegraph arch-check` — validate architecture rules against the snapshot.
 *
 * Lit `arch-rules.json` (auto-resolved depuis rootDir/codegraph), évalue
 * chaque rule (single-hop `disallow` ou transitif `disallowReachable`)
 * contre les imports du graph, exit 1 si violations.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { findReachablePaths, globToRegex } from '../../graph/reachability.js'
import { loadConfig, loadSnapshot } from '../_shared.js'
import type { GraphEdge } from '../../core/types.js'

export interface ArchCheckOpts {
  config?: string
  rules?: string
  json?: boolean
}

export interface ArchRule {
  name: string
  description?: string
  from: string
  /** Single-hop forbidden target (existing sentinel-core behavior). */
  disallow?: string
  /** Transitive forbidden target (phase 3.7 #1). */
  disallowReachable?: string
}

export interface Violation {
  rule: string
  description?: string
  kind: 'direct' | 'transitive'
  from: string
  to: string
  path?: string[]
}

export async function runArchCheckCommand(opts: ArchCheckOpts): Promise<void> {
  const config = await loadConfig(opts)
  const snapshot = await loadSnapshot(undefined, opts)

  const rulesPath = await resolveRulesPath(config.rootDir, opts)
  if (!rulesPath) {
    console.error(chalk.red('  No arch-rules.json found. Pass --rules or place one at the project root.'))
    process.exit(1)
  }

  const raw = JSON.parse(await fs.readFile(rulesPath, 'utf-8'))
  const rules: ArchRule[] = Array.isArray(raw.rules) ? raw.rules : []

  const files = snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id)
  const violations = evaluateRules(rules, files, new Set(files), snapshot.edges)

  if (opts.json) {
    console.log(JSON.stringify({ rulesFile: rulesPath, rulesCount: rules.length, violations }, null, 2))
  } else {
    printArchCheckText(rulesPath, rules.length, violations)
  }
  process.exit(violations.length > 0 ? 1 : 0)
}

/**
 * Résout le chemin du fichier `arch-rules.json` : option explicite, puis
 * conventions `<root>/arch-rules.json` et `<root>/codegraph/arch-rules.json`.
 * Retourne `null` si aucun candidat n'existe (l'appelant décide de l'exit).
 */
async function resolveRulesPath(rootDir: string, opts: ArchCheckOpts): Promise<string | null> {
  if (opts.rules) return opts.rules
  const candidates = [
    path.join(rootDir, 'arch-rules.json'),
    path.join(rootDir, 'codegraph', 'arch-rules.json'),
  ]
  for (const p of candidates) {
    try {
      // await-ok: probe avec return sur première match, séquentiel requis
      await fs.access(p)
      return p
    } catch {
      /* probe: try next */
    }
  }
  return null
}

/** Rendu console groupé par rule (cap 10 lignes par catégorie). Pas d'exit. */
function printArchCheckText(rulesPath: string, rulesCount: number, violations: Violation[]): void {
  console.log(chalk.bold('\n  CodeGraph Arch Check\n'))
  console.log(`  ${chalk.dim('rules file')} ${rulesPath}`)
  console.log(`  ${chalk.dim('rules')}      ${rulesCount}`)
  console.log()

  if (violations.length === 0) {
    console.log(chalk.green('  ✓ No violations.\n'))
    return
  }

  const byRule = new Map<string, Violation[]>()
  for (const v of violations) {
    const list = byRule.get(v.rule) ?? []
    list.push(v)
    byRule.set(v.rule, list)
  }
  for (const [name, vs] of byRule) {
    printRuleViolations(name, vs)
  }

  console.log(chalk.red(`  ${violations.length} violation(s)\n`))
}

/** Affiche les violations d'une rule : direct puis transitive, cap 10 chacune. */
function printRuleViolations(name: string, vs: Violation[]): void {
  console.log(chalk.red(`  ✗ ${name}`) + chalk.dim(`  (${vs.length})`))
  const direct = vs.filter((v) => v.kind === 'direct')
  const transitive = vs.filter((v) => v.kind === 'transitive')
  for (const v of direct.slice(0, 10)) {
    console.log(`      direct     ${v.from} → ${v.to}`)
  }
  if (direct.length > 10) console.log(chalk.dim(`      … +${direct.length - 10} more direct`))
  for (const v of transitive.slice(0, 10)) {
    console.log(`      transitive ${v.path!.join(' → ')}`)
  }
  if (transitive.length > 10) console.log(chalk.dim(`      … +${transitive.length - 10} more transitive`))
  console.log()
}

/**
 * Évalue chaque rule contre les imports du graph. Pure : aucun I/O, aucun
 * accès console — entièrement déterminée par ses arguments. Découplée de
 * `runArchCheckCommand` pour être testable indépendamment du I/O fichier.
 */
export function evaluateRules(
  rules: ArchRule[],
  files: string[],
  fileSet: Set<string>,
  edges: GraphEdge[],
): Violation[] {
  const violations: Violation[] = []
  for (const r of rules) {
    if (!r.name || !r.from) continue
    const fromRe = globToRegex(r.from)
    const sources = new Set(files.filter((f) => fromRe.test(f)))
    if (sources.size === 0) continue
    if (r.disallow) {
      violations.push(...collectDirectViolations(r, fromRe, fileSet, edges))
    }
    if (r.disallowReachable) {
      violations.push(...collectTransitiveViolations(r, sources, files, edges))
    }
  }
  return violations
}

/** Métadonnées communes à toute violation d'une rule (nom + description opt). */
function ruleMeta(r: ArchRule): Pick<Violation, 'rule'> & Partial<Pick<Violation, 'description'>> {
  return { rule: r.name, ...(r.description ? { description: r.description } : {}) }
}

/** Imports directs (single-hop) `from → disallow` présents dans le graph. */
function collectDirectViolations(
  r: ArchRule,
  fromRe: RegExp,
  fileSet: Set<string>,
  edges: GraphEdge[],
): Violation[] {
  const toRe = globToRegex(r.disallow!)
  const out: Violation[] = []
  for (const e of edges) {
    if (e.type !== 'import') continue
    if (!fileSet.has(e.from) || !fileSet.has(e.to)) continue
    if (fromRe.test(e.from) && toRe.test(e.to)) {
      out.push({ ...ruleMeta(r), kind: 'direct', from: e.from, to: e.to })
    }
  }
  return out
}

/** Chemins transitifs (multi-hop) `from ⇝ disallowReachable` via BFS. */
function collectTransitiveViolations(
  r: ArchRule,
  sources: Set<string>,
  files: string[],
  edges: GraphEdge[],
): Violation[] {
  const toRe = globToRegex(r.disallowReachable!)
  const targets = new Set(files.filter((f) => toRe.test(f)))
  if (targets.size === 0) return []
  return findReachablePaths(sources, targets, edges).map((p) => ({
    ...ruleMeta(r),
    kind: 'transitive',
    from: p.from,
    to: p.to,
    path: p.path,
  }))
}
