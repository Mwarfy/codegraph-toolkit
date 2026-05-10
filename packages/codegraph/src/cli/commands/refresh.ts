// ADR-027
/**
 * `codegraph refresh` — rafraîchit `.codegraph/snapshot.json` via le
 * chemin warm Salsa (incrémental). Phase 2 d'ADR-027.
 *
 * Invoqué par les hooks `post-checkout` / `post-merge` après chaque
 * changement de HEAD. Aussi appelable manuellement.
 *
 * Stratégie :
 *   - `--check` : compute `inputHash` courant et compare au sidecar
 *                 meta. Exit 0 si frais, 1 si stale. Pas d'écriture.
 *   - (default) : run `analyze({ incremental: true })`, écrit le
 *                 nouveau `snapshot.json` v2 + meta.
 *
 * Skip volontairement les dérivés lourds (`synopsis-level3-*.md`,
 * `MAP.md`, facts Datalog) pour rester sub-secondes warm. Ces dérivés
 * restent générés par `analyze` classique au post-commit.
 */

import chalk from 'chalk'
import { analyze } from '../../core/analyzer.js'
import { discoverFiles } from '../../core/file-discovery.js'
import { loadConfig } from '../_shared.js'
import { computeInputHash } from '../../incremental/input-hash.js'
import {
  readSnapshotMeta,
  writeStoredSnapshot,
  type SnapshotMeta,
  SNAPSHOT_VERSION,
} from '../../incremental/snapshot-store.js'

export interface RefreshOpts {
  config?: string
  root?: string
  /** Compute hash + compare, exit 1 if stale. Pas d'écriture. */
  check?: boolean
  /** Suppress non-error output. */
  quiet?: boolean
}

export async function runRefreshCommand(opts: RefreshOpts): Promise<void> {
  const config = await loadConfig(opts)
  const tStart = performance.now()

  // Compute le inputHash actuel (sources + config + tooling).
  const files = await discoverFiles(config.rootDir, config.include, config.exclude)
  const { hash: currentHash, ctx } = await computeInputHash(config, files)

  const existingMeta = await readSnapshotMeta(config.snapshotDir)
  const isFresh = existingMeta?.inputHash === currentHash

  if (opts.check) {
    const ms = (performance.now() - tStart).toFixed(0)
    if (isFresh) {
      if (!opts.quiet) {
        console.log(chalk.green(`  ✓ snapshot fresh (${currentHash.slice(0, 12)}…, ${ms}ms)`))
      }
      process.exit(0)
    }
    if (!opts.quiet) {
      console.log(chalk.yellow(`  ⚠ snapshot stale (${ms}ms) — run 'codegraph refresh'`))
    }
    process.exit(1)
  }

  if (isFresh) {
    const ms = (performance.now() - tStart).toFixed(0)
    if (!opts.quiet) {
      console.log(chalk.green(`  ✓ snapshot already fresh (${currentHash.slice(0, 12)}…, ${ms}ms)`))
    }
    return
  }

  // Stale → run warm path. Salsa charge sa baseline + deltas et
  // ne ré-analyse que les cells invalidées.
  if (!opts.quiet) {
    console.log(chalk.cyan(`  ⓘ refreshing snapshot (${files.length} files)…`))
  }

  const { snapshot } = await analyze(config, {
    incremental: true,
    preDiscoveredFiles: files,
  })

  const meta: SnapshotMeta = {
    version: SNAPSHOT_VERSION,
    inputHash: currentHash,
    generatedAt: snapshot.generatedAt,
    baseSha: snapshot.commitHash,
    fileCount: ctx.fileCount,
    toolingVersion: ctx.toolingVersion,
  }
  await writeStoredSnapshot(config.snapshotDir, meta, snapshot)

  const ms = (performance.now() - tStart).toFixed(0)
  if (!opts.quiet) {
    console.log(chalk.green(`  ✓ snapshot refreshed (${ms}ms)`))
  }
}
