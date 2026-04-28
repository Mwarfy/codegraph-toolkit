/**
 * CodeGraph Engine
 *
 * Wraps graphology to provide a typed, multi-layer graph
 * with orphan detection, snapshot generation, and diff.
 *
 * The graph is the central data structure:
 * - Nodes are files and directories
 * - Edges are typed links (import, event, route, queue, etc.)
 * - Orphan detection runs after all detectors complete
 * - Snapshots are serializable JSON for storage and viewer consumption
 */

import Graph from 'graphology'
import { type GraphNode, type GraphEdge, type GraphSnapshot, type GraphStats,
         type EdgeType, type NodeStatus, type SnapshotDiff, type ExportSymbol } from './types.js'
import { minimatch } from 'minimatch'
import { execSync } from 'node:child_process'
import * as path from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGraph = any

export class CodeGraph {
  private graph: AnyGraph
  private rootDir: string
  private entryPointPatterns: string[]

  constructor(rootDir: string, entryPointPatterns: string[] = []) {
    // graphology's default export varies by bundler — handle both shapes
    const GraphCtor = (Graph as any).default || Graph
    this.graph = new GraphCtor({ multi: true, type: 'directed' })
    this.rootDir = rootDir
    this.entryPointPatterns = entryPointPatterns
  }

  // ─── Node Management ────────────────────────────────────────────────

  addFileNode(relativePath: string, attrs?: Partial<GraphNode>): void {
    const id = this.normalizePath(relativePath)
    if (this.graph.hasNode(id)) return

    // Auto-create parent directory nodes
    const dir = path.dirname(id)
    if (dir && dir !== '.') {
      this.ensureDirectoryChain(dir)
    }

    this.graph.addNode(id, {
      id,
      label: path.basename(id),
      type: 'file',
      status: 'connected', // default, will be recomputed
      parent: dir !== '.' ? dir : undefined,
      tags: this.inferTags(id),
      ...attrs,
    } satisfies GraphNode)
  }

  private ensureDirectoryChain(dirPath: string): void {
    if (this.graph.hasNode(dirPath)) return

    const parent = path.dirname(dirPath)
    if (parent && parent !== '.' && parent !== dirPath) {
      this.ensureDirectoryChain(parent)
    }

    this.graph.addNode(dirPath, {
      id: dirPath,
      label: path.basename(dirPath),
      type: 'directory',
      status: 'connected',
      parent: parent !== '.' && parent !== dirPath ? parent : undefined,
      tags: [],
    } satisfies GraphNode)
  }

  // ─── Edge Management ────────────────────────────────────────────────

  addEdge(from: string, to: string, type: EdgeType, attrs?: Partial<GraphEdge>): void {
    const fromId = this.normalizePath(from)
    const toId = this.normalizePath(to)
    const edgeId = `${fromId}--${type}--${toId}${attrs?.label ? `--${attrs.label}` : ''}`

    // Ensure both nodes exist
    if (!this.graph.hasNode(fromId)) this.addFileNode(fromId)
    if (!this.graph.hasNode(toId)) this.addFileNode(toId)

    // Don't add duplicate edges
    if (this.graph.hasEdge(edgeId)) return

    this.graph.addEdgeWithKey(edgeId, fromId, toId, {
      id: edgeId,
      from: fromId,
      to: toId,
      type,
      resolved: true,
      ...attrs,
    } satisfies GraphEdge)
  }

  // ─── Orphan Detection ───────────────────────────────────────────────

  /**
   * Recompute the status of every file node.
   * Must be called after all detectors have run.
   */
  computeOrphanStatus(): void {
    const fileNodes = this.getFileNodes()

    for (const node of fileNodes) {
      const id = node.id
      const inDegree = this.graph.inDegree(id)

      if (this.isEntryPoint(id)) {
        this.graph.setNodeAttribute(id, 'status', 'entry-point' satisfies NodeStatus)
      } else if (inDegree === 0) {
        this.graph.setNodeAttribute(id, 'status', 'orphan' satisfies NodeStatus)
      } else if (this.hasOnlyUncertainEdges(id)) {
        this.graph.setNodeAttribute(id, 'status', 'uncertain' satisfies NodeStatus)
      } else {
        this.graph.setNodeAttribute(id, 'status', 'connected' satisfies NodeStatus)
      }
    }
  }

  private isEntryPoint(nodeId: string): boolean {
    return this.entryPointPatterns.some(pattern => minimatch(nodeId, pattern))
  }

