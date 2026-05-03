// ADR-011
/**
 * Facts exporter — sérialise un RuntimeSnapshot vers les .facts TSV
 * dans .codegraph/facts-runtime/ (convention codegraph alignée).
 *
 * Format TSV strict (compatible @liby-tools/datalog) :
 *   - 1 tuple par ligne
 *   - colonnes séparées par TAB
 *   - pas de header, pas de quotes
 *   - tabs/newlines dans les strings → remplacés par espace
 *   - lignes triées lex pour déterminisme
 *
 * Pour chaque relation, écrit aussi un .input dans schema-runtime.dl pour
 * que le datalog runner load les facts. Pattern identique à Sentinel
 * runtime-facts.ts (validé en prod).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { RuntimeSnapshot } from '../core/types.js'

export interface ExportOptions {
  /** Dossier de sortie. Sera créé. Files existants écrasés. */
  outDir: string
}

export interface ExportResult {
  outDir: string
  relations: Array<{ name: string; tuples: number; file: string }>
  schemaFile: string
  manifestFile: string
}

interface RelationDef {
  name: string
  decl: string                                                         // sans .decl prefix
  rows: string[][]
}

function sym(s: string | number): string {
  if (typeof s === 'number') return String(Math.trunc(s))
  return s.replace(/[\t\n\r]/g, ' ')
}

function num(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return String(Math.trunc(n))
}

