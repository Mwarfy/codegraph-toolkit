// ADR-026 — Phase A.1 : shadow mode runner Datalog detectors
/**
 * Compare en parallèle les outputs `runDatalogDetectors()` (Phase γ) avec
 * les outputs legacy déjà patchés dans le snapshot. Logue les divergences
 * sans modifier le pipeline. Permet de gagner confiance sur la parité avant
 * le swap A.2.
 *
 * Activé via `analyze({ datalogShadow: true })` ou env var
 * `LIBY_DATALOG_DETECTORS=1`. Le runner ajoute ~extractMs+evalMs au wall
 * clock — acceptable en CI, pas en pre-commit.
 *
 * Granularité comparaison : `file|line|<key fields>` — strict subset des
 * champs validés BIT-IDENTICAL par `bench-datalog-detectors.mjs`. Les
 * shapes outliers (drift-patterns DriftSignal, hardcoded-secrets entropy,
 * dead-code multi-kind, long-functions filter ≥100) sont normalisés ici
 * pour parité — les adapters TS complets viennent en A.2 (full swap).
 */

import type { Project } from 'ts-morph'
import type { GraphSnapshot } from '../core/types.js'
import { runDatalogDetectors, type DatalogDetectorResults } from './runner.js'

export interface DatalogShadowReport {
  /** Total ms — visitor extract + Datalog eval. */
  durationMs: number
  /** stats détaillés du runner. */
  runnerStats: DatalogDetectorResults['stats']
  /** Une entrée par check ; allMatch === true ssi cardinalité + sigs identiques. */
  checks: Array<{
    name: string
    legacyCount: number
    datalogCount: number
    onlyLegacy: number
    onlyDatalog: number
    sampleOnlyLegacy: string[]
    sampleOnlyDatalog: string[]
    allMatch: boolean
  }>
  allMatch: boolean
}

const NORM_WS_RE = /[\t\n\r]/g
const normWs = (s: string | undefined): string => (s ?? '').replace(NORM_WS_RE, ' ')

/**
 * Compare deux arrays via une `keyFn`. Renvoie un check report.
 */
function diffSet<L, D>(
  name: string,
  legacy: L[] | undefined,
  datalog: D[],
  legacyKey: (x: L) => string,
  datalogKey: (x: D) => string,
): DatalogShadowReport['checks'][number] {
  const legacyArr = legacy ?? []
  const a = new Set(legacyArr.map(legacyKey))
  const b = new Set(datalog.map(datalogKey))
  const onlyL: string[] = []
  const onlyD: string[] = []
  for (const x of a) if (!b.has(x)) onlyL.push(x)
  for (const x of b) if (!a.has(x)) onlyD.push(x)
  return {
    name,
    legacyCount: legacyArr.length,
    datalogCount: datalog.length,
    onlyLegacy: onlyL.length,
    onlyDatalog: onlyD.length,
    sampleOnlyLegacy: onlyL.slice(0, 3),
    sampleOnlyDatalog: onlyD.slice(0, 3),
    allMatch: onlyL.length === 0 && onlyD.length === 0,
  }
}

export interface RunDatalogShadowOptions {
  project: Project
  files: string[]
  rootDir: string
  snapshot: GraphSnapshot
}

/**
 * Lance le runner Datalog et compare avec le snapshot legacy. Side-effect
 * pure : ne mute pas le snapshot. Le caller décide quoi faire du report
 * (log warn, throw en CI strict, etc.).
 */
