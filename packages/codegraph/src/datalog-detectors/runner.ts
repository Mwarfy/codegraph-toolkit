// ADR-024 — Phase γ.4 prototype : runner Datalog detectors
/**
 * Orchestrateur :
 *   1. Visite chaque SourceFile via extractAstFactsBundle (1 passe AST).
 *   2. Concat les bundles → tuples Datalog.
 *   3. Charge les rules `.dl` (schema + magic-numbers + dead-code-...).
 *   4. Inject lookup tables.
 *   5. Évalue → outputs typés MagicNumber + DeadCode.
 *
 * Sortie : objets équivalents au legacy extractor pour BIT-IDENTICAL diff.
 */

import type { Project, SourceFile } from 'ts-morph'
import { parse, loadFacts, evaluate, type Tuple } from '@liby-tools/datalog'
import {
  extractAstFactsBundle,
  type AstFactsBundle,
} from './ast-facts-visitor.js'
import { buildLookupTuples } from './lookups.js'
import { ALL_RULES_DL } from './rules/index.js'

export interface DatalogDetectorResults {
  magicNumbers: Array<{
    file: string
    line: number
    value: string
    context: string
    category: 'timeout' | 'threshold' | 'ratio' | 'large-int' | 'other'
  }>
  deadCodeIdenticalSubexpressions: Array<{
    file: string
    line: number
    kind: 'identical-subexpressions'
    message: string
    details: { operator: string; expression: string }
  }>
  stats: {
    extractMs: number
    evalMs: number
    tuplesIn: number
    tuplesOut: number
  }
}

export interface RunDatalogDetectorsOptions {
  project: Project
  files: string[]
  rootDir: string
}

export async function runDatalogDetectors(
  opts: RunDatalogDetectorsOptions,
): Promise<DatalogDetectorResults> {
  // 1. AST visitor — 1 passe, tous les facts primitifs.
  const t0 = performance.now()
  const fileSet = new Set(opts.files)
  const merged: AstFactsBundle = {
    numericLiterals: [],
    binaryExpressions: [],
    exemptionLines: [],
    fileTags: [],
  }
  for (const sf of opts.project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), opts.rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const b = extractAstFactsBundle(sf as SourceFile, rel)
    merged.numericLiterals.push(...b.numericLiterals)
    merged.binaryExpressions.push(...b.binaryExpressions)
    merged.exemptionLines.push(...b.exemptionLines)
    merged.fileTags.push(...b.fileTags)
  }
  const extractMs = performance.now() - t0

  // 2. Parse les rules (embedded en TS — pas de runtime fs read).
  const t1 = performance.now()
  const program = parse(ALL_RULES_DL)

  // 3. Construit les TSV inline. Datalog factsByRelation = Map<rel, tsvLines>.
  // Sanitize : TSV interdit tab/newline/CR dans les valeurs symbol → on les
  // remplace par espace (extracteur AST capture parfois des string literals
  // multi-line ou indented).
  const safe = (s: string): string => s.replace(/[\t\n\r]/g, ' ')
  const factsByRelation = new Map<string, string>()
  factsByRelation.set('NumericLiteralAst',
    merged.numericLiterals.map((n) =>
      [n.file, n.line, safe(n.valueText), n.valueAbs, n.parentKind, safe(n.parentName),
       n.parentArgIdx, n.isScreamingSnake, n.isRatio, n.isTrivial].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('BinaryExpressionAst',
    merged.binaryExpressions.map((b) =>
      [b.file, b.line, b.op, safe(b.leftText), safe(b.rightText), b.leftIsShortLiteral].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('ExemptionLine',
    merged.exemptionLines.map((e) => [e.file, e.line, e.marker].join('\t')).join('\n'),
  )
  factsByRelation.set('FileTag',
    merged.fileTags.map((t) => [t.file, t.tag].join('\t')).join('\n'),
  )

  const lookups = buildLookupTuples()
  factsByRelation.set('TimeoutFnName',
    lookups.TimeoutFnName.map((r) => r.join('\t')).join('\n'))
  factsByRelation.set('TimeoutPropertyName',
    lookups.TimeoutPropertyName.map((r) => r.join('\t')).join('\n'))
  factsByRelation.set('ThresholdPropertyName',
    lookups.ThresholdPropertyName.map((r) => r.join('\t')).join('\n'))
  factsByRelation.set('SuspectBinaryOp',
    lookups.SuspectBinaryOp.map((r) => r.join('\t')).join('\n'))

  const db = loadFacts(program.decls, { factsByRelation })

  // 4. Évalue les rules.
  const result = evaluate(program, db, {})
  const evalMs = performance.now() - t1

  // 5. Project les outputs en types métier.
  const magicTuples = result.outputs.get('MagicNumber') ?? []
  const deadTuples = result.outputs.get('DeadCode') ?? []

  const magicNumbers = magicTuples.map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    value: String(t[2]),
    context: String(t[3]),
    category: String(t[4]) as 'timeout' | 'threshold' | 'ratio' | 'large-int' | 'other',
  }))
  // Sort canonique compatible avec legacy : (file, line) — déjà fourni par
  // l'engine Datalog (lex sort des outputs), mais on re-sort pour sécurité.
  magicNumbers.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1
    : a.line - b.line,
  )

  const deadCodeIdenticalSubexpressions = deadTuples
    .filter((t: Tuple) => String(t[2]) === 'identical-subexpressions')
    .map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      kind: 'identical-subexpressions' as const,
      message: `expression ${String(t[4])} avec les 2 cotes identiques (${truncate(String(t[5]), 30)}) — bug ou redondance`,
      details: { operator: String(t[4]), expression: truncate(String(t[5]), 60) },
    }))
  deadCodeIdenticalSubexpressions.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1
    : a.line - b.line,
  )

  const tuplesIn =
    merged.numericLiterals.length +
    merged.binaryExpressions.length +
    merged.exemptionLines.length +
    merged.fileTags.length
  const tuplesOut = magicNumbers.length + deadCodeIdenticalSubexpressions.length

  return {
    magicNumbers,
    deadCodeIdenticalSubexpressions,
    stats: { extractMs, evalMs, tuplesIn, tuplesOut },
  }
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}
