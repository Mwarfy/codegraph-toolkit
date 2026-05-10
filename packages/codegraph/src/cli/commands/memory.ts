/**
 * `codegraph memory` sub-commands — false-positives, decisions, incident
 * fingerprints stored across sessions.
 *
 * Extrait du god-file `cli/index.ts` (P2b split). La registration des
 * sous-commandes reste dans `index.ts`, les handlers sont ici.
 */

import chalk from 'chalk'
import {
  loadMemoryRaw, addEntry, markObsolete, deleteEntry, recall,
  memoryPathFor,
} from '../../memory/store.js'

interface RootOpt { root?: string }

export interface MemoryListOpts extends RootOpt {
  kind?: string
  file?: string
  includeObsolete?: boolean
  json?: boolean
}

export async function runMemoryList(opts: MemoryListOpts): Promise<void> {
  const root = opts.root ?? process.cwd()
  const entries = await recall(root, {
    kind: opts.kind as any,
    file: opts.file,
    includeObsolete: opts.includeObsolete,
  })
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2))
    return
  }
  console.log(chalk.bold(`\n  Memory — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`))
  console.log(chalk.dim(`  Store: ${memoryPathFor(root)}\n`))
  if (entries.length === 0) {
    console.log(chalk.dim('  (empty)\n'))
    return
  }
  for (const e of entries) {
    const obsoleteTag = e.obsoleteAt ? chalk.yellow(' [OBSOLETE]') : ''
    console.log(`  ${chalk.cyan('[' + e.kind + ']')} ${chalk.bold(e.fingerprint)}${obsoleteTag}`)
    console.log(`    ${e.reason}`)
    if (e.scope) {
      const bits: string[] = []
      if (e.scope.file) bits.push(`file=${e.scope.file}`)
      if (e.scope.detector) bits.push(`detector=${e.scope.detector}`)
      if (e.scope.tags && e.scope.tags.length > 0) bits.push(`tags=${e.scope.tags.join(',')}`)
      if (bits.length > 0) console.log(chalk.dim(`    scope: ${bits.join(', ')}`))
    }
    console.log(chalk.dim(`    id: ${e.id}  ·  added: ${e.addedAt.slice(0, 10)}`))
    console.log()
  }
}

export interface MemoryMarkOpts extends RootOpt {
  scopeFile?: string
  scopeDetector?: string
  scopeTags?: string
}

export async function runMemoryMark(
  kind: string,
  fingerprint: string,
  reason: string,
  opts: MemoryMarkOpts,
): Promise<void> {
  if (!['false-positive', 'decision', 'incident'].includes(kind)) {
    console.error(chalk.red(`Invalid kind: ${kind}. Must be one of: false-positive, decision, incident`))
    process.exit(1)
  }
  const root = opts.root ?? process.cwd()
  const scope = (opts.scopeFile || opts.scopeDetector || opts.scopeTags)
    ? {
        file: opts.scopeFile,
        detector: opts.scopeDetector,
        tags: opts.scopeTags ? String(opts.scopeTags).split(',') : undefined,
      }
    : undefined
  const e = await addEntry(root, { kind: kind as any, fingerprint, reason, scope })
  console.log(chalk.green('  ✓ saved'))
  console.log(chalk.dim(`    id: ${e.id}  ·  ${memoryPathFor(root)}`))
}

export async function runMemoryObsolete(id: string, opts: RootOpt): Promise<void> {
  const root = opts.root ?? process.cwd()
  const ok = await markObsolete(root, id)
  if (!ok) {
    console.error(chalk.red(`No entry found with id: ${id}`))
    process.exit(1)
  }
  console.log(chalk.yellow('  ✓ obsoleted'))
}

export async function runMemoryDelete(id: string, opts: RootOpt): Promise<void> {
  const root = opts.root ?? process.cwd()
  const ok = await deleteEntry(root, id)
  if (!ok) {
    console.error(chalk.red(`No entry found with id: ${id}`))
    process.exit(1)
  }
  console.log(chalk.green('  ✓ deleted'))
}

export async function runMemoryPrune(opts: RootOpt): Promise<void> {
  const root = opts.root ?? process.cwd()
  const store = await loadMemoryRaw(root)
  const obsoleteIds = store.entries.filter((e) => e.obsoleteAt !== null).map((e) => e.id)
  if (obsoleteIds.length === 0) {
    console.log(chalk.dim('  No obsolete entries to prune.'))
    return
  }
  // Delete N obsolete entries en parallèle (mutations file-store indépendantes).
  await Promise.all(obsoleteIds.map((id) => deleteEntry(root, id)))
  console.log(chalk.green(`  ✓ pruned ${obsoleteIds.length} obsolete entr${obsoleteIds.length === 1 ? 'y' : 'ies'}`))
}

export async function runMemoryExport(opts: RootOpt): Promise<void> {
  const root = opts.root ?? process.cwd()
  const store = await loadMemoryRaw(root)
  console.log(JSON.stringify(store, null, 2))
}
