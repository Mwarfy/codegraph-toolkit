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
  sanitizers: Array<{
    file: string
    line: number
    callee: string
    containingSymbol: string
  }>
  taintSinks: Array<{
    file: string
    line: number
    kind: string
    callee: string
    containingSymbol: string
  }>
  longFunctions: Array<{
    file: string
    line: number
    name: string
    loc: number
    kind: 'function' | 'method' | 'arrow'
  }>
  functionComplexities: Array<{
    file: string
    line: number
    name: string
    cyclomatic: number
    cognitive: number
    containingClass: string
  }>
  hardcodedSecrets: Array<{
    file: string
    line: number
    name: string
    sample: string
    entropyX1000: number
    length: number
  }>
  eventListenerSites: Array<{
    file: string
    line: number
    symbol: string
    callee: string
    isMethodCall: boolean
    receiver?: string
    kind: 'literal' | 'eventConstRef' | 'dynamic'
    literalValue?: string
    refExpression?: string
  }>
  /** Barrel files avec leurs consumers aggregés cross-file. */
  barrels: Array<{
    file: string
    reExportCount: number
    consumers: string[]
    consumerCount: number
    lowValue: boolean
  }>
  /** Env-var usages aggrégés par-name avec readers + isSecret. */
  envUsage: Array<{
    name: string
    readers: Array<{
      file: string
      symbol: string
      line: number
      hasDefault: boolean
      wrappedIn?: string
    }>
    isSecret: boolean
  }>
  constantExpressions: Array<{
    file: string
    line: number
    kind: 'tautology-condition' | 'contradiction-condition'
      | 'gratuitous-bool-comparison' | 'double-negation'
      | 'literal-fold-opportunity'
    message: string
    exprRepr: string
  }>
  arguments: {
    taintedArgs: Array<{
      callerFile: string
      callerSymbol: string
      callee: string
      paramIndex: number
      source: string
    }>
    params: Array<{
      file: string
      symbol: string
      paramName: string
      paramIndex: number
    }>
  }
  eventEmitSites: Array<{
    file: string
    line: number
    symbol: string
    callee: string
    isMethodCall: boolean
    receiver?: string
    kind: 'literal' | 'eventConstRef' | 'dynamic'
    literalValue?: string
    refExpression?: string
  }>
  taintedVars: {
    decls: Array<{
      file: string
      containingSymbol: string
      varName: string
      line: number
      source: string
    }>
    argCalls: Array<{
      file: string
      line: number
      callee: string
      argVarName: string
      argIndex: number
      source: string
      containingSymbol: string
    }>
  }
  resourceImbalances: Array<{
    file: string
    containingSymbol: string
    line: number
    pair: string
    acquireCount: number
    releaseCount: number
  }>
  securityPatterns: {
    secretRefs: Array<{
      file: string
      line: number
      varName: string
      kind: string
      callee: string
      containingSymbol: string
    }>
    corsConfigs: Array<{
      file: string
      line: number
      originKind: string
      containingSymbol: string
    }>
    tlsUnsafe: Array<{
      file: string
      line: number
      key: string
      containingSymbol: string
    }>
    weakRandoms: Array<{
      file: string
      line: number
      varName: string
      secretKind: string
      containingSymbol: string
    }>
  }
  driftPatterns: {
    excessiveOptionalParams: Array<{ file: string; line: number; name: string; fnKind: string; optionalCount: number }>
    wrapperSuperfluous: Array<{ file: string; line: number; name: string; fnKind: string; callee: string }>
    deepNesting: Array<{ file: string; line: number; name: string; maxDepth: number }>
    emptyCatchNoComment: Array<{ file: string; line: number }>
  }
  codeQualityPatterns: {
    regexLiterals: Array<{ file: string; line: number; source: string; flags: string; hasNestedQuantifier: boolean }>
    tryCatchSwallows: Array<{ file: string; line: number; kind: string; containingSymbol: string }>
    awaitInLoops: Array<{ file: string; line: number; loopKind: string; containingSymbol: string }>
    allocationInLoops: Array<{ file: string; line: number; allocKind: string; containingSymbol: string }>
  }
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
    sanitizerCandidates: [],
    taintSinkCandidates: [],
    longFunctionCandidates: [],
    functionComplexities: [],
    hardcodedSecretCandidates: [],
    eventListenerSiteCandidates: [],
    barrelFiles: [],
    importEdges: [],
    envVarReads: [],
    constantExpressionCandidates: [],
    taintedArgumentCandidates: [],
    eventEmitSiteCandidates: [],
    taintedVarDeclCandidates: [],
    taintedVarArgCallCandidates: [],
    resourceImbalanceCandidates: [],
    secretVarRefCandidates: [],
    corsConfigCandidates: [],
    tlsUnsafeCandidates: [],
    weakRandomCandidates: [],
    excessiveOptionalParamsCandidates: [],
    wrapperSuperfluousCandidates: [],
    deepNestingCandidates: [],
    emptyCatchNoCommentCandidates: [],
    regexLiteralCandidates: [],
    tryCatchSwallowCandidates: [],
    awaitInLoopCandidates: [],
    allocationInLoopCandidates: [],
  }
  for (const sf of opts.project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), opts.rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const b = extractAstFactsBundle(sf as SourceFile, rel, opts.rootDir)
    merged.numericLiterals.push(...b.numericLiterals)
    merged.binaryExpressions.push(...b.binaryExpressions)
    merged.exemptionLines.push(...b.exemptionLines)
    merged.fileTags.push(...b.fileTags)
    merged.callExpressions.push(...b.callExpressions)
    merged.functionScopes.push(...b.functionScopes)
    merged.functionParams.push(...b.functionParams)
    merged.sanitizerCandidates.push(...b.sanitizerCandidates)
    merged.taintSinkCandidates.push(...b.taintSinkCandidates)
    merged.longFunctionCandidates.push(...b.longFunctionCandidates)
    merged.functionComplexities.push(...b.functionComplexities)
    merged.hardcodedSecretCandidates.push(...b.hardcodedSecretCandidates)
    merged.eventListenerSiteCandidates.push(...b.eventListenerSiteCandidates)
    merged.barrelFiles.push(...b.barrelFiles)
    merged.importEdges.push(...b.importEdges)
    merged.envVarReads.push(...b.envVarReads)
    merged.constantExpressionCandidates.push(...b.constantExpressionCandidates)
    merged.taintedArgumentCandidates.push(...b.taintedArgumentCandidates)
    merged.eventEmitSiteCandidates.push(...b.eventEmitSiteCandidates)
    merged.taintedVarDeclCandidates.push(...b.taintedVarDeclCandidates)
    merged.taintedVarArgCallCandidates.push(...b.taintedVarArgCallCandidates)
    merged.resourceImbalanceCandidates.push(...b.resourceImbalanceCandidates)
    merged.secretVarRefCandidates.push(...b.secretVarRefCandidates)
    merged.corsConfigCandidates.push(...b.corsConfigCandidates)
    merged.tlsUnsafeCandidates.push(...b.tlsUnsafeCandidates)
    merged.weakRandomCandidates.push(...b.weakRandomCandidates)
    merged.excessiveOptionalParamsCandidates.push(...b.excessiveOptionalParamsCandidates)
    merged.wrapperSuperfluousCandidates.push(...b.wrapperSuperfluousCandidates)
    merged.deepNestingCandidates.push(...b.deepNestingCandidates)
    merged.emptyCatchNoCommentCandidates.push(...b.emptyCatchNoCommentCandidates)
    merged.regexLiteralCandidates.push(...b.regexLiteralCandidates)
    merged.tryCatchSwallowCandidates.push(...b.tryCatchSwallowCandidates)
    merged.awaitInLoopCandidates.push(...b.awaitInLoopCandidates)
    merged.allocationInLoopCandidates.push(...b.allocationInLoopCandidates)
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
  factsByRelation.set('SanitizerCandidate',
    merged.sanitizerCandidates.map((s) =>
      [s.file, s.line, safe(s.callee), safe(s.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('TaintSinkCandidate',
    merged.taintSinkCandidates.map((s) =>
      [s.file, s.line, s.kind, safe(s.callee), safe(s.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('LongFunctionCandidate',
    merged.longFunctionCandidates.map((l) =>
      [l.file, l.line, safe(l.name), l.loc, l.kind].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('FunctionComplexityFactIn',
    merged.functionComplexities.map((c) =>
      [c.file, c.line, safe(c.name), c.cyclomatic, c.cognitive, safe(c.containingClass)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('HardcodedSecretCandidate',
    merged.hardcodedSecretCandidates.map((h) =>
      [h.file, h.line, safe(h.varOrPropName), safe(h.sample), h.entropyX1000, h.length].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('EventListenerSiteCandidate',
    merged.eventListenerSiteCandidates.map((e) =>
      [e.file, e.line, safe(e.symbol), safe(e.callee), e.isMethodCall, safe(e.receiver),
       e.kind, safe(e.literalValue), safe(e.refExpression)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('BarrelFileFact',
    merged.barrelFiles.map((b) => [b.file, b.reExportCount].join('\t')).join('\n'),
  )
  factsByRelation.set('ImportEdgeFact',
    merged.importEdges.map((e) => [e.fromFile, e.toFile].join('\t')).join('\n'),
  )
  factsByRelation.set('EnvVarRead',
    merged.envVarReads.map((r) =>
      [r.file, r.line, r.col, safe(r.varName), safe(r.symbol), r.hasDefault, safe(r.wrappedIn)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('ConstantExpressionCandidate',
    merged.constantExpressionCandidates.map((c) =>
      [c.file, c.line, c.kind, safe(c.message), safe(c.exprRepr)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('TaintedArgumentCandidate',
    merged.taintedArgumentCandidates.map((a) =>
      [a.callerFile, safe(a.callerSymbol), safe(a.callee), a.paramIndex, a.source].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('EventEmitSiteCandidate',
    merged.eventEmitSiteCandidates.map((e) =>
      [e.file, e.line, safe(e.symbol), safe(e.callee), e.isMethodCall, safe(e.receiver),
       e.kind, safe(e.literalValue), safe(e.refExpression)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('TaintedVarDeclCandidate',
    merged.taintedVarDeclCandidates.map((d) =>
      [d.file, safe(d.containingSymbol), safe(d.varName), d.line, d.source].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('TaintedVarArgCallCandidate',
    merged.taintedVarArgCallCandidates.map((a) =>
      [a.file, a.line, safe(a.callee), safe(a.argVarName), a.argIndex, a.source, safe(a.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('ResourceImbalanceCandidate',
    merged.resourceImbalanceCandidates.map((r) =>
      [r.file, safe(r.containingSymbol), r.line, r.pair, r.acquireCount, r.releaseCount].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('SecretVarRefCandidate',
    merged.secretVarRefCandidates.map((s) =>
      [s.file, s.line, safe(s.varName), s.kind, safe(s.callee), safe(s.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('CorsConfigCandidate',
    merged.corsConfigCandidates.map((c) =>
      [c.file, c.line, c.originKind, safe(c.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('TlsUnsafeCandidate',
    merged.tlsUnsafeCandidates.map((t) =>
      [t.file, t.line, t.key, safe(t.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('WeakRandomCandidate',
    merged.weakRandomCandidates.map((w) =>
      [w.file, w.line, safe(w.varName), w.secretKind, safe(w.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('ExcessiveOptionalParamsCandidate',
    merged.excessiveOptionalParamsCandidates.map((p) =>
      [p.file, p.line, safe(p.name), p.fnKind, p.optionalCount].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('WrapperSuperfluousCandidate',
    merged.wrapperSuperfluousCandidates.map((w) =>
      [w.file, w.line, safe(w.name), w.fnKind, safe(w.callee)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('DeepNestingCandidate',
    merged.deepNestingCandidates.map((d) =>
      [d.file, d.line, safe(d.name), d.maxDepth].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('EmptyCatchNoCommentCandidate',
    merged.emptyCatchNoCommentCandidates.map((e) =>
      [e.file, e.line].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('RegexLiteralCandidate',
    merged.regexLiteralCandidates.map((r) =>
      [r.file, r.line, safe(r.source), safe(r.flags), r.hasNestedQuantifier].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('TryCatchSwallowCandidate',
    merged.tryCatchSwallowCandidates.map((t) =>
      [t.file, t.line, t.kind, safe(t.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('AwaitInLoopCandidate',
    merged.awaitInLoopCandidates.map((a) =>
      [a.file, a.line, a.loopKind, safe(a.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  factsByRelation.set('AllocationInLoopCandidate',
    merged.allocationInLoopCandidates.map((a) =>
      [a.file, a.line, a.allocKind, safe(a.containingSymbol)].join('\t'),
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

  const sanitizers = fileLineSort((result.outputs.get('SanitizerOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    callee: String(t[2]),
    containingSymbol: String(t[3]),
  })))

  const taintSinks = fileLineSort((result.outputs.get('TaintSinkOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    kind: String(t[2]),
    callee: String(t[3]),
    containingSymbol: String(t[4]),
  })))

  const longFunctions = fileLineSort((result.outputs.get('LongFunctionOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    name: String(t[2]),
    loc: Number(t[3]),
    kind: String(t[4]) as 'function' | 'method' | 'arrow',
  })))
  // Re-sort par loc desc pour matcher legacy analyzeLongFunctions
  longFunctions.sort((a, b) => b.loc - a.loc)

  const functionComplexities = fileLineSort((result.outputs.get('FunctionComplexityOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    name: String(t[2]),
    cyclomatic: Number(t[3]),
    cognitive: Number(t[4]),
    containingClass: String(t[5]),
  })))

  const hardcodedSecrets = fileLineSort((result.outputs.get('HardcodedSecretOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    name: String(t[2]),
    sample: String(t[3]),
    entropyX1000: Number(t[4]),
    length: Number(t[5]),
  })))

  // ─── Barrels — aggregation cross-file (consumers per barrel) ─────────
  const barrelOutTuples = result.outputs.get('BarrelFileOut') ?? []
  const importEdgeTuples = result.outputs.get('ImportEdgeOut') ?? []
  const BARREL_THRESHOLD = 2
  const barrelSet = new Map<string, number>()
  for (const t of barrelOutTuples) {
    barrelSet.set(String(t[0]), Number(t[1]))
  }
  const consumers = new Map<string, Set<string>>()
  for (const f of barrelSet.keys()) consumers.set(f, new Set())
  for (const t of importEdgeTuples) {
    const from = String(t[0])
    const to = String(t[1])
    if (from === to) continue
    if (barrelSet.has(to)) consumers.get(to)!.add(from)
  }
  const barrels: DatalogDetectorResults['barrels'] = []
  for (const [file, reExportCount] of barrelSet) {
    const cs = [...(consumers.get(file) ?? [])].sort()
    barrels.push({
      file, reExportCount,
      consumers: cs,
      consumerCount: cs.length,
      lowValue: cs.length < BARREL_THRESHOLD,
    })
  }
  barrels.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)

  // ─── EnvUsage — aggregation cross-file (readers per env-var-name) ────
  const envReadTuples = result.outputs.get('EnvVarReadOut') ?? []
  const SECRET_TOKENS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PRIVATE', 'DSN']
  const byName = new Map<string, DatalogDetectorResults['envUsage'][number]['readers']>()
  for (const t of envReadTuples) {
    const file = String(t[0])
    const line = Number(t[1])
    // t[2] = col (used only for Datalog tuple uniqueness, dropped here)
    const name = String(t[3])
    const symbol = String(t[4])
    const hasDefault = Number(t[5]) === 1
    const wrappedIn = String(t[6])
    if (!byName.has(name)) byName.set(name, [])
    const reader: DatalogDetectorResults['envUsage'][number]['readers'][number] = {
      file, symbol, line, hasDefault,
    }
    if (wrappedIn) reader.wrappedIn = wrappedIn
    byName.get(name)!.push(reader)
  }
  const envUsage: DatalogDetectorResults['envUsage'] = []
  for (const [name, readers] of byName) {
    readers.sort((a, b) => a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line)
    const upper = name.toUpperCase()
    const isSecret = SECRET_TOKENS.some((tok) => upper.includes(tok))
    envUsage.push({ name, readers, isSecret })
  }
  envUsage.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

  // ─── Arguments — taintedArgs + params ──────────────────────────────────────
  const taintedArgsRaw = (result.outputs.get('TaintedArgumentToCallOut') ?? []).map((t: Tuple) => ({
    callerFile: String(t[0]),
    callerSymbol: String(t[1]),
    callee: String(t[2]),
    paramIndex: Number(t[3]),
    source: String(t[4]),
  }))
  taintedArgsRaw.sort((a, b) =>
    a.callerFile !== b.callerFile
      ? (a.callerFile < b.callerFile ? -1 : 1)
      : a.callerSymbol < b.callerSymbol ? -1 : a.callerSymbol > b.callerSymbol ? 1 : 0,
  )

  const argParamsRaw = (result.outputs.get('ArgumentsFunctionParamOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    symbol: String(t[1]),
    paramName: String(t[2]),
    paramIndex: Number(t[3]),
  }))
  argParamsRaw.sort((a, b) =>
    a.file !== b.file
      ? (a.file < b.file ? -1 : 1)
      : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.paramIndex - b.paramIndex,
  )

  const argumentsResult: DatalogDetectorResults['arguments'] = {
    taintedArgs: taintedArgsRaw,
    params: argParamsRaw,
  }

  // ─── Security Patterns (Tier 16) ───────────────────────────────────────────
  const fileLineSortPlain = <T extends { file: string; line: number }>(arr: T[]): T[] => {
    arr.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
    return arr
  }
  const securityPatternsResult: DatalogDetectorResults['securityPatterns'] = {
    secretRefs: fileLineSortPlain((result.outputs.get('SecretVarRefOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      varName: String(t[2]),
      kind: String(t[3]),
      callee: String(t[4]),
      containingSymbol: String(t[5]),
    }))),
    corsConfigs: fileLineSortPlain((result.outputs.get('CorsConfigOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      originKind: String(t[2]),
      containingSymbol: String(t[3]),
    }))),
    tlsUnsafe: fileLineSortPlain((result.outputs.get('TlsUnsafeOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      key: String(t[2]),
      containingSymbol: String(t[3]),
    }))),
    weakRandoms: fileLineSortPlain((result.outputs.get('WeakRandomOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      varName: String(t[2]),
      secretKind: String(t[3]),
      containingSymbol: String(t[4]),
    }))),
  }

  // ─── Code Quality Patterns (Tier 17 — 4 sub-detectors) ─────────────────────
  const cqSort = <T extends { file: string; line: number }>(arr: T[]): T[] => {
    arr.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
    return arr
  }
  const codeQualityPatternsResult: DatalogDetectorResults['codeQualityPatterns'] = {
    regexLiterals: cqSort((result.outputs.get('RegexLiteralOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      source: String(t[2]),
      flags: String(t[3]),
      hasNestedQuantifier: Number(t[4]) === 1,
    }))),
    tryCatchSwallows: cqSort((result.outputs.get('TryCatchSwallowOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      kind: String(t[2]),
      containingSymbol: String(t[3]),
    }))),
    awaitInLoops: cqSort((result.outputs.get('AwaitInLoopOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      loopKind: String(t[2]),
      containingSymbol: String(t[3]),
    }))),
    allocationInLoops: cqSort((result.outputs.get('AllocationInLoopOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      allocKind: String(t[2]),
      containingSymbol: String(t[3]),
    }))),
  }

  // ─── Drift Patterns (4 AST sub-detectors) ──────────────────────────────────
  const driftSort = <T extends { file: string; line: number }>(arr: T[]): T[] => {
    arr.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
    return arr
  }
  const driftPatternsResult: DatalogDetectorResults['driftPatterns'] = {
    excessiveOptionalParams: driftSort((result.outputs.get('ExcessiveOptionalParamsOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      name: String(t[2]),
      fnKind: String(t[3]),
      optionalCount: Number(t[4]),
    }))),
    wrapperSuperfluous: driftSort((result.outputs.get('WrapperSuperfluousOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      name: String(t[2]),
      fnKind: String(t[3]),
      callee: String(t[4]),
    }))),
    deepNesting: driftSort((result.outputs.get('DeepNestingOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
      name: String(t[2]),
      maxDepth: Number(t[3]),
    }))),
    emptyCatchNoComment: driftSort((result.outputs.get('EmptyCatchNoCommentOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]),
      line: Number(t[1]),
    }))),
  }

  // ─── Resource Balance (Tier 6) ─────────────────────────────────────────────
  const resourceImbalances = (result.outputs.get('ResourceImbalanceOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    containingSymbol: String(t[1]),
    line: Number(t[2]),
    pair: String(t[3]),
    acquireCount: Number(t[4]),
    releaseCount: Number(t[5]),
  }))
  resourceImbalances.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line,
  )

  // ─── Tainted Vars (Tier 11) ────────────────────────────────────────────────
  const taintedVarDecls = (result.outputs.get('TaintedVarDeclOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    containingSymbol: String(t[1]),
    varName: String(t[2]),
    line: Number(t[3]),
    source: String(t[4]),
  }))
  taintedVarDecls.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line,
  )
  const taintedVarArgCalls = (result.outputs.get('TaintedVarArgCallOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    callee: String(t[2]),
    argVarName: String(t[3]),
    argIndex: Number(t[4]),
    source: String(t[5]),
    containingSymbol: String(t[6]),
  }))
  taintedVarArgCalls.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line,
  )
  const taintedVarsResult: DatalogDetectorResults['taintedVars'] = {
    decls: taintedVarDecls,
    argCalls: taintedVarArgCalls,
  }

  const eventEmitSites = fileLineSort((result.outputs.get('EventEmitSiteOut') ?? []).map((t: Tuple) => {
    const isMethodCall = Number(t[4]) === 1
    const receiver = String(t[5])
    const kind = String(t[6]) as 'literal' | 'eventConstRef' | 'dynamic'
    const literalValue = String(t[7])
    const refExpression = String(t[8])
    const out: DatalogDetectorResults['eventEmitSites'][number] = {
      file: String(t[0]),
      line: Number(t[1]),
      symbol: String(t[2]),
      callee: String(t[3]),
      isMethodCall,
      kind,
    }
    if (isMethodCall && receiver) out.receiver = receiver
    if (kind === 'literal' && literalValue) out.literalValue = literalValue
    if (kind === 'eventConstRef' && refExpression) out.refExpression = refExpression
    return out
  }))

  const constantExpressions = (result.outputs.get('ConstantExpressionOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]),
    line: Number(t[1]),
    kind: String(t[2]) as DatalogDetectorResults['constantExpressions'][number]['kind'],
    message: String(t[3]),
    exprRepr: String(t[4]),
  }))
  // sort par (file, line, kind) pour matcher legacy analyzeConstantExpressionsBatch
  constantExpressions.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) :
    a.line !== b.line ? a.line - b.line :
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  )

  const eventListenerSites = fileLineSort((result.outputs.get('EventListenerSiteOut') ?? []).map((t: Tuple) => {
    const isMethodCall = Number(t[4]) === 1
    const receiver = String(t[5])
    const kind = String(t[6]) as 'literal' | 'eventConstRef' | 'dynamic'
    const literalValue = String(t[7])
    const refExpression = String(t[8])
    const out: DatalogDetectorResults['eventListenerSites'][number] = {
      file: String(t[0]),
      line: Number(t[1]),
      symbol: String(t[2]),
      callee: String(t[3]),
      isMethodCall,
      kind,
    }
    // Match legacy : receiver/literalValue/refExpression sont OPTIONAL
    // (omis si vide). Préserve la shape EventListenerSite.
    if (isMethodCall && receiver) out.receiver = receiver
    if (kind === 'literal' && literalValue) out.literalValue = literalValue
    if (kind === 'eventConstRef' && refExpression) out.refExpression = refExpression
    return out
  }))

  const tuplesIn =
    merged.numericLiterals.length +
    merged.binaryExpressions.length +
    merged.exemptionLines.length +
    merged.fileTags.length +
    merged.callExpressions.length +
    merged.functionScopes.length +
    merged.functionParams.length +
    merged.sanitizerCandidates.length +
    merged.taintSinkCandidates.length +
    merged.longFunctionCandidates.length +
    merged.functionComplexities.length +
    merged.hardcodedSecretCandidates.length +
    merged.eventListenerSiteCandidates.length +
    merged.barrelFiles.length +
    merged.importEdges.length +
    merged.envVarReads.length +
    merged.constantExpressionCandidates.length +
    merged.taintedArgumentCandidates.length +
    merged.eventEmitSiteCandidates.length +
    merged.taintedVarDeclCandidates.length +
    merged.taintedVarArgCallCandidates.length +
    merged.resourceImbalanceCandidates.length +
    merged.secretVarRefCandidates.length +
    merged.corsConfigCandidates.length +
    merged.tlsUnsafeCandidates.length +
    merged.weakRandomCandidates.length +
    merged.excessiveOptionalParamsCandidates.length +
    merged.wrapperSuperfluousCandidates.length +
    merged.deepNestingCandidates.length +
    merged.emptyCatchNoCommentCandidates.length +
    merged.regexLiteralCandidates.length +
    merged.tryCatchSwallowCandidates.length +
    merged.awaitInLoopCandidates.length +
    merged.allocationInLoopCandidates.length
  const tuplesOut =
    magicNumbers.length +
    deadCodeIdenticalSubexpressions.length +
    evalCalls.length +
    cryptoCalls.length +
    booleanParams.length +
    sanitizers.length +
    taintSinks.length +
    longFunctions.length +
    functionComplexities.length +
    hardcodedSecrets.length +
    eventListenerSites.length +
    barrels.length +
    envUsage.length +
    constantExpressions.length +
    argumentsResult.taintedArgs.length +
    argumentsResult.params.length +
    eventEmitSites.length +
    taintedVarsResult.decls.length +
    taintedVarsResult.argCalls.length +
    resourceImbalances.length +
    securityPatternsResult.secretRefs.length +
    securityPatternsResult.corsConfigs.length +
    securityPatternsResult.tlsUnsafe.length +
    securityPatternsResult.weakRandoms.length +
    driftPatternsResult.excessiveOptionalParams.length +
    driftPatternsResult.wrapperSuperfluous.length +
    driftPatternsResult.deepNesting.length +
    driftPatternsResult.emptyCatchNoComment.length +
    codeQualityPatternsResult.regexLiterals.length +
    codeQualityPatternsResult.tryCatchSwallows.length +
    codeQualityPatternsResult.awaitInLoops.length +
    codeQualityPatternsResult.allocationInLoops.length

  return {
    magicNumbers,
    deadCodeIdenticalSubexpressions,
    evalCalls,
    cryptoCalls,
    booleanParams,
    sanitizers,
    taintSinks,
    longFunctions,
    functionComplexities,
    hardcodedSecrets,
    eventListenerSites,
    barrels,
    envUsage,
    constantExpressions,
    arguments: argumentsResult,
    eventEmitSites,
    taintedVars: taintedVarsResult,
    resourceImbalances,
    securityPatterns: securityPatternsResult,
    driftPatterns: driftPatternsResult,
    codeQualityPatterns: codeQualityPatternsResult,
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
