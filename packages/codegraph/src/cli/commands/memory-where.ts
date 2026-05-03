/**
 * `codegraph memory where` — print memory store path for the project.
 *
 * Exemple PoC d'extraction (god-file split P2a) — la registration
 * `.command('where')` reste dans `cli/index.ts`, le handler est ici.
 */

import chalk from 'chalk'
import { memoryPathFor, memoryDir } from '../../memory/store.js'

export interface MemoryWhereOpts {
  root?: string
}

export function runMemoryWhere(opts: MemoryWhereOpts): void {
  const root = opts.root ?? process.cwd()
  console.log(memoryPathFor(root))
  console.log(chalk.dim(`  (memory dir: ${memoryDir()})`))
}