export async function runDatalogShadow(
  opts: RunDatalogShadowOptions,
): Promise<DatalogShadowReport> {
  const t0 = performance.now()
  const dl = await runDatalogDetectors({
    project: opts.project,
    files: opts.files,
    rootDir: opts.rootDir,
  })
  const durationMs = performance.now() - t0
  const snap = opts.snapshot

  const checks: DatalogShadowReport['checks'] = []

  // 1. magic-numbers : shape compat sur (file, line, value, context, category)
  checks.push(diffSet('MagicNumber',
    snap.magicNumbers, dl.magicNumbers,
    (m) => `${m.file}\t${m.line}\t${m.value}\t${m.context}\t${m.category}`,
    (m) => `${m.file}\t${m.line}\t${m.value}\t${m.context}\t${m.category}`,
  ))

  // 2. dead-code : datalog ne couvre QUE identical-subexpressions, legacy
  // peut produire d'autres kinds. On filtre legacy au sous-ensemble couvert.
  const legacyDeadIdentical = (snap.deadCode ?? []).filter(
    (d) => d.kind === 'identical-subexpressions',
  )
  checks.push(diffSet('DeadCode/identical-subexpressions',
    legacyDeadIdentical, dl.deadCodeIdenticalSubexpressions,
    (d) => `${d.file}\t${d.line}\t${d.details?.['operator']}\t${d.details?.['expression']}`,
    (d) => `${d.file}\t${d.line}\t${d.details.operator}\t${d.details.expression}`,
  ))

  // 3. eval-calls
  checks.push(diffSet('EvalCall',
    snap.evalCalls, dl.evalCalls,
    (e) => `${e.file}\t${e.line}\t${e.kind}\t${e.containingSymbol}`,
    (e) => `${e.file}\t${e.line}\t${e.kind}\t${e.containingSymbol}`,
  ))

  // 4. crypto-algo
  checks.push(diffSet('CryptoCall',
    snap.cryptoCalls, dl.cryptoCalls,
    (c) => `${c.file}\t${c.line}\t${c.fn}\t${c.algo}\t${c.containingSymbol}`,
    (c) => `${c.file}\t${c.line}\t${c.fn}\t${c.algo}\t${c.containingSymbol}`,
  ))

  // 5. boolean-params
  checks.push(diffSet('BooleanParam',
    snap.booleanParams, dl.booleanParams,
    (b) => `${b.file}\t${b.name}\t${b.line}\t${b.paramIndex}\t${b.paramName}\t${b.totalParams}`,
    (b) => `${b.file}\t${b.name}\t${b.line}\t${b.paramIndex}\t${b.paramName}\t${b.totalParams}`,
  ))

  // 6. sanitizers (callee normalisé : multi-line method chain → space)
  checks.push(diffSet('Sanitizer',
    snap.sanitizerCalls, dl.sanitizers,
    (s) => `${s.file}\t${s.line}\t${normWs(s.callee)}\t${s.containingSymbol}`,
    (s) => `${s.file}\t${s.line}\t${normWs(s.callee)}\t${s.containingSymbol}`,
  ))

  // 7. taint-sinks
  checks.push(diffSet('TaintSink',
    snap.taintSinks, dl.taintSinks,
    (s) => `${s.file}\t${s.line}\t${s.kind}\t${normWs(s.callee)}\t${s.containingSymbol}`,
    (s) => `${s.file}\t${s.line}\t${s.kind}\t${normWs(s.callee)}\t${s.containingSymbol}`,
  ))

  // 8. long-functions : datalog filtre déjà loc≥100, legacy retourne tout.
  const legacyLongFiltered = (snap.longFunctions ?? []).filter((l) => l.loc >= 100)
  checks.push(diffSet('LongFunction',
    legacyLongFiltered, dl.longFunctions,
    (l) => `${l.file}\t${l.line}\t${l.name}\t${l.loc}\t${l.kind}`,
    (l) => `${l.file}\t${l.line}\t${l.name}\t${l.loc}\t${l.kind}`,
  ))

  // 9. function-complexity
  checks.push(diffSet('FunctionComplexity',
    snap.functionComplexity, dl.functionComplexities,
    (c) => `${c.file}\t${c.line}\t${c.name}\t${c.cyclomatic}\t${c.cognitive}\t${c.containingClass}`,
    (c) => `${c.file}\t${c.line}\t${c.name}\t${c.cyclomatic}\t${c.cognitive}\t${c.containingClass}`,
  ))

  // 10. hardcoded-secrets : shape diff (legacy: context/preview/entropy ;
  // datalog: name/sample/entropyX1000). Comparer file|line|name only —
  // suffisant pour cardinalité + localisation. Adapter A.2.
  checks.push(diffSet('HardcodedSecret',
    snap.hardcodedSecrets, dl.hardcodedSecrets,
    (h) => `${h.file}\t${h.line}\t${h.context}`,
    (h) => `${h.file}\t${h.line}\t${h.name}`,
  ))

  // 11. event-listener-sites
  checks.push(diffSet('EventListenerSite',
    snap.eventListenerSites, dl.eventListenerSites,
    (e) => `${e.file}\t${e.line}\t${e.symbol}\t${normWs(e.callee)}\t${e.kind}\t${e.literalValue ?? ''}\t${e.refExpression ?? ''}`,
    (e) => `${e.file}\t${e.line}\t${e.symbol}\t${normWs(e.callee)}\t${e.kind}\t${e.literalValue ?? ''}\t${e.refExpression ?? ''}`,
  ))

  // 12. barrels
  checks.push(diffSet('Barrel',
    snap.barrels, dl.barrels,
    (b) => `${b.file}\t${b.reExportCount}\t${b.consumerCount}\t${b.lowValue}\t${[...b.consumers].sort().join(',')}`,
    (b) => `${b.file}\t${b.reExportCount}\t${b.consumerCount}\t${b.lowValue}\t${[...b.consumers].sort().join(',')}`,
  ))

  // 13. env-usage : aggrégé par-name. Compare name + isSecret + readers serialized.
  const envNorm = <T extends {
    name: string
    isSecret: boolean
    readers: Array<{ file: string; symbol: string; line: number; hasDefault: boolean; wrappedIn?: string }>
  }>(u: T): string => {
    const rs = [...u.readers]
      .sort((a, b) =>
        a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line,
      )
      .map((r) => `${r.file}|${r.symbol}|${r.line}|${r.hasDefault}|${r.wrappedIn ?? ''}`)
      .join(';')
    return `${u.name}\t${u.isSecret}\t${rs}`
  }
  checks.push(diffSet('EnvUsage',
    snap.envUsage, dl.envUsage,
    envNorm, envNorm,
  ))

  // 14. constant-expressions
  checks.push(diffSet('ConstantExpression',
    snap.constantExpressions, dl.constantExpressions,
    (c) => `${c.file}\t${c.line}\t${c.kind}\t${c.message}\t${c.exprRepr}`,
    (c) => `${c.file}\t${c.line}\t${c.kind}\t${c.message}\t${c.exprRepr}`,
  ))

  // 15a-b. arguments — split en taintedArgs + params
  checks.push(diffSet('TaintedArgumentToCall',
    snap.argumentsFacts?.taintedArgs, dl.arguments.taintedArgs,
    (a) => `${a.callerFile}\t${a.callerSymbol}\t${a.callee}\t${a.paramIndex}\t${a.source}`,
    (a) => `${a.callerFile}\t${a.callerSymbol}\t${a.callee}\t${a.paramIndex}\t${a.source}`,
  ))
  checks.push(diffSet('ArgumentsFunctionParam',
    snap.argumentsFacts?.params, dl.arguments.params,
    (p) => `${p.file}\t${p.symbol}\t${p.paramName}\t${p.paramIndex}`,
    (p) => `${p.file}\t${p.symbol}\t${p.paramName}\t${p.paramIndex}`,
  ))

  // 16. event-emit-sites
  checks.push(diffSet('EventEmitSite',
    snap.eventEmitSites, dl.eventEmitSites,
    (e) => `${e.file}\t${e.line}\t${e.symbol}\t${normWs(e.callee)}\t${e.kind}\t${e.literalValue ?? ''}\t${e.refExpression ?? ''}`,
    (e) => `${e.file}\t${e.line}\t${e.symbol}\t${normWs(e.callee)}\t${e.kind}\t${e.literalValue ?? ''}\t${e.refExpression ?? ''}`,
  ))

  // 17a-b. tainted-vars
  checks.push(diffSet('TaintedVarDecl',
    snap.taintedVars?.decls, dl.taintedVars.decls,
    (d) => `${d.file}\t${d.containingSymbol}\t${d.varName}\t${d.line}\t${d.source}`,
    (d) => `${d.file}\t${d.containingSymbol}\t${d.varName}\t${d.line}\t${d.source}`,
  ))
  checks.push(diffSet('TaintedVarArgCall',
    snap.taintedVars?.argCalls, dl.taintedVars.argCalls,
    (a) => `${a.file}\t${a.line}\t${normWs(a.callee)}\t${a.argVarName}\t${a.argIndex}\t${a.source}\t${a.containingSymbol}`,
    (a) => `${a.file}\t${a.line}\t${normWs(a.callee)}\t${a.argVarName}\t${a.argIndex}\t${a.source}\t${a.containingSymbol}`,
  ))

  // 18. resource-balance
  checks.push(diffSet('ResourceImbalance',
    snap.resourceImbalances, dl.resourceImbalances,
    (r) => `${r.file}\t${r.containingSymbol}\t${r.line}\t${r.pair}\t${r.acquireCount}\t${r.releaseCount}`,
    (r) => `${r.file}\t${r.containingSymbol}\t${r.line}\t${r.pair}\t${r.acquireCount}\t${r.releaseCount}`,
  ))

  // 19a-d. security-patterns
  checks.push(diffSet('SecretVarRef',
    snap.securityPatterns?.secretRefs, dl.securityPatterns.secretRefs,
    (s) => `${s.file}\t${s.line}\t${s.varName}\t${s.kind}\t${normWs(s.callee)}\t${s.containingSymbol}`,
    (s) => `${s.file}\t${s.line}\t${s.varName}\t${s.kind}\t${normWs(s.callee)}\t${s.containingSymbol}`,
  ))
  checks.push(diffSet('CorsConfig',
    snap.securityPatterns?.corsConfigs, dl.securityPatterns.corsConfigs,
    (c) => `${c.file}\t${c.line}\t${c.originKind}\t${c.containingSymbol}`,
    (c) => `${c.file}\t${c.line}\t${c.originKind}\t${c.containingSymbol}`,
  ))
  checks.push(diffSet('TlsUnsafe',
    snap.securityPatterns?.tlsUnsafe, dl.securityPatterns.tlsUnsafe,
    (t) => `${t.file}\t${t.line}\t${t.key}\t${t.containingSymbol}`,
    (t) => `${t.file}\t${t.line}\t${t.key}\t${t.containingSymbol}`,
  ))
  checks.push(diffSet('WeakRandom',
    snap.securityPatterns?.weakRandoms, dl.securityPatterns.weakRandoms,
    (w) => `${w.file}\t${w.line}\t${w.varName}\t${w.secretKind}\t${w.containingSymbol}`,
    (w) => `${w.file}\t${w.line}\t${w.varName}\t${w.secretKind}\t${w.containingSymbol}`,
  ))

  // 20a-d. drift-patterns : legacy DriftSignal flat avec details ;
  // datalog runner = 4 sub-arrays plats. Filtrer le legacy par kind.
  const legacyDrift = snap.driftSignals ?? []
  const legacyOpt = legacyDrift.filter((s) => s.kind === 'excessive-optional-params')
  const legacyWrap = legacyDrift.filter((s) => s.kind === 'wrapper-superfluous')
  const legacyDeep = legacyDrift.filter((s) => s.kind === 'deep-nesting')
  const legacyEmpty = legacyDrift.filter((s) => s.kind === 'empty-catch-no-comment')
  checks.push(diffSet('ExcessiveOptionalParams',
    legacyOpt, dl.driftPatterns.excessiveOptionalParams,
    (s) => `${s.file}\t${s.line}\t${s.details?.['name']}\t${s.details?.['kind']}\t${s.details?.['optionalCount']}`,
    (s) => `${s.file}\t${s.line}\t${s.name}\t${s.fnKind}\t${s.optionalCount}`,
  ))
  checks.push(diffSet('WrapperSuperfluous',
    legacyWrap, dl.driftPatterns.wrapperSuperfluous,
    (s) => `${s.file}\t${s.line}\t${s.details?.['name']}\t${s.details?.['kind']}\t${s.details?.['callee']}`,
    (s) => `${s.file}\t${s.line}\t${s.name}\t${s.fnKind}\t${s.callee}`,
  ))
  checks.push(diffSet('DeepNesting',
    legacyDeep, dl.driftPatterns.deepNesting,
    (s) => `${s.file}\t${s.line}\t${s.details?.['name']}\t${s.details?.['maxDepth']}`,
    (s) => `${s.file}\t${s.line}\t${s.name}\t${s.maxDepth}`,
  ))
  checks.push(diffSet('EmptyCatchNoComment',
    legacyEmpty, dl.driftPatterns.emptyCatchNoComment,
    (s) => `${s.file}\t${s.line}`,
    (s) => `${s.file}\t${s.line}`,
  ))

  // 21a-d. code-quality-patterns
  checks.push(diffSet('RegexLiteral',
    snap.codeQualityPatterns?.regexLiterals, dl.codeQualityPatterns.regexLiterals,
    (r) => `${r.file}\t${r.line}\t${r.source}\t${r.flags}\t${r.hasNestedQuantifier}`,
    (r) => `${r.file}\t${r.line}\t${r.source}\t${r.flags}\t${r.hasNestedQuantifier}`,
  ))
  checks.push(diffSet('TryCatchSwallow',
    snap.codeQualityPatterns?.tryCatchSwallows, dl.codeQualityPatterns.tryCatchSwallows,
    (t) => `${t.file}\t${t.line}\t${t.kind}\t${t.containingSymbol}`,
    (t) => `${t.file}\t${t.line}\t${t.kind}\t${t.containingSymbol}`,
  ))
  checks.push(diffSet('AwaitInLoop',
    snap.codeQualityPatterns?.awaitInLoops, dl.codeQualityPatterns.awaitInLoops,
    (a) => `${a.file}\t${a.line}\t${a.loopKind}\t${a.containingSymbol}`,
    (a) => `${a.file}\t${a.line}\t${a.loopKind}\t${a.containingSymbol}`,
  ))
  checks.push(diffSet('AllocationInLoop',
    snap.codeQualityPatterns?.allocationInLoops, dl.codeQualityPatterns.allocationInLoops,
    (a) => `${a.file}\t${a.line}\t${a.allocKind}\t${a.containingSymbol}`,
    (a) => `${a.file}\t${a.line}\t${a.allocKind}\t${a.containingSymbol}`,
  ))

  return {
    durationMs,
    runnerStats: dl.stats,
    checks,
    allMatch: checks.every((c) => c.allMatch),
  }
}

