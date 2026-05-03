// ADR-007
/**
 * Incremental module-metrics + component-metrics.
 *
 * Les deux fonctions de calcul sont pure (pas d'AST, juste graph
 * algorithms sur nodes+edges). Le wrap Salsa apporte un cache hit
 * éventuel sur des runs successifs si nodes/edges sont Object.is
 * égales.
 *
 * En pratique, les nodes/edges sont reconstruits à chaque run par
 * analyze(), donc l'invalidation est totale. Le wrap reste utile pour
 * la cohérence d'API (tout passe par Salsa quand `incremental: true`).
 *
 * Optimisation future possible : split nodes/edges en inputs
 * granulaires pour cache hit fin.
 */

import { derived, input } from '@liby-tools/salsa'
import { computeModuleMetrics } from '../metrics/module-metrics.js'
import { computeComponentMetrics } from '../metrics/component-metrics.js'
import type { GraphNode, GraphEdge, ModuleMetrics, ComponentMetrics } from '../core/types.js'
import { sharedDb as db } from './database.js'

export const graphNodesInput = input<string, readonly GraphNode[]>(db, 'graphNodesForMetrics')
export const graphEdgesForMetricsInput = input<string, readonly GraphEdge[]>(db, 'graphEdgesForMetrics')

export const allModuleMetrics = derived<string, ModuleMetrics[]>(
  db, 'allModuleMetrics',
  (label) => {
    if (!graphNodesInput.has(label) || !graphEdgesForMetricsInput.has(label)) return []
    const nodes = graphNodesInput.get(label) as GraphNode[]
    const edges = graphEdgesForMetricsInput.get(label) as GraphEdge[]
    return computeModuleMetrics(nodes, edges)
  },
)

export const allComponentMetrics = derived<string, ComponentMetrics[]>(
  db, 'allComponentMetrics',
  (label) => {
    if (!graphNodesInput.has(label) || !graphEdgesForMetricsInput.has(label)) return []
    const nodes = graphNodesInput.get(label) as GraphNode[]
    const edges = graphEdgesForMetricsInput.get(label) as GraphEdge[]
    return computeComponentMetrics(nodes, edges)
  },
)
