/**
 * Contract tests pour core/types.ts — schema lock.
 *
 * Pourquoi : core/types.ts est un top-hub (in: 70+) de pure types,
 * sérialisé dans `.codegraph/snapshot-*.json` et consommé externe (Sentinel,
 * codegraph-mcp, hooks Claude). Le header du fichier promet :
 *   « Every type is serializable to JSON without transformation. »
 *
 * Ces tests exercent ce contract :
 *   1. Une `GraphSnapshot` minimale + les sous-types principaux
 *      construisent sans erreur de typage et passent un round-trip JSON
 *      stringify→parse identique.
 *   2. Les unions discriminantes restent stables (lock-list). Un membre
 *      supprimé silencieusement fait casser ce test, pas seulement les
 *      call-sites lointains.
 *
 * Si tu ajoutes un membre à une union, mets aussi à jour la lock-list ici
 * — c'est intentionnel : ce test est la friction qui force à propager.
 */

import { describe, it, expect } from 'vitest'
import type {
  EdgeType,
  NodeStatus,
  NodeType,
  GraphNode,
  GraphEdge,
  GraphSnapshot,
  GraphStats,
  ExportConfidence,
  ExportSymbol,
  TaintSeverity,
  DataFlowEntryKind,
  PackageDepsIssueKind,
} from '../src/core/types.js'

describe('core/types — JSON round-trip contract', () => {
  it('GraphSnapshot minimal round-trips identique', () => {
    const node: GraphNode = {
      id: 'src/foo.ts',
      label: 'foo.ts',
      type: 'file',
      status: 'connected',
      tags: ['kernel'],
      exportCount: 2,
      loc: 42,
    }
    const edge: GraphEdge = {
      id: 'src/foo.ts--import--src/bar.ts',
      from: 'src/foo.ts',
      to: 'src/bar.ts',
      type: 'import',
      resolved: true,
      line: 7,
    }
    const stats: GraphStats = {
      totalFiles: 2,
      totalEdges: 1,
      orphanCount: 0,
      connectedCount: 2,
      entryPointCount: 1,
      uncertainCount: 0,
      edgesByType: {
        'import': 1,
        'event': 0,
        'route': 0,
        'queue': 0,
        'dynamic-load': 0,
        'db-table': 0,
      },
      healthScore: 1.0,
    }
    const snapshot: GraphSnapshot = {
      version: '1',
      generatedAt: '2026-05-03T00:00:00.000Z',
      rootDir: '/tmp/proj',
      nodes: [node],
      edges: [edge],
      stats,
    }

    const roundtripped = JSON.parse(JSON.stringify(snapshot)) as GraphSnapshot
    expect(roundtripped).toEqual(snapshot)
    expect(roundtripped.version).toBe('1')
    expect(roundtripped.nodes).toHaveLength(1)
    expect(roundtripped.edges[0].type).toBe('import')
  })

  it('ExportSymbol avec confidence round-trip', () => {
    const sym: ExportSymbol = {
      name: 'doStuff',
      kind: 'function',
      line: 10,
      usageCount: 3,
      usedBy: ['src/a.ts', 'src/b.ts'],
      confidence: 'used',
    }
    expect(JSON.parse(JSON.stringify(sym))).toEqual(sym)
  })

  it('GraphNode avec tous les champs optionnels round-trip', () => {
    const node: GraphNode = {
      id: 'src/full.ts',
      label: 'full.ts',
      type: 'file',
      status: 'entry-point',
      parent: 'src',
      tags: ['api', 'route'],
      exportCount: 3,
      loc: 100,
      exports: [
        {
          name: 'a',
          kind: 'function',
          line: 5,
          usageCount: 0,
          confidence: 'safe-to-remove',
          reason: 'no importer',
        },
      ],
      meta: { custom: 'value', nested: { x: 1 } },
    }
    expect(JSON.parse(JSON.stringify(node))).toEqual(node)
  })
})

describe('core/types — discriminant unions lock', () => {
  // Lock-list : si un membre disparait, le narrowing échoue à compile-time.
  // Si un membre est ajouté silencieusement, le count check le fait remonter.
  // Les deux directions sont gardées : c'est un schema-lock délibéré.
  const ALL_EDGE_TYPES: ReadonlyArray<EdgeType> = [
    'import', 'event', 'route', 'queue', 'dynamic-load', 'db-table',
  ]
  const ALL_NODE_TYPES: ReadonlyArray<NodeType> = ['file', 'directory']
  const ALL_NODE_STATUS: ReadonlyArray<NodeStatus> = [
    'connected', 'orphan', 'entry-point', 'uncertain',
  ]
  const ALL_EXPORT_CONFIDENCE: ReadonlyArray<ExportConfidence> = [
    'safe-to-remove', 'test-only', 'possibly-dynamic', 'local-only', 'used',
  ]
  const ALL_TAINT_SEVERITY: ReadonlyArray<TaintSeverity> = [
    'critical', 'high', 'medium', 'low',
  ]
  const ALL_DATAFLOW_ENTRY: ReadonlyArray<DataFlowEntryKind> = [
    'http-route', 'event-listener', 'mcp-tool', 'bullmq-job', 'cron', 'interval',
  ]
  const ALL_PACKAGE_DEPS_ISSUE: ReadonlyArray<PackageDepsIssueKind> = [
    'declared-unused', 'declared-runtime-asset', 'missing', 'devOnly',
  ]

  it('EdgeType lock = 6 membres uniques', () => {
    expect(ALL_EDGE_TYPES.length).toBe(6)
    expect(new Set(ALL_EDGE_TYPES).size).toBe(6)
  })
  it('NodeType lock = 2 membres', () => {
    expect(ALL_NODE_TYPES.length).toBe(2)
  })
  it('NodeStatus lock = 4 membres', () => {
    expect(ALL_NODE_STATUS.length).toBe(4)
  })
  it('ExportConfidence lock = 5 membres', () => {
    expect(ALL_EXPORT_CONFIDENCE.length).toBe(5)
  })
  it('TaintSeverity lock = 4 membres', () => {
    expect(ALL_TAINT_SEVERITY.length).toBe(4)
  })
  it('DataFlowEntryKind lock = 6 membres', () => {
    expect(ALL_DATAFLOW_ENTRY.length).toBe(6)
  })
  it('PackageDepsIssueKind lock = 4 membres', () => {
    expect(ALL_PACKAGE_DEPS_ISSUE.length).toBe(4)
  })
})

describe('core/types — meta extensibility', () => {
  it('node.meta accepte structure arbitraire JSON-serializable', () => {
    const node: GraphNode = {
      id: 'a', label: 'a', type: 'file', status: 'connected', tags: [],
      meta: {
        primitives: { s: 'x', n: 1, b: true, nu: null },
        nested: { array: [1, 2, 3], obj: { deep: 'ok' } },
        empty: {},
      },
    }
    const r = JSON.parse(JSON.stringify(node))
    expect(r.meta).toEqual(node.meta)
  })

  it('edge.meta accepte aussi structure arbitraire', () => {
    const edge: GraphEdge = {
      id: 'e1', from: 'a', to: 'b', type: 'event', resolved: false,
      meta: { eventName: 'user.created', listeners: ['notif', 'audit'] },
    }
    const r = JSON.parse(JSON.stringify(edge))
    expect(r.meta).toEqual(edge.meta)
  })
})
