// ADR-026 — Phase A.3 : adapter DatalogDetectorResults → snapshot fields
/**
 * Convertit la sortie typée du runner Datalog en shapes attendus par le
 * snapshot legacy. Permet le swap full-replace dans `analyzer.ts` quand
 * `useDatalog: true` est activé.
 *
 * Couvre 18/21 fields snapshot avec parité bit-pour-bit (validés par
 * shadow mode A.1 + Sentinel A.2). Trois fields restent en legacy car
 * le runner Datalog n'expose pas TOUTES leurs colonnes :
 *   - `deadCode` : runner = 1 kind sur 6 (identical-subexpressions seul)
 *   - `hardcodedSecrets` : runner manque le field `trigger: 'name'|'pattern'`
 *   - `driftSignals` : runner est split en 4 sub-arrays plats sans
 *     `message`+`severity` ; ce module reconstruit le shape DriftSignal
 *     en répliquant la formule message du legacy (cf. `extractors/
 *     drift-patterns.ts`). À tester avec parité avant le swap drift.
 *
 * Pour les 18 fields trivial-compat : assignment direct (le bench A.2
 * l'a confirmé BIT-IDENTICAL).
 */

import type { DatalogDetectorResults } from './runner.js'
import type { GraphSnapshot } from '../core/types.js'
import { todoToDriftSignal, isTodoExempt } from '../extractors/drift-patterns.js'

/**
 * Defaults pour les seuils des messages drift — mirror de
 * `extractors/drift-patterns.ts`. Si user-override les options
 * passées à `analyzeDriftPatterns()`, le snapshot Datalog message
 * diverge — pour A.3, on documente ce caveat (pas de regression
 * silencieuse, juste un message différent).
 */
const DEFAULT_OPTIONAL_PARAMS_THRESHOLD = 5
const DEFAULT_MAX_NESTING_DEPTH = 5

/**
 * Les 19 fields snapshot que le runner Datalog produit avec parité
 * shape directe (validé bench γ + shadow A.1/A.2 ; A.4.1 ajoute
 * `hardcodedSecrets` désormais shape-compat via le field `trigger`).
 * Drift est exclu car son shape `DriftSignal[]` n'est pas direct-compat
 * (le runner sort 4 sub-arrays plats sans message+severity, et le 5e
 * kind `todo-no-owner` dépend de `snapshot.todos`).
 */
type DirectSnapshotFields = Pick<GraphSnapshot,
  | 'magicNumbers' | 'evalCalls' | 'cryptoCalls' | 'booleanParams'
  | 'sanitizerCalls' | 'taintSinks' | 'longFunctions' | 'functionComplexity'
  | 'eventListenerSites' | 'barrels' | 'envUsage' | 'constantExpressions'
  | 'argumentsFacts' | 'eventEmitSites' | 'taintedVars' | 'resourceImbalances'
  | 'securityPatterns' | 'codeQualityPatterns' | 'hardcodedSecrets'
  | 'deadCode'
>

/**
 * Reconstruit `DriftSignal[]` depuis les 4 sub-arrays plats du runner
 * (excessive-optional-params, wrapper-superfluous, deep-nesting,
 * empty-catch-no-comment). Reproduit message + severity du legacy.
 *
 * `todo-no-owner` (5e kind) est cross-file (dépend de `snapshot.todos`)
 * et ajouté par le caller via `todoToDriftSignal`.
 */
export function adaptDriftSignalsFromDatalog(
  drift: DatalogDetectorResults['driftPatterns'],
  todos: GraphSnapshot['todos'] | undefined,
  rootDir: string,
): NonNullable<GraphSnapshot['driftSignals']> {
  const out = collectDriftFromAst(drift)
  // Pattern 3 (todo-no-owner) : applique le MÊME filter `isTodoExempt`
  // que le legacy `analyzeDriftPatterns`. Sans ça l'adapter génère des
  // todo-no-owner sur des markers exemptés (drift-ok / docblock).
  for (const todo of todos ?? []) {
    if (isTodoExempt(rootDir, todo as Parameters<typeof isTodoExempt>[1])) continue
    const sig = todoToDriftSignal(todo as Parameters<typeof todoToDriftSignal>[0])
    if (sig) out.push(sig)
  }
  sortDriftSignals(out)
  return out
}

