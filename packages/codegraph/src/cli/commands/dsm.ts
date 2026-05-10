/**
 * `codegraph dsm` — render a Dependency Structure Matrix.
 *
 * Extrait du god-file `cli/index.ts` (P2b split).
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import { computeDsm } from '../../graph/dsm.js'
import { renderDsm, aggregateByContainer } from '../../map/dsm-renderer.js'
import { loadSnapshot } from '../_shared.js'

export interface DsmOpts {
  config?: string
  granularity: string
  depth: string
  edgeTypes: string
  json?: boolean
  output?: string
}

export async function runDsmCommand(
  snapshotPath: string | undefined,
  opts: DsmOpts,
): Promise<void> {
  const snapshot = await loadSnapshot(snapshotPath, opts)
  const edgeTypes = new Set(opts.edgeTypes.split(',').map((s) => s.trim()))

  const fileNodes = snapshot.nodes.filter((n) => n.type === 'file').map((n) => n.id)
  const rawEdges = snapshot.edges
    .filter((e) => edgeTypes.has(e.type))
    .map((e) => ({ from: e.from, to: e.to }))

  let nodes = fileNodes
  let edges = rawEdges
  if (opts.granularity === 'container') {
    const depth = parseInt(opts.depth, 10)
    const agg = aggregateByContainer(fileNodes, rawEdges, depth)
    nodes = agg.nodes
    edges = agg.edges
  }

  const dsm = computeDsm(nodes, edges)

  if (opts.json) {
    console.log(JSON.stringify(dsm, null, 2))
    return
  }

  const md = renderDsm(dsm, {
    title: `DSM — ${opts.granularity === 'container' ? `container (depth=${opts.depth})` : 'file-level'} · ${dsm.order.length} nodes · ${dsm.backEdges.length} back-edges`,
  })

  if (opts.output) {
    await fs.writeFile(opts.output, md)
    console.log(chalk.green(`✓ DSM written: ${opts.output}`))
    return
  }

  process.stdout.write(md)
}
