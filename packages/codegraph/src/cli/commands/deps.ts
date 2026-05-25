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
import type { BarrelInfo, PackageDepsIssue, PackageDepsIssueKind } from '../../core/types.js'

export interface DepsOpts {
  config?: string
  json?: boolean
  only?: string
}

/** Kinds affichés dans le détail texte, dans l'ordre de gravité décroissante. */
const RENDERED_KINDS = ['missing', 'devOnly', 'declared-unused'] as const
type RenderedKind = (typeof RENDERED_KINDS)[number]

export async function runDepsCommand(snapshotPath: string | undefined, opts: DepsOpts): Promise<void> {
  const snapshot = await loadSnapshot(snapshotPath, opts)
  const issues = snapshot.packageDeps ?? []
  const barrels = snapshot.barrels ?? []

  const filtered = opts.only ? issues.filter((i) => i.kind === opts.only) : issues
  const lowValueBarrels = barrels.filter((b) => b.lowValue)

  if (opts.json) {
    console.log(JSON.stringify({
      issues: filtered,
      barrels: { total: barrels.length, lowValue: lowValueBarrels },
    }, null, 2))
    process.exit(hasMissing(filtered) ? 1 : 0)
  }

  console.log(chalk.bold('\n  Package Deps Hygiene\n'))
  printDepsIssues(filtered, issues.length)
  printBarrelsSummary(barrels, lowValueBarrels)
  process.exit(hasMissing(filtered) ? 1 : 0)
}

function hasMissing(issues: PackageDepsIssue[]): boolean {
  return issues.some((i) => i.kind === 'missing')
}

/** Compte les issues par kind ; tous les kinds sont présents (zéro si absent). */
export function countIssuesByKind(issues: PackageDepsIssue[]): Record<PackageDepsIssueKind, number> {
  const counts: Record<PackageDepsIssueKind, number> = {
    'declared-unused': 0,
    'declared-runtime-asset': 0,
    missing: 0,
    devOnly: 0,
  }
  for (const i of issues) counts[i.kind]++
  return counts
}

/** Groupe les issues par `package.json` de rattachement (ordre d'insertion). */
export function groupIssuesByManifest(issues: PackageDepsIssue[]): Map<string, PackageDepsIssue[]> {
  const byManifest = new Map<string, PackageDepsIssue[]>()
  for (const i of issues) {
    const list = byManifest.get(i.packageJson) ?? []
    list.push(i)
    byManifest.set(i.packageJson, list)
  }
  return byManifest
}

/** Section "issues" : message vide si aucune issue, sinon counts + détail par manifest. */
function printDepsIssues(filtered: PackageDepsIssue[], totalIssues: number): void {
  if (totalIssues === 0) {
    console.log(chalk.green('  ✓ No deps issues.\n'))
    return
  }
  const counts = countIssuesByKind(filtered)
  console.log(`  ${chalk.red(String(counts.missing))} missing · ${chalk.yellow(String(counts['declared-unused']))} declared-unused · ${chalk.magenta(String(counts['declared-runtime-asset']))} runtime-asset · ${chalk.blue(String(counts.devOnly))} devOnly`)
  console.log()
  for (const [manifest, list] of [...groupIssuesByManifest(filtered)].sort()) {
    printManifestGroup(manifest, list)
  }
}

/** Détail d'un manifest : issues groupées par kind, dans l'ordre RENDERED_KINDS. */
function printManifestGroup(manifest: string, list: PackageDepsIssue[]): void {
  console.log(chalk.bold(`  ${manifest}`) + chalk.dim(`  (${list.length})`))
  const byKind = groupIssuesByManifestKind(list)
  for (const kind of RENDERED_KINDS) {
    const group = byKind.get(kind)
    if (!group || group.length === 0) continue
    for (const i of group) printIssueLine(kind, i)
  }
  console.log()
}

function groupIssuesByManifestKind(list: PackageDepsIssue[]): Map<string, PackageDepsIssue[]> {
  const byKind = new Map<string, PackageDepsIssue[]>()
  for (const i of list) {
    const arr = byKind.get(i.kind) ?? []
    arr.push(i)
    byKind.set(i.kind, arr)
  }
  return byKind
}

/** Une ligne d'issue + ses importers (cap 3). */
function printIssueLine(kind: RenderedKind, i: PackageDepsIssue): void {
  const icon = kind === 'missing' ? chalk.red('✗')
             : kind === 'devOnly' ? chalk.blue('◐')
             : chalk.yellow('–')
  const loc = i.declaredIn ? chalk.dim(` [${i.declaredIn}]`) : ''
  console.log(`    ${icon} ${kind.padEnd(16)} ${i.packageName}${loc}`)
  if (i.importers.length > 0 && i.importers.length <= 3) {
    console.log(chalk.dim(`        ${i.importers.join(', ')}`))
  } else if (i.importers.length > 3) {
    console.log(chalk.dim(`        ${i.importers.slice(0, 3).join(', ')} … +${i.importers.length - 3}`))
  }
}

/** Section "barrels" : total + liste des low-value (< 2 consumers). */
function printBarrelsSummary(barrels: BarrelInfo[], lowValueBarrels: BarrelInfo[]): void {
  console.log(chalk.bold(`  Barrels\n`))
  if (barrels.length === 0) {
    console.log(chalk.dim('  No barrel files detected.\n'))
    return
  }
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