  private hasOnlyUncertainEdges(nodeId: string): boolean {
    let hasIncoming = false
    let allUnresolved = true

    this.graph.forEachInEdge(nodeId, (_edge: any, attrs: any) => {
      hasIncoming = true
      if ((attrs as GraphEdge).resolved) {
        allUnresolved = false
      }
    })

    return hasIncoming && allUnresolved
  }

  // ─── Snapshot Generation ────────────────────────────────────────────

  toSnapshot(): GraphSnapshot {
    const nodes = this.getAllNodes()
    const edges = this.getAllEdges()
    const stats = this.computeStats(nodes, edges)
    const gitInfo = this.getGitInfo()

    return {
      version: '1',
      generatedAt: new Date().toISOString(),
      commitHash: gitInfo.hash,
      commitMessage: gitInfo.message,
      rootDir: this.rootDir,
      nodes,
      edges,
      stats,
    }
  }

  private computeStats(nodes: GraphNode[], edges: GraphEdge[]): GraphStats {
    const fileNodes = nodes.filter(n => n.type === 'file')
    const orphans = fileNodes.filter(n => n.status === 'orphan')
    const connected = fileNodes.filter(n => n.status === 'connected')
    const entryPoints = fileNodes.filter(n => n.status === 'entry-point')
    const uncertain = fileNodes.filter(n => n.status === 'uncertain')

    const edgesByType: Record<EdgeType, number> = {
      'import': 0, 'event': 0, 'route': 0,
      'queue': 0, 'dynamic-load': 0, 'db-table': 0,
    }
    for (const e of edges) {
      edgesByType[e.type] = (edgesByType[e.type] || 0) + 1
    }

    const denominator = fileNodes.length - entryPoints.length
    const healthScore = denominator > 0
      ? Math.round((connected.length / denominator) * 100) / 100
      : 1

    return {
      totalFiles: fileNodes.length,
      totalEdges: edges.length,
      orphanCount: orphans.length,
      connectedCount: connected.length,
      entryPointCount: entryPoints.length,
      uncertainCount: uncertain.length,
      edgesByType,
      healthScore,
    }
  }

  // ─── Diff ───────────────────────────────────────────────────────────