/**
 * Logue un report shadow en console. Sortie compacte si tout match,
 * détaillée par-check si divergence. Format aligné avec le bench script
 * pour faciliter le diff humain.
 */
export function logShadowReport(report: DatalogShadowReport): void {
  const sumLegacy = report.checks.reduce((s, c) => s + c.legacyCount, 0)
  const sumDatalog = report.checks.reduce((s, c) => s + c.datalogCount, 0)
  const head = `[datalog-shadow] ${report.allMatch ? '✓' : '✗'} ${report.checks.length} checks ` +
    `(legacy=${sumLegacy} dl=${sumDatalog}) ${report.durationMs.toFixed(0)}ms ` +
    `[extract=${report.runnerStats.extractMs.toFixed(0)}ms eval=${report.runnerStats.evalMs.toFixed(0)}ms ` +
    `tuplesIn=${report.runnerStats.tuplesIn} tuplesOut=${report.runnerStats.tuplesOut}]`
  if (report.allMatch) {
    console.log(head)
    return
  }
  console.warn(head)
  for (const c of report.checks) {
    if (c.allMatch) continue
    console.warn(
      `  ✗ ${c.name}: legacy=${c.legacyCount} dl=${c.datalogCount} ` +
      `-${c.onlyLegacy} +${c.onlyDatalog}`,
    )
    if (c.sampleOnlyLegacy.length) {
      console.warn(`    only-legacy:`, c.sampleOnlyLegacy)
    }
    if (c.sampleOnlyDatalog.length) {
      console.warn(`    only-datalog:`, c.sampleOnlyDatalog)
    }
  }
}
