/**
 * Phase γ exporter — sérialise les disciplines mathématiques runtime
 * vers .facts TSV. Format compatible datalog .input declarations.
 *
 * Tous les scores sont multipliés par 1000 et tronqués (le datalog
 * n'a pas de float — `.decl X(score: number)` est integer-only).
 * Les rules font la conversion inverse pour les seuils.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  AllDisciplinesResult,
  InformationBottleneckRuntimeFact,
  LyapunovRuntimeFact,
  NewmanGirvanRuntimeFact,
  GrangerRuntimeFact,
  GrangerRuntimeFileFact,
} from '../metrics/runtime-disciplines.js'

function sym(s: string): string {
  return s.replace(/[\t\n\r]/g, ' ')
}

function num(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return String(Math.trunc(n))
}

async function writeRelation(outDir: string, name: string, rows: string[][]): Promise<void> {
  const lines = rows.map(cols => cols.join('\t'))
  lines.sort()
  await fs.writeFile(
    path.join(outDir, `${name}.facts`),
    lines.length > 0 ? lines.join('\n') + '\n' : '',
    'utf-8',
  )
}

export interface ExportDisciplinesResult {
  outDir: string
  relations: Array<{ name: string; tuples: number }>
}

/**
 * Export les facts γ dans outDir. Idempotent — overwrite les .facts
 * γ existants. Préserve les facts α/β (ne touche pas aux autres files).
 *
 * Toutes les valeurs continues (Q, score, lambda) sont scalées ×1000
 * et truncated to int car datalog n'a pas de float.
 */
export async function exportDisciplineFacts(
  result: AllDisciplinesResult,
  outDir: string,
): Promise<ExportDisciplinesResult> {
  await fs.mkdir(outDir, { recursive: true })

  const written: ExportDisciplinesResult['relations'] = []

  // ─── HammingStaticRuntime — global metric (1 row) ──────────────
  // schema : (distancePermille:number, staticOnly:number, runtimeOnly:number, total:number)
  const hammingRows: string[][] = []
  if (result.hamming && result.hamming.total > 0) {
    hammingRows.push([
      num(Math.floor(result.hamming.distance * 1000)),
      num(result.hamming.staticOnly),
      num(result.hamming.runtimeOnly),
      num(result.hamming.total),
    ])
  }
  await writeRelation(outDir, 'HammingStaticRuntime', hammingRows)
  written.push({ name: 'HammingStaticRuntime', tuples: hammingRows.length })

  // ─── IBScoreRuntime ────────────────────────────────────────────
  // schema : (file:symbol, fn:symbol, inflow:number, outflow:number, scorePermille:number)
  const ibRows: string[][] = result.informationBottleneck.map((f: InformationBottleneckRuntimeFact) => [
    sym(f.file),
    sym(f.fn),
    num(f.inflow),
    num(f.outflow),
    num(Math.floor(f.bottleneckScore * 1000)),
  ])
  await writeRelation(outDir, 'IBScoreRuntime', ibRows)
  written.push({ name: 'IBScoreRuntime', tuples: ibRows.length })

  // ─── NewmanGirvanRuntime — global Q + per-file ──────────────────
  // 2 relations:
  //   NgGlobalQ(qPermille:number)                   — 1 row
  //   NgFileQ(file:symbol, qPermille:number, n:number) — N rows
  const ngFileRows: string[][] = result.newmanGirvan.filesByModularity.map((f: NewmanGirvanRuntimeFact['filesByModularity'][0]) => [
    sym(f.file),
    num(Math.floor(f.q * 1000)),
    num(f.symbolsCount),
  ])
  await writeRelation(outDir, 'NgFileQ', ngFileRows)
  written.push({ name: 'NgFileQ', tuples: ngFileRows.length })

  const ngGlobalRows: string[][] = ngFileRows.length > 0
    ? [[num(Math.floor(result.newmanGirvan.globalQ * 1000))]]
    : []
  await writeRelation(outDir, 'NgGlobalQ', ngGlobalRows)
  written.push({ name: 'NgGlobalQ', tuples: ngGlobalRows.length })

  // ─── LyapunovRuntime ────────────────────────────────────────────
  // schema : (file:symbol, fn:symbol, p95LatencyMs:number, count:number, lambdaPermille:number)
  const lyapunovRows: string[][] = result.lyapunov.map((f: LyapunovRuntimeFact) => [
    sym(f.file),
    sym(f.fn),
    num(f.p95LatencyMs),
    num(f.count),
    num(Math.floor(f.approxLambda * 1000)),
  ])
  await writeRelation(outDir, 'LyapunovRuntime', lyapunovRows)
  written.push({ name: 'LyapunovRuntime', tuples: lyapunovRows.length })

  // ─── GrangerRuntime (γ.2) ──────────────────────────────────────
  // schema : (driverSeries:symbol, followerSeries:symbol, observations:number,
  //           excessConditionalX1000:number, lagBuckets:number)
  const grangerRows: string[][] = result.granger.map((f: GrangerRuntimeFact) => [
    sym(f.driverSeries),
    sym(f.followerSeries),
    num(f.observations),
    num(f.excessConditionalX1000),
    num(f.lagBuckets),
  ])
  await writeRelation(outDir, 'GrangerRuntime', grangerRows)
  written.push({ name: 'GrangerRuntime', tuples: grangerRows.length })

  // ─── GrangerRuntimeFile (γ.2) ──────────────────────────────────
  // File-level rollup pour cross-validation avec GrangerCausality statique.
  // schema : (driverFile, followerFile, observations, maxExcessX1000)
  const grangerFileRows: string[][] = result.grangerFile.map((f: GrangerRuntimeFileFact) => [
    sym(f.driverFile),
    sym(f.followerFile),
    num(f.observations),
    num(f.maxExcessConditionalX1000),
  ])
  await writeRelation(outDir, 'GrangerRuntimeFile', grangerFileRows)
  written.push({ name: 'GrangerRuntimeFile', tuples: grangerFileRows.length })

  return { outDir, relations: written }
}