  static diff(before: GraphSnapshot, after: GraphSnapshot): SnapshotDiff {
    const beforeNodeIds = new Set(before.nodes.filter(n => n.type === 'file').map(n => n.id))
    const afterNodeIds = new Set(after.nodes.filter(n => n.type === 'file').map(n => n.id))
    const beforeEdgeIds = new Set(before.edges.map(e => e.id))
    const afterEdgeIds = new Set(after.edges.map(e => e.id))

    const addedNodes = after.nodes.filter(n => n.type === 'file' && !beforeNodeIds.has(n.id))
    const removedNodes = before.nodes.filter(n => n.type === 'file' && !afterNodeIds.has(n.id))
    const addedEdges = after.edges.filter(e => !beforeEdgeIds.has(e.id))
    const removedEdges = before.edges.filter(e => !afterEdgeIds.has(e.id))

    // Find nodes whose status changed
    const beforeStatusMap = new Map(before.nodes.map(n => [n.id, n.status]))
    const afterStatusMap = new Map(after.nodes.map(n => [n.id, n.status]))

    const modifiedNodes: SnapshotDiff['modifiedNodes'] = []
    const newOrphans: string[] = []
    const resolvedOrphans: string[] = []

    for (const node of after.nodes) {
      if (node.type !== 'file') continue
      const prevStatus = beforeStatusMap.get(node.id)
      if (prevStatus && prevStatus !== node.status) {
        modifiedNodes.push({
          id: node.id,
          before: { status: prevStatus },
          after: { status: node.status },
        })
        if (node.status === 'orphan' && prevStatus !== 'orphan') {
          newOrphans.push(node.id)
        }
        if (prevStatus === 'orphan' && node.status !== 'orphan') {
          resolvedOrphans.push(node.id)
        }
      }
    }

    return {
      fromCommit: before.commitHash,
      toCommit: after.commitHash,
      generatedAt: new Date().toISOString(),
      addedNodes,
      removedNodes,
      modifiedNodes,
      addedEdges,
      removedEdges,
      newOrphans,
      resolvedOrphans,
      summary: {
        addedFiles: addedNodes.length,
        removedFiles: removedNodes.length,
        addedEdges: addedEdges.length,
        removedEdges: removedEdges.length,
        newOrphanCount: newOrphans.length,
        resolvedOrphanCount: resolvedOrphans.length,
        healthBefore: before.stats.healthScore,
        healthAfter: after.stats.healthScore,
      },
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private getAllNodes(): GraphNode[] {
    const nodes: GraphNode[] = []
    this.graph.forEachNode((_key: any, attrs: any) => {
      nodes.push(attrs as GraphNode)
    })
    return nodes
  }

  /**
   * Retourne tous les edges du graphe sous forme de GraphEdge. Public pour
   * que les extracteurs structurels (cycles, data-flows) puissent consommer
   * le graphe déjà résolu plutôt que re-parcourir les détecteurs.
   */
  getAllEdges(): GraphEdge[] {
    const edges: GraphEdge[] = []
    this.graph.forEachEdge((_key: any, attrs: any) => {
      edges.push(attrs as GraphEdge)
    })
    return edges
  }

  getFileNodes(): GraphNode[] {
    return this.getAllNodes().filter(n => n.type === 'file')
  }

  getOrphans(): GraphNode[] {
    return this.getFileNodes().filter(n => n.status === 'orphan')
  }

  setNodeExports(id: string, exports: ExportSymbol[], exportCount: number): void {
    const normalized = this.normalizePath(id)
    if (!this.graph.hasNode(normalized)) return
    this.graph.setNodeAttribute(normalized, 'exports', exports)
    this.graph.setNodeAttribute(normalized, 'exportCount', exportCount)
  }

  /**
   * Merge d'un objet arbitraire dans node.meta. Utilisé par les détecteurs
   * qui enrichissent un fichier avec des stats (complexity, etc.) sans
   * nécessiter un champ dédié sur GraphNode.
   */
  setNodeMeta(id: string, patch: Record<string, unknown>): void {
    const normalized = this.normalizePath(id)
    if (!this.graph.hasNode(normalized)) return
    const current = (this.graph.getNodeAttribute(normalized, 'meta') as Record<string, unknown> | undefined) || {}
    this.graph.setNodeAttribute(normalized, 'meta', { ...current, ...patch })
  }

  getNodeById(id: string): GraphNode | undefined {
    const normalized = this.normalizePath(id)
    if (!this.graph.hasNode(normalized)) return undefined
    return this.graph.getNodeAttributes(normalized) as GraphNode
  }

  getIncomingEdges(nodeId: string): GraphEdge[] {
    const normalized = this.normalizePath(nodeId)
    if (!this.graph.hasNode(normalized)) return []
    const edges: GraphEdge[] = []
    this.graph.forEachInEdge(normalized, (_key: any, attrs: any) => {
      edges.push(attrs as GraphEdge)
    })
    return edges
  }

  getOutgoingEdges(nodeId: string): GraphEdge[] {
    const normalized = this.normalizePath(nodeId)
    if (!this.graph.hasNode(normalized)) return []
    const edges: GraphEdge[] = []
    this.graph.forEachOutEdge(normalized, (_key: any, attrs: any) => {
      edges.push(attrs as GraphEdge)
    })
    return edges
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '')
  }

  private inferTags(filePath: string): string[] {
    const tags: string[] = []
    const parts = filePath.split('/')

    if (parts.includes('kernel')) tags.push('kernel')
    if (parts.includes('api') || parts.includes('routes')) tags.push('api')
    if (parts.includes('blocks')) tags.push('block')
    if (parts.includes('enrichment')) tags.push('enrichment')
    if (parts.includes('healer')) tags.push('healer')
    if (parts.includes('shared')) tags.push('shared')
    if (parts.includes('db')) tags.push('db')
    if (parts.includes('app')) tags.push('page')
    if (parts.includes('components')) tags.push('component')
    if (parts.includes('hooks')) tags.push('hook')
    if (parts.includes('lib')) tags.push('lib')

    if (filePath.endsWith('.test.ts') || filePath.endsWith('.spec.ts')) tags.push('test')

    return tags
  }

  private getGitInfo(): { hash?: string; message?: string } {
    try {
      const hash = execSync('git rev-parse --short HEAD', {
        cwd: this.rootDir, encoding: 'utf-8'
      }).trim()
      const message = execSync('git log -1 --pretty=%s', {
        cwd: this.rootDir, encoding: 'utf-8'
      }).trim()
      return { hash, message }
    } catch {
      return {}
    }
  }
}
