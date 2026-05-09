// ADR-005
/**
 * `codegraph check` — run structural CI rules comparing current tree vs
 * a reference (git ref ou snapshot.json).
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 *
 * Modes :
 *   - `--list-rules` : liste les rules disponibles et leur sévérité par défaut
 *   - sinon : analyze ref + analyze current → runCheck → diff violations
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import { analyze } from '../../core/analyzer.js'
import { runCheck, ALL_RULES } from '../../check/index.js'
import { loadConfig, analyzeAtRef } from '../_shared.js'
import type { GraphSnapshot } from '../../core/types.js'

export interface CheckOpts {
  config?: string
  root?: string
  against?: string
  json?: boolean
  listRules?: boolean
}

export async function runCheckCommand(opts: CheckOpts): Promise<void> {
  if (opts.listRules) {
    console.log(chalk.bold('\n  CodeGraph Check — available rules\n'))
    for (const r of ALL_RULES) {
      const sev = r.defaultSeverity === 'error'
        ? chalk.red('error')
        : r.defaultSeverity === 'warn'
          ? chalk.yellow('warn')
          : chalk.dim('off')
      console.log(`  ${chalk.bold(r.name.padEnd(35))} ${sev.padEnd(14)} ${chalk.dim(r.description)}`)
    }
    console.log()
    return
  }

  const config = await loadConfig(opts)
  const against: string = opts.against ?? 'HEAD'
  // --json : toute la progression va sur stderr pour garder stdout = JSON pur.
  const progress = (msg: string): void => {
    if (opts.json) console.error(msg)
    else console.log(msg)
  }

  // Résoudre le snapshot "before" — soit un fichier .json, soit un git ref.
  let before: GraphSnapshot
  if (against.endsWith('.json')) {
    before = JSON.parse(await fs.readFile(against, 'utf-8'))
  } else {
    progress(chalk.dim(`\n  Analyzing reference ${against}...`))
    before = await analyzeAtRef(against, config)
  }

  progress(chalk.dim(`  Analyzing current tree...`))
  const after = (await analyze(config)).snapshot

  const result = runCheck(before, after, config.rules ?? {})

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.passed ? 0 : 1)
  }

  console.log(chalk.bold('\n  CodeGraph Check\n'))
  console.log(`  ${chalk.dim('ref')}    ${against}  ${chalk.dim('→')}  ${chalk.dim('current tree')}`)
  console.log(`  ${chalk.dim('rules')}  ${result.rulesRun.join(', ')}`)
  console.log()

  if (result.violations.length === 0) {
    console.log(chalk.green('  ✓ No violations.\n'))
    process.exit(0)
  }

  for (const v of result.violations) {
    const tag = v.severity === 'error' ? chalk.red('✗ error') : chalk.yellow('⚠ warn ')
    console.log(`  ${tag}  ${chalk.bold(v.rule)}`)
    console.log(`           ${v.message}`)
    console.log()
  }

  const summary = `${result.counts.error} error(s), ${result.counts.warn} warning(s)`
  console.log(result.passed ? chalk.yellow(`  ${summary}\n`) : chalk.red(`  ${summary}\n`))
  process.exit(result.passed ? 0 : 1)
}
