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
import { createHash } from 'node:crypto'
import { parse, loadFacts, evaluate, type Tuple } from '@liby-tools/datalog'
import {
  extractAstFactsBundle,
  type AstFactsBundle,
} from './ast-facts-visitor.js'
import { buildLookupTuples } from './lookups.js'
import { ALL_RULES_DL } from './rules/index.js'

// ─── Phase C.2 — module-level cache de l'évaluation Datalog ──────────
//
// Le runner re-parse les rules + reload facts + re-evaluate à chaque appel,
// même quand les facts n'ont pas bougé (Phase C.1 ne cache que la collecte
// AST côté visitor). Sur Sentinel : ~150ms eval/parse/load combiné.
//
// Ce cache court-circuite parse+loadFacts+evaluate quand le hash des
// `factsByRelation` (TSV concat) match le précédent. Le cache vit en
// mémoire de process — un nouveau process le rebuild en cold.
//
// `parse(ALL_RULES_DL)` est lui-même cachable car les rules sont
// immutable au runtime (embedded en TS). Cf. `getCachedProgram()`.

let cachedProgram: ReturnType<typeof parse> | null = null
function getCachedProgram(): ReturnType<typeof parse> {
  if (cachedProgram === null) cachedProgram = parse(ALL_RULES_DL)
  return cachedProgram
}

interface CachedEval {
  factsHash: string
  outputs: Map<string, Tuple[]>
  tuplesIn: number
  tuplesOut: number
}
let cachedEval: CachedEval | null = null

/**
 * Hash SHA-256 court (16 hex chars = 64 bits) du payload `factsByRelation`
 * sérialisé en TSV. Discriminant suffisant pour ce volume (~25k tuples
 * Sentinel) ; collision probable < 2^-32 même avec des millions de runs.
 */
function hashFactsByRelation(factsByRelation: Map<string, string>): string {
  const h = createHash('sha256')
  // Iteration deterministique : sort relation names pour stabilité
  // cross-run même si l'ordre d'insertion varie.
  const names = [...factsByRelation.keys()].sort()
  for (const name of names) {
    h.update(name)
    h.update('\x00')
    h.update(factsByRelation.get(name) ?? '')
    h.update('\x00')
  }
  return h.digest('hex').slice(0, 16)
}

interface EvalOutput {
  outputs: Map<string, Tuple[]>
  tuplesIn: number
  tuplesOut: number
  /** True when the facts hash matched the previous run → eval was skipped. */
  cacheHit: boolean
}

/**
 * Évalue les rules avec cache. Si `factsByRelation` produit le même hash
 * que le précédent run, retourne directement les outputs cachés sans
 * re-loadFacts ni re-evaluate.
 */
function evaluateCached(factsByRelation: Map<string, string>): EvalOutput {
  const factsHash = hashFactsByRelation(factsByRelation)
  if (cachedEval !== null && cachedEval.factsHash === factsHash) {
    return {
      outputs: cachedEval.outputs,
      tuplesIn: cachedEval.tuplesIn,
      tuplesOut: cachedEval.tuplesOut,
      cacheHit: true,
    }
  }
  const program = getCachedProgram()
  const db = loadFacts(program.decls, { factsByRelation })
  const result = evaluate(program, db, {})
  let tuplesIn = 0
  for (const v of factsByRelation.values()) {
    if (v.length === 0) continue
    tuplesIn += v.split('\n').length
  }
  let tuplesOut = 0
  for (const tuples of result.outputs.values()) tuplesOut += tuples.length
  cachedEval = { factsHash, outputs: result.outputs, tuplesIn, tuplesOut }
  return { outputs: result.outputs, tuplesIn, tuplesOut, cacheHit: false }
}

/**
 * Reset le cache d'évaluation. Utilisé par les tests pour isolation entre
 * fixtures. Pas exposé en API publique côté caller — la cache hit
 * automatique (sans flush) est le comportement souhaité en prod.
 */
export function _resetDatalogEvalCache(): void {
  cachedEval = null
  cachedProgram = null
}

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
  /**
   * A.4.2 — full dead-code coverage (6 kinds). Délégué via legacy
   * `extractDeadCodeFileBundle` pour parité bit-pour-bit ; capture
   * via Salsa cache per-file (warm path = 0 re-walk). Cf.
   * `ast-facts-visitor.ts.deadCodeFindings`.
   */
  deadCode: Array<{
    kind: 'identical-subexpressions' | 'return-then-else' | 'switch-fallthrough'
      | 'switch-no-default' | 'switch-empty' | 'controlling-expression-constant'
    file: string
    line: number
    message: string
    details?: Record<string, string | number | boolean>
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
    trigger: 'name' | 'pattern'
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
    /** True when the Datalog eval was served from the warm cache (facts unchanged). */
    evalCacheHit: boolean
  }
}

