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
 * Extrait du god-file `cli/index.ts` (P2b split). `runExportsCommand` et
 * `runSingleFileMode` orchestrent ; la logique (prédicat unused, comptage,
 * ranking, résolution de fichier) vit dans des helpers purs testables.
 */

import chalk from 'chalk'
import { loadSnapshot } from '../_shared.js'

export interface ExportsOpts {
  config?: string
  file?: string
  all?: boolean
  json?: boolean
}

/** Un export d'un fichier, tel que projeté dans le snapshot. */
export interface ExportEntry {
  name: string
  kind?: string
  line?: number
  usageCount: number
  reExport?: boolean
  confidence?: string
  reason?: string
}

/** Un node fichier porteur d'exports. */
export interface FileExportNode {
  id: string
  exports: ExportEntry[]
}

/** Un export est "unused" (dead candidate) s'il n'est jamais utilisé ni ré-exporté. */
export function isUnusedExport(e: ExportEntry): boolean {
  return e.usageCount === 0 && !e.reExport
}

/** Totaux d'exports par niveau de confidence, sur l'ensemble des fichiers. */
export function countByConfidence(
  files: FileExportNode[],
): { safe: number; test: number; dynamic: number; local: number } {
  const conf = { safe: 0, test: 0, dynamic: 0, local: 0 }
  for (const n of files) {
    for (const e of n.exports) {
      if (e.confidence === 'safe-to-remove') conf.safe++
      else if (e.confidence === 'test-only') conf.test++
      else if (e.confidence === 'possibly-dynamic') conf.dynamic++
      else if (e.confidence === 'local-only') conf.local++
    }
  }
  return conf
}

/** Résout un node fichier par égalité, suffixe puis sous-chaîne (insensible casse). */
export function findExportFileNode(files: FileExportNode[], file: string): FileExportNode | undefined {
  const q = file.toLowerCase()
  return files.find((n) =>
    n.id.toLowerCase() === q || n.id.toLowerCase().endsWith(q) || n.id.toLowerCase().includes(q),
  )
}

export async function runExportsCommand(snapshotPath: string | undefined, opts: ExportsOpts): Promise<void> {
  const snapshot = await loadSnapshot(snapshotPath, opts)
  const filesWithExports = snapshot.nodes.filter(
    (n: any) => n.exports && n.exports.length > 0,
  ) as unknown as FileExportNode[]

  if (opts.file) {
    runSingleFileMode(filesWithExports, opts)
    return
  }

  const totalExports = filesWithExports.reduce((s, n) => s + n.exports.length, 0)

  if (opts.json) {
    const totalUnused = filesWithExports.reduce((s, n) => s + n.exports.filter(isUnusedExport).length, 0)
    printSummaryJson(filesWithExports, totalExports, totalUnused)
    return
  }
  printSummaryText(filesWithExports, totalExports)
}

interface RankedFile {
  file: string
  safe: number
  local: number
  test: number
  dynamic: number
  unused: number
  total: number
}

/** Classe les fichiers par nb de dead exports (safe d'abord, puis unused). */
function rankFilesByDeadExports(files: FileExportNode[]): RankedFile[] {
  return files
    .map((n) => ({
      file: n.id,
      safe: n.exports.filter((e) => e.confidence === 'safe-to-remove').length,
      local: n.exports.filter((e) => e.confidence === 'local-only').length,
      test: n.exports.filter((e) => e.confidence === 'test-only').length,
      dynamic: n.exports.filter((e) => e.confidence === 'possibly-dynamic').length,
      unused: n.exports.filter(isUnusedExport).length,
      total: n.exports.length,
    }))
    .filter((r) => r.unused > 0)
    .sort((a, b) => b.safe - a.safe || b.unused - a.unused)
}

