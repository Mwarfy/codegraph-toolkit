/**
 * `codegraph map` — generate a structural map MAP.md from an existing snapshot.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { buildMap } from '../../map/builder.js'
import { loadConfig, loadSnapshot } from '../_shared.js'

export interface MapOpts {
  config?: string
  output?: string
  stdout?: boolean
  minIndegree: string
  maxModules: string
}

export async function runMapCommand(snapshotPath: string | undefined, opts: MapOpts): Promise<void> {
  const snapshot = await loadSnapshot(snapshotPath, opts)
  const config = await loadConfig(opts)
  const content = buildMap(snapshot, {
    minIndegree: parseInt(opts.minIndegree, 10),
    maxModulesInFiches: parseInt(opts.maxModules, 10),
    concerns: config.concerns,
  })

  if (opts.stdout) {
    process.stdout.write(content)
    return
  }
  const outPath = opts.output ?? path.join(config.rootDir, 'MAP.md')
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, content)
  const approxTokens = Math.round(content.length / 4)
  console.log(chalk.green(`✓ MAP.md written: ${outPath} (~${approxTokens} tokens, ${content.length} chars)`))
}