async function writeRelation(outDir: string, rel: RelationDef): Promise<{ tuples: number; file: string }> {
  const filePath = path.join(outDir, `${rel.name}.facts`)
  const lines = rel.rows.map(cols => cols.join('\t'))
  lines.sort()
  await fs.writeFile(filePath, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf-8')
  return { tuples: rel.rows.length, file: filePath }
}

export async function exportFactsRuntime(
  snapshot: RuntimeSnapshot,
  opts: ExportOptions,
): Promise<ExportResult> {
  await fs.mkdir(opts.outDir, { recursive: true })

  const relations: RelationDef[] = []

  // ─── SymbolTouchedRuntime(file, fn, count, p95LatencyMs) ──────────
  relations.push({
    name: 'SymbolTouchedRuntime',
    decl: '(file:symbol, fn:symbol, count:number, p95LatencyMs:number)',
    rows: snapshot.symbolsTouched.map(s => [
      sym(s.file), sym(s.fn), num(s.count), num(s.p95LatencyMs),
    ]),
  })

  // ─── HttpRouteHit(method, path, status, count, p95LatencyMs) ──────
  relations.push({
    name: 'HttpRouteHit',
    decl: '(method:symbol, routePath:symbol, status:number, count:number, p95LatencyMs:number)',
    rows: snapshot.httpRouteHits.map(h => [
      sym(h.method), sym(h.path), num(h.status), num(h.count), num(h.p95LatencyMs),
    ]),
  })

  // ─── DbQueryExecuted(table, op, count, lastAtUnix) ────────────────
  relations.push({
    name: 'DbQueryExecuted',
    decl: '(tableName:symbol, op:symbol, count:number, lastAtUnix:number)',
    rows: snapshot.dbQueriesExecuted.map(d => [
      sym(d.table), sym(d.op), num(d.count), num(d.lastAtUnix),
    ]),
  })

  // ─── RedisOpExecuted(op, keyPattern, count) ───────────────────────
  relations.push({
    name: 'RedisOpExecuted',
    decl: '(op:symbol, keyPattern:symbol, count:number)',
    rows: snapshot.redisOps.map(r => [
      sym(r.op), sym(r.keyPattern), num(r.count),
    ]),
  })

  // ─── EventEmittedAtRuntime(type, count, lastAtUnix) ───────────────
  relations.push({
    name: 'EventEmittedAtRuntime',
    decl: '(eventType:symbol, count:number, lastAtUnix:number)',
    rows: snapshot.eventsEmitted.map(e => [
      sym(e.type), num(e.count), num(e.lastAtUnix),
    ]),
  })

  // ─── CallEdgeRuntime(fromFile, fromFn, toFile, toFn, count) ───────
  relations.push({
    name: 'CallEdgeRuntime',
    decl: '(fromFile:symbol, fromFn:symbol, toFile:symbol, toFn:symbol, count:number)',
    rows: snapshot.callEdges.map(c => [
      sym(c.fromFile), sym(c.fromFn), sym(c.toFile), sym(c.toFn), num(c.count),
    ]),
  })

  // ─── RuntimeRunMeta(driver, startedAtUnix, durationMs, totalSpans, bucketSizeMs, bucketCount) ─
  // γ.2 : 2 cols ajoutées pour permettre aux rules datalog de reconstruire
  // la fenêtre temporelle. 0 si time-series désactivé (compat α/β).
  relations.push({
    name: 'RuntimeRunMeta',
    decl: '(driver:symbol, startedAtUnix:number, durationMs:number, totalSpans:number, bucketSizeMs:number, bucketCount:number)',
    rows: [[
      sym(snapshot.meta.driver),
      num(snapshot.meta.startedAtUnix),
      num(snapshot.meta.durationMs),
      num(snapshot.meta.totalSpans),
      num(snapshot.meta.bucketSizeMs ?? 0),
      num(snapshot.meta.bucketCount ?? 0),
    ]],
  })

  // ─── LatencySeries(kind, key, bucketIdx, count, meanLatencyMs) ─────
  // γ.2 — sparse time-series. Vide si bucketSizeMs absent.
  relations.push({
    name: 'LatencySeries',
    decl: '(kind:symbol, seriesKey:symbol, bucketIdx:number, count:number, meanLatencyMs:number)',
    rows: (snapshot.latencySeries ?? []).map(s => [
      sym(s.kind), sym(s.key), num(s.bucketIdx), num(s.count), num(s.meanLatencyMs),
    ]),
  })

  // Write all
  const written: ExportResult['relations'] = []
  for (const rel of relations) {
    const r = await writeRelation(opts.outDir, rel)
    written.push({ name: rel.name, tuples: r.tuples, file: r.file })
  }

  // Schema file (auto-generated, matches Sentinel runtime-facts.ts pattern)
  const schemaLines: string[] = [
    '// Auto-generated by @liby-tools/runtime-graph — DO NOT EDIT',
    '// Runtime fact declarations consumed by datalog rules under rules/',
    '',
  ]
  for (const rel of relations) {
    schemaLines.push(`.decl ${rel.name}${rel.decl}`)
    schemaLines.push(`.input ${rel.name}`)
    schemaLines.push('')
  }
  // RuntimeRuleExempt — exception EXPLICITE déclarée par le projet
  // utilisateur dans un .dl à part. PAS un grandfather (qui enterre la
  // dette) — un opt-out documenté case-par-case.
  // Le projet ajoute :
  //   RuntimeRuleExempt("DEAD_HANDLER", "src/plugins/foo.ts", "doFoo").
  // dans son fichier runtime-rule-exempt.dl avec un commentaire
  // expliquant pourquoi cette exception est légitime.
  schemaLines.push('.decl RuntimeRuleExempt(ruleName: symbol, target1: symbol, target2: symbol)')
  schemaLines.push('.input RuntimeRuleExempt')
  schemaLines.push('')

  // RuntimeAlert is the output relation — declared here too for self-contained schema.
  schemaLines.push('.decl RuntimeAlert(category: symbol, target: symbol, detail: symbol, message: symbol)')
  schemaLines.push('.output RuntimeAlert')
  schemaLines.push('')

  const schemaFile = path.join(opts.outDir, 'schema-runtime-graph.dl')
  await fs.writeFile(schemaFile, schemaLines.join('\n'), 'utf-8')

  // Manifest
  const manifestFile = path.join(opts.outDir, 'manifest.json')
  await fs.writeFile(manifestFile, JSON.stringify({
    generatedAtUnix: snapshot.meta.startedAtUnix,
    durationMs: snapshot.meta.durationMs,
    driver: snapshot.meta.driver,
    totalSpans: snapshot.meta.totalSpans,
    relations: written.map(r => ({ name: r.name, tuples: r.tuples })),
  }, null, 2), 'utf-8')

  return { outDir: opts.outDir, relations: written, schemaFile, manifestFile }
}
