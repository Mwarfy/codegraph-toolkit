// ADR-024 — Phase γ.4 : runner Datalog detectors
/**
 * Orchestrateur :
 *   1. Visite chaque SourceFile via extractAstFactsBundle (1 passe AST).
 *   2. Concat les bundles → tuples Datalog.
 *   3. Charge les rules `.dl` (schema + magic-numbers + dead-code-...).
 *   4. Inject lookup tables.
 *   5. Évalue → outputs typés.
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
  evalCalls: Array<{
    file: string
    line: number
    kind: 'eval' | 'function-constructor'
    containingSymbol: string
  }>
  cryptoCalls: Array<{
    file: string
    line: number
    fn: string
    algo: string
    containingSymbol: string
  }>
  booleanParams: Array<{
    file: string
    name: string
    line: number
    paramIndex: number
    paramName: string
    totalParams: number
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
    callExpressions: [],
    functionScopes: [],
    functionParams: [],
  }
  for (const sf of opts.project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), opts.rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const b = extractAstFactsBundle(sf as SourceFile, rel)
    merged.numericLiterals.push(...b.numericLiterals)
    merged.binaryExpressions.push(...b.binaryExpressions)
    merged.exemptionLines.push(...b.exemptionLines)
    merged.fileTags.push(...b.fileTags)
    merged.callExpressions.push(...b.callExpressions)
    merged.functionScopes.push(...b.functionScopes)
    merged.functionParams.push(...b.functionParams)
  }
  const extractMs = performance.now() - t0

  // 2. Parse les rules (embedded en TS — pas de runtime fs read).
  const t1 = performance.now()
  const program = parse(ALL_RULES_DL)

  // 3. Construit les TSV inline. Datalog factsByRelation = Map<rel, tsvLines>.
  // Sanitize : TSV interdit tab/newline/CR + tous les control chars (0x00–0x1F,
  // DEL 0x7F). Les string literals peuvent contenir \0, \x01, etc. Replace par
  // espace pour préserver l'arity TSV.
  // eslint-disable-next-line no-control-regex
  const SAFE_CTRL_RE = /[\x00-\x1F\x7F]/g
  const safe = (s: string): string => s.replace(SAFE_CTRL_RE, ' ')
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
  factsByRelation.set('CallExpressionAst',
    merged.callExpressions.map((c) =>
      [c.file, c.line, c.calleeKind, safe(c.calleeName), safe(c.calleeObjectLast),
       c.firstArgKind, safe(c.firstArgValue), c.isNew, safe(c.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('FunctionScope',
    merged.functionScopes.map((s) =>
      [s.file, s.line, safe(s.name), s.totalParams, s.nameMatchesSetterPredicate].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('FunctionParam',
    merged.functionParams.map((p) =>
      [p.file, p.scopeLine, p.paramIndex, safe(p.paramName), safe(p.typeText)].join('\t'),
    ).join('\n'),
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
  factsByRelation.set('CryptoMethodName',
    lookups.CryptoMethodName.map((r) => r.join('\t')).join('\n'))
  factsByRelation.set('CryptoObjectLast',
    lookups.CryptoObjectLast.map((r) => r.join('\t')).join('\n'))
  factsByRelation.set('BooleanParamTypeText',
    lookups.BooleanParamTypeText.map((r) => r.join('\t')).join('\n'))

  const db = loadFacts(program.decls, { factsByRelation })

  // 4. Évalue les rules.
  const result = evaluate(program, db, {})
  const evalMs = performance.now() - t1

  // 5. Project les outputs en types métier.
  const magicTuples = result.outputs.get('MagicNumber') ?? []
  const deadTuples = result.outputs.get('DeadCode') ?? []
  const evalTuples = result.outputs.get('EvalCall') ?? []
  const cryptoTuples = result.outputs.get('CryptoCall') ?? []
  const boolTuples = result.outputs.get('BooleanParamSiteOut') ?? []

  const fileLineSort = <T extends { file: string; line: number }>(arr: T[]): T[] => {
    arr.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
    return arr
  }

  const magicNumbers = fileLineSort(magicTuples.map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    value: String(t[2]),
    context: String(t[3]),
    category: String(t[4]) as 'timeout' | 'threshold' | 'ratio' | 'large-int' | 'other',
  })))

  const deadCodeIdenticalSubexpressions = fileLineSort(deadTuples
    .filter((t: Tuple) => String(t[2]) === 'identical-subexpressions')
    .map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      kind: 'identical-subexpressions' as const,
      message: `expression ${String(t[4])} avec les 2 cotes identiques (${truncate(String(t[5]), 30)}) — bug ou redondance`,
      details: { operator: String(t[4]), expression: truncate(String(t[5]), 60) },
    })))

  const evalCalls = fileLineSort(evalTuples.map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    kind: String(t[2]) as 'eval' | 'function-constructor',
    containingSymbol: String(t[3]),
  })))

  const cryptoCalls = fileLineSort(cryptoTuples.map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    fn: String(t[2]),
    algo: String(t[3]),
    containingSymbol: String(t[4]),
  })))

  const booleanParams = boolTuples.map((t: Tuple) => ({
    file: String(t[0]),
    name: String(t[1]),
    line: Number(t[2]),
    paramIndex: Number(t[3]),
    paramName: String(t[4]),
    totalParams: Number(t[5]),
  }))
  // sort par (file, line, paramIndex) pour matcher legacy iteration order
  booleanParams.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1
    : a.line - b.line || a.paramIndex - b.paramIndex,
  )

  const tuplesIn =
    merged.numericLiterals.length +
    merged.binaryExpressions.length +
    merged.exemptionLines.length +
    merged.fileTags.length +
    merged.callExpressions.length +
    merged.functionScopes.length +
    merged.functionParams.length
  const tuplesOut =
    magicNumbers.length +
    deadCodeIdenticalSubexpressions.length +
    evalCalls.length +
    cryptoCalls.length +
    booleanParams.length

  return {
    magicNumbers,
    deadCodeIdenticalSubexpressions,
    evalCalls,
    cryptoCalls,
    booleanParams,
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
