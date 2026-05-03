/**
 * Tests pour exportDisciplineFacts — émetteur de facts γ Datalog.
 *
 * META-CRITICAL kill : pure projection function, déterministe, scaling
 * x1000 pour les valeurs continues (Datalog n'a pas de float). Tests
 * exercent : empty input, scaling, idempotence, schema TSV.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { exportDisciplineFacts } from '../src/facts/discipline-exporter.js'
import type { AllDisciplinesResult } from '../src/metrics/runtime-disciplines.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'discipline-exporter-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function emptyResult(): AllDisciplinesResult {
  return {
    hamming: null,
    informationBottleneck: [],
    newmanGirvan: { globalQ: 0, filesByModularity: [] },
    lyapunov: [],
    granger: [],
    grangerFile: [],
    lyapunovTs: [],
    tdaPersistence: [],
  }
}

describe('exportDisciplineFacts', () => {
  it('crée le outDir si absent et emit toutes les relations (empty input)', async () => {
    const outDir = path.join(tmpDir, 'facts-out')
    const result = await exportDisciplineFacts(emptyResult(), outDir)

    expect(result.outDir).toBe(outDir)
    const relNames = result.relations.map((r) => r.name)
    expect(relNames).toContain('HammingStaticRuntime')
    expect(relNames).toContain('IBScoreRuntime')
    expect(relNames).toContain('NgFileQ')
    expect(relNames).toContain('LyapunovRuntime')
    expect(relNames).toContain('GrangerRuntime')

    const stat = await fs.stat(outDir)
    expect(stat.isDirectory()).toBe(true)
  })

  it('Hamming : skip si null, emit row si présent', async () => {
    const outDir = path.join(tmpDir, 'facts')
    const r = emptyResult()
    r.hamming = { distance: 0.42, staticOnly: 5, runtimeOnly: 3, total: 8 }
    const result = await exportDisciplineFacts(r, outDir)
    const ham = result.relations.find((x) => x.name === 'HammingStaticRuntime')
    expect(ham?.tuples).toBe(1)

    // Verifie le scaling x1000 dans le contenu (0.42 → 420)
    const content = await fs.readFile(path.join(outDir, 'HammingStaticRuntime.facts'), 'utf-8')
    expect(content).toMatch(/420\t5\t3\t8/)
  })

  it('IBScore : 1 row par bottleneck avec scaling x1000', async () => {
    const outDir = path.join(tmpDir, 'facts')
    const r = emptyResult()
    r.informationBottleneck = [
      { file: 'src/foo.ts', fn: 'doStuff', inflow: 10, outflow: 2, bottleneckScore: 0.875 },
      { file: 'src/bar.ts', fn: 'compute', inflow: 5, outflow: 5, bottleneckScore: 0.5 },
    ]
    const result = await exportDisciplineFacts(r, outDir)
    expect(result.relations.find((x) => x.name === 'IBScoreRuntime')?.tuples).toBe(2)

    const content = await fs.readFile(path.join(outDir, 'IBScoreRuntime.facts'), 'utf-8')
    expect(content).toMatch(/src\/foo\.ts\tdoStuff\t10\t2\t875/)
    expect(content).toMatch(/src\/bar\.ts\tcompute\t5\t5\t500/)
  })

  it('NewmanGirvan : NgGlobalQ vide si pas de filesByModularity', async () => {
    const outDir = path.join(tmpDir, 'facts')
    const r = emptyResult()
    r.newmanGirvan = { globalQ: 0.42, filesByModularity: [] }
    const result = await exportDisciplineFacts(r, outDir)
    // NgGlobalQ skip si filesByModularity vide (cf. discipline-exporter.ts)
    expect(result.relations.find((x) => x.name === 'NgGlobalQ')?.tuples).toBe(0)
  })

  it('NewmanGirvan : NgGlobalQ row si au moins 1 file', async () => {
    const outDir = path.join(tmpDir, 'facts')
    const r = emptyResult()
    r.newmanGirvan = {
      globalQ: 0.6,
      filesByModularity: [{ file: 'src/foo.ts', q: 0.5, symbolsCount: 3 }],
    }
    const result = await exportDisciplineFacts(r, outDir)
    expect(result.relations.find((x) => x.name === 'NgGlobalQ')?.tuples).toBe(1)
    expect(result.relations.find((x) => x.name === 'NgFileQ')?.tuples).toBe(1)

    const global = await fs.readFile(path.join(outDir, 'NgGlobalQ.facts'), 'utf-8')
    expect(global.trim()).toBe('600')
  })

  it('Lyapunov : émet rows avec lambda x1000', async () => {
    const outDir = path.join(tmpDir, 'facts')
    const r = emptyResult()
    r.lyapunov = [
      { file: 'src/a.ts', fn: 'f', p95LatencyMs: 120, count: 50, approxLambda: 0.123 },
    ]
    const result = await exportDisciplineFacts(r, outDir)
    expect(result.relations.find((x) => x.name === 'LyapunovRuntime')?.tuples).toBe(1)

    const content = await fs.readFile(path.join(outDir, 'LyapunovRuntime.facts'), 'utf-8')
    expect(content).toMatch(/src\/a\.ts\tf\t120\t50\t123/)
  })

  it('idempotent : ré-émettre même résultat overwrite, pas concat', async () => {
    const outDir = path.join(tmpDir, 'facts')
    const r = emptyResult()
    r.lyapunov = [
      { file: 'src/a.ts', fn: 'f', p95LatencyMs: 100, count: 10, approxLambda: 0.5 },
    ]
    await exportDisciplineFacts(r, outDir)
    await exportDisciplineFacts(r, outDir)
    const content = await fs.readFile(path.join(outDir, 'LyapunovRuntime.facts'), 'utf-8')
    const lines = content.trim().split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
  })
})