/** Mode summary `--json` : ranking par unusedCount décroissant. */
function printSummaryJson(files: FileExportNode[], totalExports: number, totalUnused: number): void {
  const ranked = files
    .map((n) => ({
      file: n.id,
      totalExports: n.exports.length,
      unusedCount: n.exports.filter(isUnusedExport).length,
      unusedSymbols: n.exports.filter(isUnusedExport).map((e) => e.name),
    }))
    .filter((r) => r.unusedCount > 0)
    .sort((a, b) => b.unusedCount - a.unusedCount)
  console.log(JSON.stringify({ totalExports, totalUnused, files: ranked }, null, 2))
}

/** Mode summary texte : header, totaux par confidence, ranking. */
function printSummaryText(files: FileExportNode[], totalExports: number): void {
  const conf = countByConfidence(files)
  console.log(chalk.bold('\n  Dead Exports Report\n'))
  console.log(`  Total exports:  ${totalExports} across ${files.length} files`)
  console.log(`  ${chalk.red(String(conf.safe))} safe to remove · ${chalk.magenta(String(conf.local))} local-only · ${chalk.blue(String(conf.test))} test-only · ${chalk.yellow(String(conf.dynamic))} possibly dynamic`)
  console.log()
  for (const r of rankFilesByDeadExports(files)) {
    printRankedFileLine(r)
  }
  console.log()
}

function printRankedFileLine(r: RankedFile): void {
  const tags: string[] = []
  if (r.safe > 0) tags.push(chalk.red(`${r.safe} dead`))
  if (r.local > 0) tags.push(chalk.magenta(`${r.local} local`))
  if (r.test > 0) tags.push(chalk.blue(`${r.test} test`))
  if (r.dynamic > 0) tags.push(chalk.yellow(`${r.dynamic} dyn?`))
  console.log(`  ${String(r.unused).padStart(3)}/${r.total.toString().padStart(3)}  ${r.file}`)
  console.log(`         ${tags.join(' · ')}`)
}

const CONF_ICON: Record<string, string> = {
  'safe-to-remove': chalk.red('×'),
  'test-only': chalk.blue('⊤'),
  'possibly-dynamic': chalk.yellow('?'),
  'local-only': chalk.magenta('◐'),
  used: chalk.green('✓'),
}
const CONF_TAG: Record<string, string> = {
  'safe-to-remove': chalk.red('DEAD'),
  'test-only': chalk.blue('TEST'),
  'possibly-dynamic': chalk.yellow('DYN?'),
  'local-only': chalk.magenta('LOCAL'),
  used: chalk.green('USED'),
}

function runSingleFileMode(filesWithExports: FileExportNode[], opts: ExportsOpts): void {
  const node = findExportFileNode(filesWithExports, opts.file!)
  if (!node) {
    console.log(chalk.red(`  No file matching "${opts.file}" with export data.\n`))
    return
  }

  const nodeExports = node.exports || []
  const filteredExports = opts.all ? nodeExports : nodeExports.filter(isUnusedExport)

  if (opts.json) {
    console.log(JSON.stringify({ file: node.id, exports: filteredExports }, null, 2))
    return
  }

  const unused = nodeExports.filter(isUnusedExport).length
  console.log(chalk.bold(`\n  ${node.id}`))
  console.log(`  ${unused}/${nodeExports.length} unused exports\n`)
  for (const e of filteredExports) printExportEntry(e)
  console.log()
}

/** Une ligne de détail par export (icône + tag confidence + usage). */
function printExportEntry(e: ExportEntry): void {
  const c = e.confidence || (e.usageCount > 0 ? 'used' : 'safe-to-remove')
  const icon = CONF_ICON[c] || chalk.dim('?')
  const tag = (CONF_TAG[c] || '').padEnd(16)
  const name = c === 'used' ? chalk.dim(e.name) : chalk.yellow(e.name)
  const kind = chalk.dim(`[${e.kind}]`)
  const usage = e.usageCount === 0 ? chalk.red('×0') : chalk.dim(`×${e.usageCount}`)
  console.log(`    ${icon} ${tag} ${kind.padEnd(22)} ${name.padEnd(30)} ${usage}  L${e.line}`)
  if (e.reason) {
    console.log(chalk.dim(`                 ${e.reason}`))
  }
}
