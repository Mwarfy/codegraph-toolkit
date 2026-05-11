// ADR-028
/**
 * `codegraph compact` — supprime les facts orphelins du store
 * (cf. ADR-028). Manuelle ; l'auto-trigger vit dans analyze.ts.
 */

import chalk from 'chalk'
import { loadConfig } from '../_shared.js'
import {
  compactFactStore,
  shouldCompact,
  DEFAULT_COMPACTION_CONFIG,
} from '../../incremental/fact-store-compaction.js'

export interface CompactOpts {
  config?: string
  root?: string
  /** Compte les orphelins sans modifier le store. */
  dryRun?: boolean
}

export async function runCompactCommand(opts: CompactOpts): Promise<void> {
  const config = await loadConfig(opts)

  // Lit la config user (codegraph.config.json) si présente, sinon
  // utilise les defaults.
  const factStoreConfig = (config as unknown as {
    factStore?: { maxOrphanRatio?: number; maxSizeBytes?: number; keepBases?: number }
  }).factStore
  const cfg = {
    maxOrphanRatio: factStoreConfig?.maxOrphanRatio ?? DEFAULT_COMPACTION_CONFIG.maxOrphanRatio,
    maxSizeBytes: factStoreConfig?.maxSizeBytes ?? DEFAULT_COMPACTION_CONFIG.maxSizeBytes,
    keepBases: factStoreConfig?.keepBases ?? DEFAULT_COMPACTION_CONFIG.keepBases,
  }

  console.log(chalk.bold('\n🧹 CodeGraph — Compacting fact store...\n'))

  const stats = await shouldCompact(config.snapshotDir, cfg)
  if (!stats) {
    console.log(chalk.dim('  No fact store found. Nothing to compact.\n'))
    return
  }

  const sizeMb = (stats.sizeBytes / 1024 / 1024).toFixed(1)
  const orphanPct = stats.total > 0 ? ((stats.orphans / stats.total) * 100).toFixed(1) : '0'
  console.log(`  Store:     ${stats.total} facts (${sizeMb} MB)`)
  console.log(`  Orphans:   ${stats.orphans} (${orphanPct}%)`)
  console.log(`  Keep bases: ${cfg.keepBases} LRU`)
  console.log()

  const result = await compactFactStore(config.snapshotDir, cfg, { dryRun: opts.dryRun })

  const freedMb = (result.freedBytes / 1024 / 1024).toFixed(1)
  const ms = result.durationMs.toFixed(0)
  if (result.dryRun) {
    console.log(chalk.yellow(`  Dry-run : would remove ${result.removed} facts, keep ${result.kept} (${ms}ms)`))
    if (result.basesPruned > 0) {
      console.log(chalk.yellow(`  Dry-run : would prune ${result.basesPruned} base(s) beyond keepBases=${cfg.keepBases}`))
    }
  } else {
    console.log(chalk.green(`  ✓ Removed ${result.removed} facts, kept ${result.kept} (freed ${freedMb} MB, ${ms}ms)`))
    if (result.basesPruned > 0) {
      console.log(chalk.green(`  ✓ Pruned ${result.basesPruned} base(s) beyond keepBases=${cfg.keepBases}`))
    }
  }
  console.log()
}
