/**
 * Tests pour les 7 extractors cross-discipline.
 *
 * Smoke tests : chaque extractor doit produire un output deterministe
 * sur des inputs simples + handle correctement les edge cases (graphe
 * vide, etc.).
 *
 * Tests fonctionnels approfondis (vrais positifs vs faux positifs sur
 * fixtures realistes) seraient en suite — pour cette session on assure
 * juste que les fonctions ne crashent pas + produisent les bonnes
 * shapes.
 */

import { describe, it, expect } from 'vitest'
import { computeSpectralMetrics } from '../src/extractors/spectral-graph.js'
import { computeSymbolEntropy } from '../src/extractors/symbol-entropy.js'
import { detectSignatureDuplicates } from '../src/extractors/signature-duplication.js'
import { computeLyapunovMetrics } from '../src/extractors/lyapunov-cochange.js'
import { computePackageMinCuts } from '../src/extractors/package-mincut.js'
import { computeInformationBottleneck } from '../src/extractors/information-bottleneck.js'
import type { GraphNode, GraphEdge, SymbolRefEdge, TypedSignature } from '../src/core/types.js'
import type { CoChangePair } from '../src/extractors/co-change.js'

describe('spectral-graph (Fiedler λ₂)', () => {
  it('returns empty for graph with <3 nodes per scope', () => {
    const nodes: GraphNode[] = [
      { id: 'a/b', type: 'file', label: 'a/b' },
      { id: 'a/c', type: 'file', label: 'a/c' },
    ]
    const result = computeSpectralMetrics(nodes, [])
    expect(result).toEqual([])
  })

  it('computes λ₂ on a small connected graph', () => {
    // scopeOf prend les 3 premiers segments — il faut donc 4 segments
    // dans le path pour que tous les fichiers tombent dans le même scope.
    const nodes: GraphNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `pkg/sub/inner/file${i}.ts`,
      type: 'file' as const,
      label: `file${i}`,
    }))
    // Linear chain : 0→1→2→3→4
    const edges: GraphEdge[] = [
      { id: '1', from: 'pkg/sub/inner/file0.ts', to: 'pkg/sub/inner/file1.ts', type: 'import', resolved: true },
      { id: '2', from: 'pkg/sub/inner/file1.ts', to: 'pkg/sub/inner/file2.ts', type: 'import', resolved: true },
      { id: '3', from: 'pkg/sub/inner/file2.ts', to: 'pkg/sub/inner/file3.ts', type: 'import', resolved: true },
      { id: '4', from: 'pkg/sub/inner/file3.ts', to: 'pkg/sub/inner/file4.ts', type: 'import', resolved: true },
    ]
    const result = computeSpectralMetrics(nodes, edges)
    expect(result.length).toBe(1)
    expect(result[0].nodeCount).toBe(5)
    expect(result[0].edgeCount).toBe(4)
    // λ₂ d'une chaine lineaire : strictement positif (graphe connecté)
    expect(result[0].fiedlerX1000).toBeGreaterThan(0)
  })
})

describe('symbol-entropy (Shannon)', () => {
  it('returns empty for too-few calls', () => {
    const refs: SymbolRefEdge[] = [
      { from: 'a:f', to: 'b:g', line: 1 },
      { from: 'a:f', to: 'b:g', line: 2 },
    ]
    const result = computeSymbolEntropy(refs)
    expect(result).toEqual([])
  })

  it('entropy = 0 for repeated same callee', () => {
    const refs: SymbolRefEdge[] = Array.from({ length: 10 }, (_, i) => ({
      from: 'a:f', to: 'b:g', line: i,
    }))
    const result = computeSymbolEntropy(refs)
    expect(result.length).toBe(1)
    expect(result[0].entropyX1000).toBe(0)  // 1 callee, p=1, H=0
  })

  it('entropy ~1000 (1 bit) for 2 callees uniformes', () => {
    const refs: SymbolRefEdge[] = [
      { from: 'a:f', to: 'b:g', line: 1 },
      { from: 'a:f', to: 'b:g', line: 2 },
      { from: 'a:f', to: 'c:h', line: 3 },
      { from: 'a:f', to: 'c:h', line: 4 },
    ]
    const result = computeSymbolEntropy(refs)
    expect(result.length).toBe(1)
    // 2 callees uniformes : H = -2 × 0.5 × log₂(0.5) = 1 bit
    expect(result[0].entropyX1000).toBe(1000)
  })
})