export interface RunDatalogDetectorsOptions {
  project: Project
  files: string[]
  rootDir: string
  /**
   * ADR-026 phase C : si true, le visitor `extractAstFactsBundle` est
   * appelé via les cells Salsa per-file (warm path skip le walk pour les
   * fichiers non-modifiés). Le caller doit avoir set `fileContent` +
   * `projectFiles` + `setIncrementalContext` AVANT d'appeler le runner —
   * c'est déjà fait par `analyzer.ts` en mode incremental.
   *
   * Cold path (1er run) : équivalent à incremental: false.
   * Warm path (re-run sans changement) : ~0ms walk au lieu de ~3s.
   */
  incremental?: boolean
}

export async function runDatalogDetectors(
  opts: RunDatalogDetectorsOptions,
): Promise<DatalogDetectorResults> {
  const { results } = await runDatalogDetectorsWithBundle(opts)
  return results
}

// ADR-027
/**
 * Variante qui retourne ALSO le `AstFactsBundle` agrégé, nécessaire
 * pour matérialiser le content-addressed fact store (Phase 3).
 * `runDatalogDetectors` reste l'API d'origine ; les callers qui n'ont
 * pas besoin du bundle continuent de l'utiliser inchangée.
 */
export async function runDatalogDetectorsWithBundle(
  opts: RunDatalogDetectorsOptions,
): Promise<{ results: DatalogDetectorResults; bundle: AstFactsBundle }> {
  // 1. AST visitor — 1 passe, tous les facts primitifs.
  const t0 = performance.now()
  let merged: AstFactsBundle
  if (opts.incremental) {
    // Phase C : Salsa cache per-file. Import lazy pour éviter le coût
    // d'init du module Salsa en cold-run no-incremental.
    const { aggregateAstFactsIncremental } = await import('../incremental/datalog-ast-facts.js')
    merged = aggregateAstFactsIncremental('all')
  } else {
    merged = collectAstFactsCold(opts.project, new Set(opts.files), opts.rootDir)
  }
  const extractMs = performance.now() - t0
  const results = finalizeDatalogResults(merged, extractMs)
  return { results, bundle: merged }
}

/**
 * Walk synchrone tous les SourceFile + extract bundle per-file. Cold path
 * du runner Datalog. Extrait pour permettre le swap par Salsa cache via
 * `incremental: true`.
 */
function collectAstFactsCold(project: Project, fileSet: Set<string>, rootDir: string): AstFactsBundle {
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
    deadCodeFindings: [],
  }
  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const b = extractAstFactsBundle(sf as SourceFile, rel, rootDir)
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
    merged.deadCodeFindings.push(...b.deadCodeFindings)
  }
  return merged
}

/**
 * Phase finale du runner : parse rules, charge les facts, évalue, project
 * en types métier. Extrait pour découpler la collecte AST (cachable Salsa)
 * du moteur Datalog (re-évalué à chaque run pour l'instant — Phase C.2
 * pourra cacher aussi).
 */
