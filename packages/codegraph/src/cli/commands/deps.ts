// ADR-005
/**
 * `codegraph deps` — package.json hygiene check.
 *
 * Liste les déclarations problématiques de package.json (declared-unused,
 * missing, devOnly) + les barrels low-value. Exit code 1 si missing
 * detected.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import { loadSnapshot } from '../_shared.js'

export interface DepsOpts {
  config?: string
  json?: boolean
  only?: string
}

export async function runDepsCommand(snapshotPath: string | undefined, opts: DepsOpts): Promise<void> {
  const snapshot = await loadSnapshot(snapshotPath, opts)
  const issues = snapshot.packageDeps ?? []
  const barrels = snapshot.barrels ?? []

  const filtered = opts.only
    ? issues.filter((i) => i.kind === opts.only)
    : issues
  const lowValueBarrels = barrels.filter((b) => b.lowValue)

  if (opts.json) {
    console.log(JSON.stringify({
      issues: filtered,
      barrels: { total: barrels.length, lowValue: lowValueBarrels },
    }, null, 2))
    process.exit(filtered.some((i) => i.kind === 'missing') ? 1 : 0)
  }

  console.log(chalk.bold('\n  Package Deps Hygiene\n'))

  if (issues.length === 0) {
    console.log(chalk.green('  ✓ No deps issues.\n'))
  } else {
    // Group by packageJson
    const byManifest = new Map<string, typeof issues>()
    for (const i of filtered) {
      const list = byManifest.get(i.packageJson) ?? []
      list.push(i)
      byManifest.set(i.packageJson, list)
    }

    const counts = { 'declared-unused': 0, 'declared-runtime-asset': 0, missing: 0, devOnly: 0 }
    for (const i of filtered) counts[i.kind]++
    console.log(`  ${chalk.red(String(counts.missing))} missing · ${chalk.yellow(String(counts['declared-unused']))} declared-unused · ${chalk.magenta(String(counts['declared-runtime-asset']))} runtime-asset · ${chalk.blue(String(counts.devOnly))} devOnly`)
    console.log()

    for (const [manifest, list] of [...byManifest].sort()) {
      console.log(chalk.bold(`  ${manifest}`) + chalk.dim(`  (${list.length})`))
      const byKind = new Map<string, typeof list>()
      for (const i of list) {
        const arr = byKind.get(i.kind) ?? []
        arr.push(i)
        byKind.set(i.kind, arr)
      }
      for (const kind of ['missing', 'devOnly', 'declared-unused'] as const) {
        const group = byKind.get(kind)
        if (!group || group.length === 0) continue
        const icon = kind === 'missing' ? chalk.red('✗')
                   : kind === 'devOnly' ? chalk.blue('◐')
                   : chalk.yellow('–')
        for (const i of group) {
          const loc = i.declaredIn ? chalk.dim(` [${i.declaredIn}]`) : ''
          console.log(`    ${icon} ${kind.padEnd(16)} ${i.packageName}${loc}`)
          if (i.importers.length > 0 && i.importers.length <= 3) {
            console.log(chalk.dim(`        ${i.importers.join(', ')}`))
          } else if (i.importers.length > 3) {
            console.log(chalk.dim(`        ${i.importers.slice(0, 3).join(', ')} … +${i.importers.length - 3}`))
          }
        }
      }
      console.log()
    }
  }

  // Barrels summary
  console.log(chalk.bold(`  Barrels\n`))
  if (barrels.length === 0) {
    console.log(chalk.dim('  No barrel files detected.\n'))
  } else {
    console.log(`  Total barrels: ${barrels.length} · ${chalk.yellow(String(lowValueBarrels.length))} low-value (< 2 consumers)`)
    if (lowValueBarrels.length > 0) {
      console.log()
      for (const b of lowValueBarrels) {
        console.log(`    ${chalk.yellow('◐')} ${b.file}`)
        console.log(chalk.dim(`        ${b.reExportCount} re-exports · ${b.consumerCount} consumer(s)`))
      }
    }
    console.log()
  }

  process.exit(filtered.some((i) => i.kind === 'missing') ? 1 : 0)
}