describe('signature-duplication (Hamming)', () => {
  it('detects 0-Hamming duplicates with sameName', () => {
    const sigs: TypedSignature[] = [
      {
        file: 'a.ts', exportName: 'doX', kind: 'function',
        params: [{ name: 'x', type: 'string', optional: false }],
        returnType: 'void', line: 10,
      },
      {
        file: 'b.ts', exportName: 'doX', kind: 'function',
        params: [{ name: 'x', type: 'string', optional: false }],
        returnType: 'void', line: 10,
      },
    ]
    const result = detectSignatureDuplicates(sigs, { hammingThreshold: 0, sameNameOnly: true })
    expect(result.length).toBe(1)
    expect(result[0].hamming).toBe(0)
  })

  it('skips different names with sameNameOnly', () => {
    const sigs: TypedSignature[] = [
      {
        file: 'a.ts', exportName: 'doX', kind: 'function',
        params: [{ name: 'x', type: 'string', optional: false }],
        returnType: 'void', line: 10,
      },
      {
        file: 'b.ts', exportName: 'doY', kind: 'function',
        params: [{ name: 'x', type: 'string', optional: false }],
        returnType: 'void', line: 10,
      },
    ]
    const result = detectSignatureDuplicates(sigs, { hammingThreshold: 0, sameNameOnly: true })
    expect(result).toEqual([])
  })
})

describe('lyapunov-cochange', () => {
  it('returns empty for files with <2 partners', () => {
    const pairs: CoChangePair[] = [
      { from: 'a.ts', to: 'b.ts', count: 5, totalCommitsFrom: 10, totalCommitsTo: 10, jaccard: 0.5 },
    ]
    const result = computeLyapunovMetrics(pairs)
    // Each file has 1 partner only, skipped
    expect(result).toEqual([])
  })

  it('computes λ for files with multiple partners', () => {
    const pairs: CoChangePair[] = [
      { from: 'a.ts', to: 'b.ts', count: 5, totalCommitsFrom: 10, totalCommitsTo: 10, jaccard: 0.5 },
      { from: 'a.ts', to: 'c.ts', count: 5, totalCommitsFrom: 10, totalCommitsTo: 10, jaccard: 0.5 },
    ]
    const result = computeLyapunovMetrics(pairs)
    // a.ts has 2 partners with avg 5 → λ = log(6) × 1000 ≈ 1791
    const a = result.find((r) => r.file === 'a.ts')
    expect(a).toBeDefined()
    expect(a!.partnerCount).toBe(2)
    expect(a!.lyapunovX1000).toBeGreaterThan(1500)
    expect(a!.lyapunovX1000).toBeLessThan(2000)
  })
})

describe('package-mincut (Ford-Fulkerson)', () => {
  it('returns empty when only one package', () => {
    const nodes: GraphNode[] = [
      { id: 'packages/a/src/x.ts', type: 'file', label: 'x' },
      { id: 'packages/a/src/y.ts', type: 'file', label: 'y' },
    ]
    const result = computePackageMinCuts(nodes, [])
    expect(result).toEqual([])
  })

  it('computes min-cut between 2 packages with 1 edge', () => {
    // computePackageMinCuts demande >= 4 file nodes minimum
    const nodes: GraphNode[] = [
      { id: 'packages/a/src/x.ts', type: 'file', label: 'x' },
      { id: 'packages/a/src/y.ts', type: 'file', label: 'y' },
      { id: 'packages/b/src/z.ts', type: 'file', label: 'z' },
      { id: 'packages/b/src/w.ts', type: 'file', label: 'w' },
    ]
    const edges: GraphEdge[] = [
      { id: '1', from: 'packages/a/src/x.ts', to: 'packages/b/src/z.ts', type: 'import', resolved: true },
    ]
    const result = computePackageMinCuts(nodes, edges)
    expect(result.length).toBe(1)
    expect(result[0].minCut).toBe(1)
    expect(result[0].edgeCount).toBe(1)
  })
})

describe('information-bottleneck (Tishby)', () => {
  it('passthrough fn : 1 caller, 1 callee = score ~1000', () => {
    const refs: SymbolRefEdge[] = [
      { from: 'a:caller', to: 'a:middle', line: 1 },
      { from: 'a:middle', to: 'a:end', line: 2 },
    ]
    const result = computeInformationBottleneck(refs)
    const middle = result.find((r) => r.symbol === 'a:middle')
    expect(middle).toBeDefined()
    expect(middle!.callerCount).toBe(1)
    expect(middle!.calleeCount).toBe(1)
    // log₂(2) × log₂(2) = 1 → ×1000 = 1000
    expect(middle!.bottleneckScoreX1000).toBe(1000)
  })

  it('hub : multiple callers + callees = high score', () => {
    const refs: SymbolRefEdge[] = []
    for (let i = 0; i < 5; i++) {
      refs.push({ from: `caller:${i}`, to: 'a:hub', line: i })
      refs.push({ from: 'a:hub', to: `callee:${i}`, line: i + 100 })
    }
    const result = computeInformationBottleneck(refs)
    const hub = result.find((r) => r.symbol === 'a:hub')
    expect(hub).toBeDefined()
    expect(hub!.callerCount).toBe(5)
    expect(hub!.calleeCount).toBe(5)
    // log₂(6) × log₂(6) ≈ 6.68
    expect(hub!.bottleneckScoreX1000).toBeGreaterThan(6000)
    expect(hub!.bottleneckScoreX1000).toBeLessThan(7000)
  })
})