// ADR-029 — Build TSV pour Datalog. Extrait de finalizeDatalogResults
// (purement séquentiel : 33 set + lookups). Pure : retourne une nouvelle
// Map, ne modifie pas le bundle. Cyclo ~1 (= 0 branche).
function buildFactsByRelation(merged: AstFactsBundle): Map<string, string> {
  // Sanitize : TSV interdit tab/newline/CR + tous les control chars
  // (0x00–0x1F, DEL 0x7F). Les string literals peuvent contenir \0,
  // \x01, etc. Replace par espace pour préserver l'arity TSV.
  // eslint-disable-next-line no-control-regex
  const SAFE_CTRL_RE = /[\x00-\x1F\x7F]/g
  const safe = (s: string): string => s.replace(SAFE_CTRL_RE, ' ')
  const facts = new Map<string, string>()
  facts.set('NumericLiteralAst',
    merged.numericLiterals.map((n) =>
      [n.file, n.line, safe(n.valueText), n.valueAbs, n.parentKind, safe(n.parentName),
       n.parentArgIdx, n.isScreamingSnake, n.isRatio, n.isTrivial].join('\t'),
    ).join('\n'),
  )
  facts.set('BinaryExpressionAst',
    merged.binaryExpressions.map((b) =>
      [b.file, b.line, b.op, safe(b.leftText), safe(b.rightText), b.leftIsShortLiteral].join('\t'),
    ).join('\n'),
  )
  facts.set('ExemptionLine',
    merged.exemptionLines.map((e) => [e.file, e.line, e.marker].join('\t')).join('\n'),
  )
  facts.set('FileTag',
    merged.fileTags.map((t) => [t.file, t.tag].join('\t')).join('\n'),
  )
  facts.set('CallExpressionAst',
    merged.callExpressions.map((c) =>
      [c.file, c.line, c.calleeKind, safe(c.calleeName), safe(c.calleeObjectLast),
       c.firstArgKind, safe(c.firstArgValue), c.isNew, safe(c.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('FunctionScope',
    merged.functionScopes.map((s) =>
      [s.file, s.line, safe(s.name), s.totalParams, s.nameMatchesSetterPredicate].join('\t'),
    ).join('\n'),
  )
  facts.set('FunctionParam',
    merged.functionParams.map((p) =>
      [p.file, p.scopeLine, p.paramIndex, safe(p.paramName), safe(p.typeText)].join('\t'),
    ).join('\n'),
  )
  facts.set('SanitizerCandidate',
    merged.sanitizerCandidates.map((s) =>
      [s.file, s.line, safe(s.callee), safe(s.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('TaintSinkCandidate',
    merged.taintSinkCandidates.map((s) =>
      [s.file, s.line, s.kind, safe(s.callee), safe(s.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('LongFunctionCandidate',
    merged.longFunctionCandidates.map((l) =>
      [l.file, l.line, safe(l.name), l.loc, l.kind].join('\t'),
    ).join('\n'),
  )
  facts.set('FunctionComplexityFactIn',
    merged.functionComplexities.map((c) =>
      [c.file, c.line, safe(c.name), c.cyclomatic, c.cognitive, safe(c.containingClass)].join('\t'),
    ).join('\n'),
  )
  facts.set('HardcodedSecretCandidate',
    merged.hardcodedSecretCandidates.map((h) =>
      [h.file, h.line, safe(h.varOrPropName), safe(h.sample), h.entropyX1000, h.length, h.trigger].join('\t'),
    ).join('\n'),
  )
  facts.set('EventListenerSiteCandidate',
    merged.eventListenerSiteCandidates.map((e) =>
      [e.file, e.line, safe(e.symbol), safe(e.callee), e.isMethodCall, safe(e.receiver),
       e.kind, safe(e.literalValue), safe(e.refExpression)].join('\t'),
    ).join('\n'),
  )
  facts.set('BarrelFileFact',
    merged.barrelFiles.map((b) => [b.file, b.reExportCount].join('\t')).join('\n'),
  )
  facts.set('ImportEdgeFact',
    merged.importEdges.map((e) => [e.fromFile, e.toFile].join('\t')).join('\n'),
  )
  facts.set('EnvVarRead',
    merged.envVarReads.map((r) =>
      [r.file, r.line, r.col, safe(r.varName), safe(r.symbol), r.hasDefault, safe(r.wrappedIn)].join('\t'),
    ).join('\n'),
  )
  facts.set('ConstantExpressionCandidate',
    merged.constantExpressionCandidates.map((c) =>
      [c.file, c.line, c.kind, safe(c.message), safe(c.exprRepr)].join('\t'),
    ).join('\n'),
  )
  facts.set('TaintedArgumentCandidate',
    merged.taintedArgumentCandidates.map((a) =>
      [a.callerFile, safe(a.callerSymbol), safe(a.callee), a.paramIndex, a.source].join('\t'),
    ).join('\n'),
  )
  facts.set('EventEmitSiteCandidate',
    merged.eventEmitSiteCandidates.map((e) =>
      [e.file, e.line, safe(e.symbol), safe(e.callee), e.isMethodCall, safe(e.receiver),
       e.kind, safe(e.literalValue), safe(e.refExpression)].join('\t'),
    ).join('\n'),
  )
  facts.set('TaintedVarDeclCandidate',
    merged.taintedVarDeclCandidates.map((d) =>
      [d.file, safe(d.containingSymbol), safe(d.varName), d.line, d.source].join('\t'),
    ).join('\n'),
  )
  facts.set('TaintedVarArgCallCandidate',
    merged.taintedVarArgCallCandidates.map((a) =>
      [a.file, a.line, safe(a.callee), safe(a.argVarName), a.argIndex, a.source, safe(a.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('ResourceImbalanceCandidate',
    merged.resourceImbalanceCandidates.map((r) =>
      [r.file, safe(r.containingSymbol), r.line, r.pair, r.acquireCount, r.releaseCount].join('\t'),
    ).join('\n'),
  )
  facts.set('SecretVarRefCandidate',
    merged.secretVarRefCandidates.map((s) =>
      [s.file, s.line, safe(s.varName), s.kind, safe(s.callee), safe(s.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('CorsConfigCandidate',
    merged.corsConfigCandidates.map((c) =>
      [c.file, c.line, c.originKind, safe(c.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('TlsUnsafeCandidate',
    merged.tlsUnsafeCandidates.map((t) =>
      [t.file, t.line, t.key, safe(t.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('WeakRandomCandidate',
    merged.weakRandomCandidates.map((w) =>
      [w.file, w.line, safe(w.varName), w.secretKind, safe(w.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('ExcessiveOptionalParamsCandidate',
    merged.excessiveOptionalParamsCandidates.map((p) =>
      [p.file, p.line, safe(p.name), p.fnKind, p.optionalCount].join('\t'),
    ).join('\n'),
  )
  facts.set('WrapperSuperfluousCandidate',
    merged.wrapperSuperfluousCandidates.map((w) =>
      [w.file, w.line, safe(w.name), w.fnKind, safe(w.callee)].join('\t'),
    ).join('\n'),
  )
  facts.set('DeepNestingCandidate',
    merged.deepNestingCandidates.map((d) =>
      [d.file, d.line, safe(d.name), d.maxDepth].join('\t'),
    ).join('\n'),
  )
  facts.set('EmptyCatchNoCommentCandidate',
    merged.emptyCatchNoCommentCandidates.map((e) =>
      [e.file, e.line].join('\t'),
    ).join('\n'),
  )
  facts.set('RegexLiteralCandidate',
    merged.regexLiteralCandidates.map((r) =>
      [r.file, r.line, safe(r.source), safe(r.flags), r.hasNestedQuantifier].join('\t'),
    ).join('\n'),
  )
  facts.set('TryCatchSwallowCandidate',
    merged.tryCatchSwallowCandidates.map((t) =>
      [t.file, t.line, t.kind, safe(t.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('AwaitInLoopCandidate',
    merged.awaitInLoopCandidates.map((a) =>
      [a.file, a.line, a.loopKind, safe(a.containingSymbol)].join('\t'),
    ).join('\n'),
  )
  facts.set('AllocationInLoopCandidate',
    merged.allocationInLoopCandidates.map((a) =>
      [a.file, a.line, a.allocKind, safe(a.containingSymbol)].join('\t'),
    ).join('\n'),
  )

  // Lookup tables (statiques)
  const lookups = buildLookupTuples()
  facts.set('TimeoutFnName', lookups.TimeoutFnName.map((r) => r.join('\t')).join('\n'))
  facts.set('TimeoutPropertyName', lookups.TimeoutPropertyName.map((r) => r.join('\t')).join('\n'))
  facts.set('ThresholdPropertyName', lookups.ThresholdPropertyName.map((r) => r.join('\t')).join('\n'))
  facts.set('SuspectBinaryOp', lookups.SuspectBinaryOp.map((r) => r.join('\t')).join('\n'))
  facts.set('CryptoMethodName', lookups.CryptoMethodName.map((r) => r.join('\t')).join('\n'))
  facts.set('CryptoObjectLast', lookups.CryptoObjectLast.map((r) => r.join('\t')).join('\n'))
  facts.set('BooleanParamTypeText', lookups.BooleanParamTypeText.map((r) => r.join('\t')).join('\n'))

  return facts
}

function finalizeDatalogResults(merged: AstFactsBundle, extractMs: number): DatalogDetectorResults {
  // 2. Phase C.2 : parse + loadFacts + evaluate sont cachés en module-level
  // (cf. `getCachedProgram` + `evaluateCached`). Le hash des facts détecte
  // les changements ; warm path skip toute la phase 2-4.
  const t1 = performance.now()

  // ADR-029 — Build TSV délégué à buildFactsByRelation (helper top-level
  // extrait pour réduire cyclomatic de finalize, cf. refacto 2026-05-11).
  const factsByRelation = buildFactsByRelation(merged)

  // 3. Évalue les rules avec cache (Phase C.2).
  // Cache hit warm path : ~1ms (juste hashFactsByRelation).
  // Cache miss cold : ~150ms (parse cached + loadFacts + evaluate).
  const evaluation = evaluateCached(factsByRelation)
  const result = { outputs: evaluation.outputs }
  const evalMs = performance.now() - t1

  // 5. Project les outputs en types métier. ADR-029 — chaque groupe
  // de projection est extrait en helper top-level (= visité comme
  // fonction séparée par le visitor) pour réduire cyclo de finalize.
  const structural = projectStructuralOutputs(result.outputs)
  const barrels = projectBarrels(result.outputs)
  const envUsage = projectEnvUsage(result.outputs)
  const argumentsResult = projectArguments(result.outputs)
  const resourceImbalances = projectResourceImbalances(result.outputs)
  const taintedVarsResult = projectTaintedVars(result.outputs)
  const eventEmitSites = projectEventEmitSites(result.outputs)
  const constantExpressions = projectConstantExpressions(result.outputs)
  const eventListenerSites = projectEventListenerSites(result.outputs)
  const deadCode = projectDeadCode(merged)

  // ADR-028 — sub-projectors security/code-quality/drift (déjà extraits).
  const securityPatternsResult = projectSecurityPatterns(result.outputs)
  const codeQualityPatternsResult = projectCodeQualityPatterns(result.outputs)
  const driftPatternsResult = projectDriftPatterns(result.outputs)

  const tuplesIn = computeTuplesIn(merged)
  const tuplesOut = computeTuplesOut(
    structural, barrels, envUsage, argumentsResult,
    resourceImbalances, taintedVarsResult, eventEmitSites,
    constantExpressions, eventListenerSites,
    securityPatternsResult, codeQualityPatternsResult, driftPatternsResult,
  )

  return {
    ...structural,
    deadCode,
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
    stats: { extractMs, evalMs, tuplesIn, tuplesOut, evalCacheHit: evaluation.cacheHit },
  }
}

// ─── Projectors (extraits de finalizeDatalogResults pour réduire ─────
// cyclomatic, cf. ADR-029 — chaque helper est une fn pure top-level
// visitée séparément par le complexity extractor).

interface StructuralOutputs {
  magicNumbers: DatalogDetectorResults['magicNumbers']
  deadCodeIdenticalSubexpressions: DatalogDetectorResults['deadCodeIdenticalSubexpressions']
  evalCalls: DatalogDetectorResults['evalCalls']
  cryptoCalls: DatalogDetectorResults['cryptoCalls']
  booleanParams: DatalogDetectorResults['booleanParams']
  sanitizers: DatalogDetectorResults['sanitizers']
  taintSinks: DatalogDetectorResults['taintSinks']
  longFunctions: DatalogDetectorResults['longFunctions']
  functionComplexities: DatalogDetectorResults['functionComplexities']
  hardcodedSecrets: DatalogDetectorResults['hardcodedSecrets']
}

function projectStructuralOutputs(outputs: Map<string, Tuple[]>): StructuralOutputs {
  const magicNumbers = fileLineSortAsc((outputs.get('MagicNumber') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]), value: String(t[2]), context: String(t[3]),
    category: String(t[4]) as 'timeout' | 'threshold' | 'ratio' | 'large-int' | 'other',
  })))

  const deadCodeIdenticalSubexpressions = fileLineSortAsc((outputs.get('DeadCode') ?? [])
    .filter((t: Tuple) => String(t[2]) === 'identical-subexpressions')
    .map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]),
      kind: 'identical-subexpressions' as const,
      message: `expression ${String(t[4])} avec les 2 cotes identiques (${truncate(String(t[5]), 30)}) — bug ou redondance`,
      details: { operator: String(t[4]), expression: truncate(String(t[5]), 60) },
    })))

  const evalCalls = fileLineSortAsc((outputs.get('EvalCall') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]),
    kind: String(t[2]) as 'eval' | 'function-constructor',
    containingSymbol: String(t[3]),
  })))

  const cryptoCalls = fileLineSortAsc((outputs.get('CryptoCall') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]), fn: String(t[2]), algo: String(t[3]),
    containingSymbol: String(t[4]),
  })))

  const booleanParams = (outputs.get('BooleanParamSiteOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), name: String(t[1]), line: Number(t[2]),
    paramIndex: Number(t[3]), paramName: String(t[4]), totalParams: Number(t[5]),
  }))
  booleanParams.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1
    : a.line - b.line || a.paramIndex - b.paramIndex,
  )

  const sanitizers = fileLineSortAsc((outputs.get('SanitizerOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]), callee: String(t[2]), containingSymbol: String(t[3]),
  })))

  const taintSinks = fileLineSortAsc((outputs.get('TaintSinkOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]), kind: String(t[2]),
    callee: String(t[3]), containingSymbol: String(t[4]),
  })))

  const longFunctions = fileLineSortAsc((outputs.get('LongFunctionOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]), name: String(t[2]),
    loc: Number(t[3]), kind: String(t[4]) as 'function' | 'method' | 'arrow',
  })))
  longFunctions.sort((a, b) => b.loc - a.loc)

  const functionComplexities = fileLineSortAsc((outputs.get('FunctionComplexityOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]), name: String(t[2]),
    cyclomatic: Number(t[3]), cognitive: Number(t[4]), containingClass: String(t[5]),
  })))

  const hardcodedSecrets = fileLineSortAsc((outputs.get('HardcodedSecretOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]), name: String(t[2]), sample: String(t[3]),
    entropyX1000: Number(t[4]), length: Number(t[5]), trigger: String(t[6]) as 'name' | 'pattern',
  })))

  return {
    magicNumbers, deadCodeIdenticalSubexpressions, evalCalls, cryptoCalls,
    booleanParams, sanitizers, taintSinks, longFunctions, functionComplexities,
    hardcodedSecrets,
  }
}

function projectDeadCode(merged: AstFactsBundle): DatalogDetectorResults['deadCode'] {
  type DeadCodeKind = 'identical-subexpressions' | 'return-then-else'
    | 'switch-fallthrough' | 'switch-no-default' | 'switch-empty'
    | 'controlling-expression-constant'
  return [...merged.deadCodeFindings]
    .map((f) => ({
      kind: f.kind as DeadCodeKind,
      file: f.file, line: f.line, message: f.message, details: f.details,
    }))
    .sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      if (a.line !== b.line) return a.line - b.line
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
    })
}

function projectBarrels(outputs: Map<string, Tuple[]>): DatalogDetectorResults['barrels'] {
  const BARREL_THRESHOLD = 2
  const barrelSet = new Map<string, number>()
  for (const t of outputs.get('BarrelFileOut') ?? []) {
    barrelSet.set(String(t[0]), Number(t[1]))
  }
  const consumers = new Map<string, Set<string>>()
  for (const f of barrelSet.keys()) consumers.set(f, new Set())
  for (const t of outputs.get('ImportEdgeOut') ?? []) {
    const from = String(t[0])
    const to = String(t[1])
    if (from === to) continue
    if (barrelSet.has(to)) consumers.get(to)!.add(from)
  }
  const barrels: DatalogDetectorResults['barrels'] = []
  for (const [file, reExportCount] of barrelSet) {
    const cs = [...(consumers.get(file) ?? [])].sort()
    barrels.push({
      file, reExportCount, consumers: cs, consumerCount: cs.length,
      lowValue: cs.length < BARREL_THRESHOLD,
    })
  }
  barrels.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
  return barrels
}

function projectEnvUsage(outputs: Map<string, Tuple[]>): DatalogDetectorResults['envUsage'] {
  const SECRET_TOKENS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PRIVATE', 'DSN']
  const byName = new Map<string, DatalogDetectorResults['envUsage'][number]['readers']>()
  for (const t of outputs.get('EnvVarReadOut') ?? []) {
    const name = String(t[3])
    const wrappedIn = String(t[6])
    if (!byName.has(name)) byName.set(name, [])
    const reader: DatalogDetectorResults['envUsage'][number]['readers'][number] = {
      file: String(t[0]), symbol: String(t[4]), line: Number(t[1]),
      hasDefault: Number(t[5]) === 1,
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
  return envUsage
}

function projectArguments(outputs: Map<string, Tuple[]>): DatalogDetectorResults['arguments'] {
  const taintedArgs = (outputs.get('TaintedArgumentToCallOut') ?? []).map((t: Tuple) => ({
    callerFile: String(t[0]), callerSymbol: String(t[1]), callee: String(t[2]),
    paramIndex: Number(t[3]), source: String(t[4]),
  }))
  taintedArgs.sort((a, b) =>
    a.callerFile !== b.callerFile
      ? (a.callerFile < b.callerFile ? -1 : 1)
      : a.callerSymbol < b.callerSymbol ? -1 : a.callerSymbol > b.callerSymbol ? 1 : 0,
  )
  const params = (outputs.get('ArgumentsFunctionParamOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), symbol: String(t[1]), paramName: String(t[2]), paramIndex: Number(t[3]),
  }))
  params.sort((a, b) =>
    a.file !== b.file
      ? (a.file < b.file ? -1 : 1)
      : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : a.paramIndex - b.paramIndex,
  )
  return { taintedArgs, params }
}

function projectResourceImbalances(outputs: Map<string, Tuple[]>): DatalogDetectorResults['resourceImbalances'] {
  const out = (outputs.get('ResourceImbalanceOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), containingSymbol: String(t[1]), line: Number(t[2]),
    pair: String(t[3]), acquireCount: Number(t[4]), releaseCount: Number(t[5]),
  }))
  out.sort((a, b) => a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line)
  return out
}

function projectTaintedVars(outputs: Map<string, Tuple[]>): DatalogDetectorResults['taintedVars'] {
  const decls = (outputs.get('TaintedVarDeclOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), containingSymbol: String(t[1]), varName: String(t[2]),
    line: Number(t[3]), source: String(t[4]),
  }))
  decls.sort((a, b) => a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line)
  const argCalls = (outputs.get('TaintedVarArgCallOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]), callee: String(t[2]),
    argVarName: String(t[3]), argIndex: Number(t[4]), source: String(t[5]),
    containingSymbol: String(t[6]),
  }))
  argCalls.sort((a, b) => a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line)
  return { decls, argCalls }
}

function projectEventSiteFromTuple<K extends 'eventEmitSites' | 'eventListenerSites'>(
  t: Tuple,
): DatalogDetectorResults[K][number] {
  const isMethodCall = Number(t[4]) === 1
  const receiver = String(t[5])
  const kind = String(t[6]) as 'literal' | 'eventConstRef' | 'dynamic'
  const literalValue = String(t[7])
  const refExpression = String(t[8])
  const out: DatalogDetectorResults[K][number] = {
    file: String(t[0]), line: Number(t[1]), symbol: String(t[2]),
    callee: String(t[3]), isMethodCall, kind,
  }
  if (isMethodCall && receiver) out.receiver = receiver
  if (kind === 'literal' && literalValue) out.literalValue = literalValue
  if (kind === 'eventConstRef' && refExpression) out.refExpression = refExpression
  return out
}

function projectEventEmitSites(outputs: Map<string, Tuple[]>): DatalogDetectorResults['eventEmitSites'] {
  return fileLineSortAsc((outputs.get('EventEmitSiteOut') ?? [])
    .map((t: Tuple) => projectEventSiteFromTuple<'eventEmitSites'>(t)))
}

function projectEventListenerSites(outputs: Map<string, Tuple[]>): DatalogDetectorResults['eventListenerSites'] {
  return fileLineSortAsc((outputs.get('EventListenerSiteOut') ?? [])
    .map((t: Tuple) => projectEventSiteFromTuple<'eventListenerSites'>(t)))
}

function projectConstantExpressions(outputs: Map<string, Tuple[]>): DatalogDetectorResults['constantExpressions'] {
  const out = (outputs.get('ConstantExpressionOut') ?? []).map((t: Tuple) => ({
    file: String(t[0]), line: Number(t[1]),
    kind: String(t[2]) as DatalogDetectorResults['constantExpressions'][number]['kind'],
    message: String(t[3]), exprRepr: String(t[4]),
  }))
  out.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) :
    a.line !== b.line ? a.line - b.line :
    a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  )
  return out
}

function computeTuplesIn(merged: AstFactsBundle): number {
  return merged.numericLiterals.length + merged.binaryExpressions.length
    + merged.exemptionLines.length + merged.fileTags.length + merged.callExpressions.length
    + merged.functionScopes.length + merged.functionParams.length
    + merged.sanitizerCandidates.length + merged.taintSinkCandidates.length
    + merged.longFunctionCandidates.length + merged.functionComplexities.length
    + merged.hardcodedSecretCandidates.length + merged.eventListenerSiteCandidates.length
    + merged.barrelFiles.length + merged.importEdges.length + merged.envVarReads.length
    + merged.constantExpressionCandidates.length + merged.taintedArgumentCandidates.length
    + merged.eventEmitSiteCandidates.length + merged.taintedVarDeclCandidates.length
    + merged.taintedVarArgCallCandidates.length + merged.resourceImbalanceCandidates.length
    + merged.secretVarRefCandidates.length + merged.corsConfigCandidates.length
    + merged.tlsUnsafeCandidates.length + merged.weakRandomCandidates.length
    + merged.excessiveOptionalParamsCandidates.length + merged.wrapperSuperfluousCandidates.length
    + merged.deepNestingCandidates.length + merged.emptyCatchNoCommentCandidates.length
    + merged.regexLiteralCandidates.length + merged.tryCatchSwallowCandidates.length
    + merged.awaitInLoopCandidates.length + merged.allocationInLoopCandidates.length
}

function computeTuplesOut(
  s: StructuralOutputs,
  barrels: DatalogDetectorResults['barrels'],
  envUsage: DatalogDetectorResults['envUsage'],
  args: DatalogDetectorResults['arguments'],
  resourceImbalances: DatalogDetectorResults['resourceImbalances'],
  taintedVars: DatalogDetectorResults['taintedVars'],
  eventEmitSites: DatalogDetectorResults['eventEmitSites'],
  constantExpressions: DatalogDetectorResults['constantExpressions'],
  eventListenerSites: DatalogDetectorResults['eventListenerSites'],
  sec: DatalogDetectorResults['securityPatterns'],
  cq: DatalogDetectorResults['codeQualityPatterns'],
  drift: DatalogDetectorResults['driftPatterns'],
): number {
  return s.magicNumbers.length + s.deadCodeIdenticalSubexpressions.length
    + s.evalCalls.length + s.cryptoCalls.length + s.booleanParams.length
    + s.sanitizers.length + s.taintSinks.length + s.longFunctions.length
    + s.functionComplexities.length + s.hardcodedSecrets.length
    + eventListenerSites.length + barrels.length + envUsage.length
    + constantExpressions.length + args.taintedArgs.length + args.params.length
    + eventEmitSites.length + taintedVars.decls.length + taintedVars.argCalls.length
    + resourceImbalances.length
    + sec.secretRefs.length + sec.corsConfigs.length + sec.tlsUnsafe.length + sec.weakRandoms.length
    + drift.excessiveOptionalParams.length + drift.wrapperSuperfluous.length
    + drift.deepNesting.length + drift.emptyCatchNoComment.length
    + cq.regexLiterals.length + cq.tryCatchSwallows.length
    + cq.awaitInLoops.length + cq.allocationInLoops.length
}

// ─── Sub-projectors (extraits de finalizeDatalogResults pour réduire ─────
// cognitive complexity 97 → ~25). Chaque fonction project les outputs Datalog
// d'un sous-bundle (security, code-quality, drift) en types métier triés.

function fileLineSortAsc<T extends { file: string; line: number }>(arr: T[]): T[] {
  arr.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)
  return arr
}

function projectSecurityPatterns(
  outputs: Map<string, Tuple[]>,
): DatalogDetectorResults['securityPatterns'] {
  return {
    secretRefs: fileLineSortAsc((outputs.get('SecretVarRefOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]), varName: String(t[2]),
      kind: String(t[3]), callee: String(t[4]), containingSymbol: String(t[5]),
    }))),
    corsConfigs: fileLineSortAsc((outputs.get('CorsConfigOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]),
      originKind: String(t[2]), containingSymbol: String(t[3]),
    }))),
    tlsUnsafe: fileLineSortAsc((outputs.get('TlsUnsafeOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]),
      key: String(t[2]), containingSymbol: String(t[3]),
    }))),
    weakRandoms: fileLineSortAsc((outputs.get('WeakRandomOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]), varName: String(t[2]),
      secretKind: String(t[3]), containingSymbol: String(t[4]),
    }))),
  }
}

function projectCodeQualityPatterns(
  outputs: Map<string, Tuple[]>,
): DatalogDetectorResults['codeQualityPatterns'] {
  return {
    regexLiterals: fileLineSortAsc((outputs.get('RegexLiteralOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]),
      source: String(t[2]), flags: String(t[3]),
      hasNestedQuantifier: Number(t[4]) === 1,
    }))),
    tryCatchSwallows: fileLineSortAsc((outputs.get('TryCatchSwallowOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]),
      kind: String(t[2]), containingSymbol: String(t[3]),
    }))),
    awaitInLoops: fileLineSortAsc((outputs.get('AwaitInLoopOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]),
      loopKind: String(t[2]), containingSymbol: String(t[3]),
    }))),
    allocationInLoops: fileLineSortAsc((outputs.get('AllocationInLoopOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]),
      allocKind: String(t[2]), containingSymbol: String(t[3]),
    }))),
  }
}

function projectDriftPatterns(
  outputs: Map<string, Tuple[]>,
): DatalogDetectorResults['driftPatterns'] {
  return {
    excessiveOptionalParams: fileLineSortAsc((outputs.get('ExcessiveOptionalParamsOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]), name: String(t[2]),
      fnKind: String(t[3]), optionalCount: Number(t[4]),
    }))),
    wrapperSuperfluous: fileLineSortAsc((outputs.get('WrapperSuperfluousOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]), name: String(t[2]),
      fnKind: String(t[3]), callee: String(t[4]),
    }))),
    deepNesting: fileLineSortAsc((outputs.get('DeepNestingOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]),
      name: String(t[2]), maxDepth: Number(t[3]),
    }))),
    emptyCatchNoComment: fileLineSortAsc((outputs.get('EmptyCatchNoCommentOut') ?? []).map((t: Tuple) => ({
      file: String(t[0]), line: Number(t[1]),
    }))),
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
