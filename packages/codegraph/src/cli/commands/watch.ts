/**
 * `codegraph watch` — watch filesystem and recompute snapshot incrementally.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import { CodeGraphWatcher } from '../../incremental/watcher.js'
import { loadConfig } from '../_shared.js'

export interface WatchOpts {
  config?: string
  root?: string
  debounce: string
}

export async function runWatchCommand(opts: WatchOpts): Promise<void> {
  const config = await loadConfig(opts)
  const debounceMs = parseInt(opts.debounce, 10)

  console.log(chalk.bold('\n👁  CodeGraph — Watching\n'))
  console.log(`  Root:     ${config.rootDir}`)
  console.log(`  Include:  ${config.include.join(', ')}`)
  console.log(`  Debounce: ${debounceMs}ms`)
  console.log(chalk.dim('  (Ctrl+C to stop)\n'))

  const watcher = new CodeGraphWatcher(config, {
    debounceMs,
    onUpdate: ({ changedFiles, durationMs }) => {
      const filesPart = changedFiles.length === 0
        ? chalk.dim('initial')
        : changedFiles.length === 1
          ? changedFiles[0]
          : `${changedFiles[0]} (+${changedFiles.length - 1} more)`
      const ms = durationMs.toFixed(0)
      const msColor = durationMs < 100 ? chalk.green : durationMs < 1000 ? chalk.yellow : chalk.red
      console.log(`  ${chalk.cyan('•')} ${filesPart} ${msColor(`${ms}ms`)}`)
    },
    onError: (err) => {
      console.error(chalk.red(`  ✗ recompute failed: ${err}`))
    },
  })

  process.on('SIGINT', () => {
    console.log(chalk.dim('\n  Stopping... (saving cache)'))
    void watcher.stop().then(() => process.exit(0))
  })

  await watcher.start()
  // Bloque le process en idle (les fs.watch handlers gardent l'event loop alive)
  await new Promise(() => {})
}
