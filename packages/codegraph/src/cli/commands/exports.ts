// ADR-005
/**
 * `codegraph exports` — list unused exports (dead code candidates).
 *
 * Modes :
 *   - sans `--file` : summary, ranking par fichier
 *   - `--file <path>` : détail per-export (kind, usage count, confidence)
 *   - `--all` : inclut les exports utilisés
 *   - `--json` : sortie machine-friendly
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import { loadSnapshot } from '../_shared.js'

export interface ExportsOpts {
  config?: string
  file?: string
  all?: boolean
  json?: boolean
}

export async function runExportsCommand(snapshotPath: string | undefined, opts: ExportsOpts): Promise<void> {
  const snapshot = await loadSnapshot(snapshotPath, opts)
  const filesWithExports = snapshot.nodes.filter((n: any) => n.exports && n.exports.length > 0)

  if (opts.file) {
    runSingleFileMode(filesWithExports, opts)
    return
  }

  // Summary mode
  const totalExports = filesWithExports.reduce((s: number, n: any) => s + n.exports.length, 0)
  const totalUnused = filesWithExports.reduce((s: number, n: any) =>
    s + n.exports.filter((e: any) => e.usageCount === 0 && !e.reExport).length, 0)

  if (opts.json) {
    const ranked = filesWithExports
      .map((n: any) => ({
        file: n.id,
        totalExports: n.exports.length,
        unusedCount: n.exports.filter((e: any) => e.usageCount === 0 && !e.reExport).length,
        unusedSymbols: n.exports.filter((e: any) => e.usageCount === 0 && !e.reExport).map((e: any) => e.name),
      }))
      .filter((r: any) => r.unusedCount > 0)
      .sort((a: any, b: any) => b.unusedCount - a.unusedCount)
    console.log(JSON.stringify({ totalExports, totalUnused, files: ranked }, null, 2))
    return
  }

  // Confidence totals
  const conf = { safe: 0, test: 0, dynamic: 0, local: 0 }
  for (const n of filesWithExports) {
    for (const e of (n as any).exports) {
      if (e.confidence === 'safe-to-remove') conf.safe++
      else if (e.confidence === 'test-only') conf.test++
      else if (e.confidence === 'possibly-dynamic') conf.dynamic++
      else if (e.confidence === 'local-only') conf.local++
    }
  }

  console.log(chalk.bold('\n  Dead Exports Report\n'))
  console.log(`  Total exports:  ${totalExports} across ${filesWithExports.length} files`)
  console.log(`  ${chalk.red(String(conf.safe))} safe to remove · ${chalk.magenta(String(conf.local))} local-only · ${chalk.blue(String(conf.test))} test-only · ${chalk.yellow(String(conf.dynamic))} possibly dynamic`)
  console.log()

  const ranked = filesWithExports
    .map((n: any) => ({
      file: n.id, exports: n.exports,
      safe: n.exports.filter((e: any) => e.confidence === 'safe-to-remove').length,
      local: n.exports.filter((e: any) => e.confidence === 'local-only').length,
      test: n.exports.filter((e: any) => e.confidence === 'test-only').length,
      dynamic: n.exports.filter((e: any) => e.confidence === 'possibly-dynamic').length,
      unused: n.exports.filter((e: any) => e.usageCount === 0 && !e.reExport).length,
      total: n.exports.length,
    }))
    .filter((r: any) => r.unused > 0)
    .sort((a: any, b: any) => b.safe - a.safe || b.unused - a.unused)

  for (const r of ranked) {
    const tags = []
    if (r.safe > 0) tags.push(chalk.red(`${r.safe} dead`))
    if (r.local > 0) tags.push(chalk.magenta(`${r.local} local`))
    if (r.test > 0) tags.push(chalk.blue(`${r.test} test`))
    if (r.dynamic > 0) tags.push(chalk.yellow(`${r.dynamic} dyn?`))
    console.log(`  ${String(r.unused).padStart(3)}/${r.total.toString().padStart(3)}  ${r.file}`)
    console.log(`         ${tags.join(' · ')}`)
  }
  console.log()
}

function runSingleFileMode(filesWithExports: any[], opts: ExportsOpts): void {
  const q = opts.file!.toLowerCase()
  const node = filesWithExports.find((n: any) =>
    n.id.toLowerCase() === q || n.id.toLowerCase().endsWith(q) || n.id.toLowerCase().includes(q),
  )
  if (!node) {
    console.log(chalk.red(`  No file matching "${opts.file}" with export data.\n`))
    return
  }

  const nodeExports = node.exports || []
  const filteredExports = opts.all
    ? nodeExports
    : nodeExports.filter((e: any) => e.usageCount === 0 && !e.reExport)

  if (opts.json) {
    console.log(JSON.stringify({ file: node.id, exports: filteredExports }, null, 2))
    return
  }

  const unused = nodeExports.filter((e: any) => e.usageCount === 0 && !e.reExport).length
  console.log(chalk.bold(`\n  ${node.id}`))
  console.log(`  ${unused}/${nodeExports.length} unused exports\n`)

  const confIcon: Record<string, string> = {
    'safe-to-remove': chalk.red('×'),
    'test-only': chalk.blue('⊤'),
    'possibly-dynamic': chalk.yellow('?'),
    'local-only': chalk.magenta('◐'),
    used: chalk.green('✓'),
  }
  const confTag: Record<string, string> = {
    'safe-to-remove': chalk.red('DEAD'),
    'test-only': chalk.blue('TEST'),
    'possibly-dynamic': chalk.yellow('DYN?'),
    'local-only': chalk.magenta('LOCAL'),
    used: chalk.green('USED'),
  }

  for (const e of filteredExports) {
    const c = (e as any).confidence || (e.usageCount > 0 ? 'used' : 'safe-to-remove')
    const icon = confIcon[c] || chalk.dim('?')
    const tag = (confTag[c] || '').padEnd(16)
    const name = c === 'used' ? chalk.dim(e.name) : chalk.yellow(e.name)
    const kind = chalk.dim(`[${e.kind}]`)
    const usage = e.usageCount === 0 ? chalk.red('×0') : chalk.dim(`×${e.usageCount}`)
    console.log(`    ${icon} ${tag} ${kind.padEnd(22)} ${name.padEnd(30)} ${usage}  L${e.line}`)
    if ((e as any).reason) {
      console.log(chalk.dim(`                 ${(e as any).reason}`))
    }
  }
  console.log()
}
