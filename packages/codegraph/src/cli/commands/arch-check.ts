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

export interface ArchCheckOpts {
  config?: string
  rules?: string
  json?: boolean
}

interface ArchRule {
  name: string
  description?: string
  from: string
  /** Single-hop forbidden target (existing sentinel-core behavior). */
  disallow?: string
  /** Transitive forbidden target (phase 3.7 #1). */
  disallowReachable?: string
}

interface Violation {
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

  // Resolve rules file path.
  let rulesPath = opts.rules
  if (!rulesPath) {
    const candidates = [
      path.join(config.rootDir, 'arch-rules.json'),
      path.join(config.rootDir, 'codegraph', 'arch-rules.json'),
    ]
    for (const p of candidates) {
      // await-ok: probe avec break sur première match, séquentiel requis
      try { await fs.access(p); rulesPath = p; break } catch { /* probe: try next */ }
    }
  }
  if (!rulesPath) {
    console.error(chalk.red('  No arch-rules.json found. Pass --rules or place one at the project root.'))
    process.exit(1)
  }

  const raw = JSON.parse(await fs.readFile(rulesPath, 'utf-8'))
  const rules: ArchRule[] = Array.isArray(raw.rules) ? raw.rules : []

  const files = snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id)
  const fileSet = new Set(files)

  const violations: Violation[] = []

  for (const r of rules) {
    if (!r.name || !r.from) continue
    const fromRe = globToRegex(r.from)
    const sources = new Set(files.filter((f) => fromRe.test(f)))
    if (sources.size === 0) continue

    // Direct `disallow` — reuse existing single-hop semantics.
    if (r.disallow) {
      const toRe = globToRegex(r.disallow)
      for (const e of snapshot.edges) {
        if (e.type !== 'import') continue
        if (!fileSet.has(e.from) || !fileSet.has(e.to)) continue
        if (fromRe.test(e.from) && toRe.test(e.to)) {
          violations.push({
            rule: r.name,
            ...(r.description ? { description: r.description } : {}),
            kind: 'direct',
            from: e.from,
            to: e.to,
          })
        }
      }
    }

    // Transitive `disallowReachable` — new.
    if (r.disallowReachable) {
      const toRe = globToRegex(r.disallowReachable)
      const targets = new Set(files.filter((f) => toRe.test(f)))
      if (targets.size === 0) continue
      const paths = findReachablePaths(sources, targets, snapshot.edges)
      for (const p of paths) {
        violations.push({
          rule: r.name,
          ...(r.description ? { description: r.description } : {}),
          kind: 'transitive',
          from: p.from,
          to: p.to,
          path: p.path,
        })
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ rulesFile: rulesPath, rulesCount: rules.length, violations }, null, 2))
    process.exit(violations.length > 0 ? 1 : 0)
  }

  console.log(chalk.bold('\n  CodeGraph Arch Check\n'))
  console.log(`  ${chalk.dim('rules file')} ${rulesPath}`)
  console.log(`  ${chalk.dim('rules')}      ${rules.length}`)
  console.log()

  if (violations.length === 0) {
    console.log(chalk.green('  ✓ No violations.\n'))
    process.exit(0)
  }

  // Group by rule for readable output.
  const byRule = new Map<string, Violation[]>()
  for (const v of violations) {
    const list = byRule.get(v.rule) ?? []
    list.push(v)
    byRule.set(v.rule, list)
  }
  for (const [name, vs] of byRule) {
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

  console.log(chalk.red(`  ${violations.length} violation(s)\n`))
  process.exit(1)
}