function collectDriftFromAst(
  drift: DatalogDetectorResults['driftPatterns'],
): NonNullable<GraphSnapshot['driftSignals']> {
  const out: NonNullable<GraphSnapshot['driftSignals']> = []
  const T_OPT = DEFAULT_OPTIONAL_PARAMS_THRESHOLD
  const T_NEST = DEFAULT_MAX_NESTING_DEPTH

  for (const s of drift.excessiveOptionalParams) {
    out.push({
      kind: 'excessive-optional-params',
      file: s.file,
      line: s.line,
      message: `${s.name} a ${s.optionalCount} params optionnels (>${T_OPT}) — future-proof non demandé ?`,
      severity: 2,
      details: { name: s.name, kind: s.fnKind, optionalCount: s.optionalCount },
    })
  }
  for (const s of drift.wrapperSuperfluous) {
    out.push({
      kind: 'wrapper-superfluous',
      file: s.file,
      line: s.line,
      message: `${s.name} forward → ${s.callee} sans transformation — inliner ?`,
      severity: 1,
      details: { name: s.name, kind: s.fnKind, callee: s.callee },
    })
  }
  for (const s of drift.deepNesting) {
    out.push({
      kind: 'deep-nesting',
      file: s.file,
      line: s.line,
      message: `${s.name} : nesting profondeur ${s.maxDepth} (>${T_NEST}) — guard-clauses ou extract-method ?`,
      severity: 2,
      details: { name: s.name, maxDepth: s.maxDepth },
    })
  }
  for (const s of drift.emptyCatchNoComment) {
    out.push({
      kind: 'empty-catch-no-comment',
      file: s.file,
      line: s.line,
      message: `catch vide sans commentaire — avale silencieusement les erreurs ; ajouter rationale ou logger`,
      severity: 2,
    })
  }
  return out
}

/**
 * Tri global stable des DriftSignal. Aligne sur le legacy : par file
 * croissant, puis line, puis kind (alpha).
 */
function sortDriftSignals(arr: NonNullable<GraphSnapshot['driftSignals']>): void {
  arr.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    if (a.line !== b.line) return a.line - b.line
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
  })
}

/**
 * Produit les 18 fields snapshot directement assignables depuis le runner
 * Datalog (parité shape validée par bench γ + shadow A.1/A.2). Drift n'est
 * PAS inclus ici — le caller doit l'ajouter via `adaptDriftSignalsFromDatalog`
 * après avoir calculé `snapshot.todos` (Phase 1 dans le pipeline analyzer).
 *
 * 3 fields restent en legacy : `deadCode` (1/6 kinds couverts), `hardcoded
 * Secrets` (manque field `trigger`), `driftSignals` (cf. note ci-dessus).
 */
export function buildSnapshotPatchFromDatalog(
  dl: DatalogDetectorResults,
): DirectSnapshotFields {
  // Casts pour les fields où le runner sort des `string` génériques mais
  // le snapshot type attend des unions strictes. Validé par bench γ +
  // shadow A.1/A.2 — TOUS les kinds Datalog sont dans l'union runtime,
  // mais TS strict ne peut pas l'inférer depuis la signature du runner.
  type TaintSinkSnap = NonNullable<GraphSnapshot['taintSinks']>[number]
  type ArgsSnap = NonNullable<GraphSnapshot['argumentsFacts']>
  type TaintedVarsSnap = NonNullable<GraphSnapshot['taintedVars']>
  const taintSinks = dl.taintSinks as TaintSinkSnap[]
  const argumentsFacts = dl.arguments as ArgsSnap
  const taintedVars = dl.taintedVars as TaintedVarsSnap

  // hardcodedSecrets : remap shape runner → shape snapshot legacy.
  // Mapping (cf. extractors/hardcoded-secrets.ts L112-119) :
  //   runner.name        → snapshot.context
  //   runner.sample      → snapshot.preview
  //   runner.entropyX1000 → snapshot.entropy (= round*100/100)
  //
  // Le runner utilise `Math.trunc(entropy * 1000)` (intégrale fixe-point) ;
  // le legacy `Math.round(entropy * 100) / 100` (2 décimales). On retrouve
  // la précision legacy via `Math.round(entropyX1000 / 10) / 100`.
  const hardcodedSecrets = dl.hardcodedSecrets.map((h) => ({
    file: h.file,
    line: h.line,
    context: h.name,
    preview: h.sample,
    entropy: Math.round(h.entropyX1000 / 10) / 100,
    length: h.length,
    trigger: h.trigger,
  }))

  return {
    magicNumbers: dl.magicNumbers,
    evalCalls: dl.evalCalls,
    cryptoCalls: dl.cryptoCalls,
    booleanParams: dl.booleanParams,
    sanitizerCalls: dl.sanitizers,
    taintSinks,
    longFunctions: dl.longFunctions,
    functionComplexity: dl.functionComplexities,
    hardcodedSecrets,
    eventListenerSites: dl.eventListenerSites,
    barrels: dl.barrels,
    envUsage: dl.envUsage,
    constantExpressions: dl.constantExpressions,
    argumentsFacts,
    eventEmitSites: dl.eventEmitSites,
    taintedVars,
    resourceImbalances: dl.resourceImbalances,
    securityPatterns: dl.securityPatterns,
    codeQualityPatterns: dl.codeQualityPatterns,
    deadCode: dl.deadCode,
  }
}
