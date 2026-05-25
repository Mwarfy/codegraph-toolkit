/**
 * Tests de `cli/commands/exports.ts` — fonctions pures extraites de
 * `runExportsCommand` / `runSingleFileMode` (refactor complexité 20/38 et
 * 17/20 → orchestrateur + helpers). Couvre le prédicat "unused" (dupliqué 6×
 * à l'origine), le comptage par confidence et la résolution de fichier.
 */

import { describe, it, expect } from 'vitest'
import {
  isUnusedExport,
  countByConfidence,
  findExportFileNode,
  type ExportEntry,
  type FileExportNode,
} from '../src/cli/commands/exports.js'

function exp(partial: Partial<ExportEntry>): ExportEntry {
  return { name: 'x', usageCount: 0, ...partial }
}

describe('isUnusedExport', () => {
  it('vrai quand usageCount=0 et pas un re-export', () => {
    expect(isUnusedExport(exp({ usageCount: 0, reExport: false }))).toBe(true)
  })
  it('faux quand utilisé', () => {
    expect(isUnusedExport(exp({ usageCount: 3 }))).toBe(false)
  })
  it('faux quand re-export même si usageCount=0', () => {
    expect(isUnusedExport(exp({ usageCount: 0, reExport: true }))).toBe(false)
  })
})

describe('countByConfidence', () => {
  it('compte les exports par niveau de confidence', () => {
    const files: FileExportNode[] = [
      { id: 'a.ts', exports: [
        exp({ confidence: 'safe-to-remove' }),
        exp({ confidence: 'safe-to-remove' }),
        exp({ confidence: 'test-only' }),
      ] },
      { id: 'b.ts', exports: [
        exp({ confidence: 'possibly-dynamic' }),
        exp({ confidence: 'local-only' }),
        exp({ confidence: undefined }),
      ] },
    ]
    expect(countByConfidence(files)).toEqual({ safe: 2, test: 1, dynamic: 1, local: 1 })
  })
})

describe('findExportFileNode', () => {
  const files: FileExportNode[] = [
    { id: 'packages/codegraph/src/core/graph.ts', exports: [] },
    { id: 'packages/codegraph/src/cli/index.ts', exports: [] },
  ]
  it('matche par suffixe de chemin', () => {
    expect(findExportFileNode(files, 'core/graph.ts')?.id).toBe('packages/codegraph/src/core/graph.ts')
  })
  it('matche par sous-chaîne', () => {
    expect(findExportFileNode(files, 'cli/in')?.id).toBe('packages/codegraph/src/cli/index.ts')
  })
  it('retourne undefined sans correspondance', () => {
    expect(findExportFileNode(files, 'nope.ts')).toBeUndefined()
  })
})
