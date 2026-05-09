// ADR-024 — Phase γ.4 : orchestrator AST → primitive Datalog tuples
/**
 * Visiteur unique : 1 passe par SourceFile, délègue à 18 visitors par
 * domaine (numeric-literals, complexity, taint-flow, security, etc.).
 * Chaque visitor vit dans `./ast-facts/<domain>.ts` avec ses propres
 * helpers et constants — voir `ast-facts/types.ts` pour le schéma des
 * facts émis.
 *
 * Bundle = Map<relation, fact[]>. Pure (read-only sur sf), idempotent,
 * déterministe. Les facts traversent IPC trivialement (objets plats).
 */

import type { SourceFile } from 'ts-morph'
import { extractDeadCodeFileBundle } from '../extractors/dead-code.js'
import { isFrameworkEntryPoint } from '../core/framework-conventions.js'
import type {
  AstFactsBundle,
  NumericLiteralFact,
  BinaryExpressionFact,
  ExemptionLineFact,
  FileTagFact,
  CallExpressionFact,
  FunctionScopeFact,
  FunctionParamFact,
  SanitizerCandidateFact,
  TaintSinkCandidateFact,
  LongFunctionCandidateFact,
  FunctionComplexityFact,
  HardcodedSecretCandidateFact,
  EventListenerSiteCandidateFact,
  BarrelFileFact,
  ImportEdgeFact,
  EnvVarReadFact,
  ConstantExpressionCandidateFact,
  TaintedArgumentCandidateFact,
  EventEmitSiteCandidateFact,
  TaintedVarDeclCandidateFact,
  TaintedVarArgCallCandidateFact,
  ResourceImbalanceCandidateFact,
  SecretVarRefCandidateFact,
  CorsConfigCandidateFact,
  TlsUnsafeCandidateFact,
  WeakRandomCandidateFact,
  ExcessiveOptionalParamsCandidateFact,
  WrapperSuperfluousCandidateFact,
  DeepNestingCandidateFact,
  EmptyCatchNoCommentCandidateFact,
  RegexLiteralCandidateFact,
  TryCatchSwallowCandidateFact,
  AwaitInLoopCandidateFact,
  AllocationInLoopCandidateFact,
  DeadCodeFindingFact,
} from './ast-facts/types.js'

import { visitNumericLiterals } from './ast-facts/numeric-literals.js'
import { visitBinaryExpressions } from './ast-facts/binary-expressions.js'
import { visitExemptionMarkers } from './ast-facts/exemption-markers.js'
import { visitCallAndNewExpressions } from './ast-facts/call-expressions.js'
import { visitFunctionScopesAndParams } from './ast-facts/function-scopes.js'
import { visitSanitizerCandidates } from './ast-facts/sanitizers.js'
import { visitTaintSinkCandidates } from './ast-facts/taint-sinks.js'
import { visitLongFunctionAndComplexityCandidates } from './ast-facts/complexity.js'
import { visitBarrelsAndImports } from './ast-facts/barrels-imports.js'
import { visitEnvVarReads } from './ast-facts/env-usage.js'
import { visitEventListenerSiteCandidates } from './ast-facts/event-listeners.js'
import { visitHardcodedSecretCandidates } from './ast-facts/hardcoded-secrets.js'
import { visitConstantExpressionCandidates } from './ast-facts/constant-expressions.js'
import { visitTaintedArgumentCandidates } from './ast-facts/tainted-arguments.js'
import { visitEventEmitSiteCandidates } from './ast-facts/event-emit.js'
import { visitTaintedVarsCandidates } from './ast-facts/tainted-vars.js'
import { visitResourceImbalanceCandidates } from './ast-facts/resource-balance.js'
import { visitSecurityPatternsCandidates } from './ast-facts/security-patterns.js'
import { visitDriftPatternsCandidates } from './ast-facts/drift-patterns.js'
import { visitCodeQualityPatternsCandidates } from './ast-facts/code-quality.js'

export type { AstFactsBundle, BarrelFileFact, ImportEdgeFact }

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

export function extractAstFactsBundle(
  sf: SourceFile,
  relPath: string,
  rootDir: string = '',
): AstFactsBundle {
  const numericLiterals: NumericLiteralFact[] = []
  const binaryExpressions: BinaryExpressionFact[] = []
  const exemptionLines: ExemptionLineFact[] = []
  const fileTags: FileTagFact[] = []
  const callExpressions: CallExpressionFact[] = []
  const functionScopes: FunctionScopeFact[] = []
  const functionParams: FunctionParamFact[] = []
  const sanitizerCandidates: SanitizerCandidateFact[] = []
  const taintSinkCandidates: TaintSinkCandidateFact[] = []
  const longFunctionCandidates: LongFunctionCandidateFact[] = []
  const functionComplexities: FunctionComplexityFact[] = []
  const hardcodedSecretCandidates: HardcodedSecretCandidateFact[] = []
  const eventListenerSiteCandidates: EventListenerSiteCandidateFact[] = []
  const barrelFiles: BarrelFileFact[] = []
  const importEdges: ImportEdgeFact[] = []
  const envVarReads: EnvVarReadFact[] = []
  const constantExpressionCandidates: ConstantExpressionCandidateFact[] = []
  const taintedArgumentCandidates: TaintedArgumentCandidateFact[] = []
  const eventEmitSiteCandidates: EventEmitSiteCandidateFact[] = []
  const taintedVarDeclCandidates: TaintedVarDeclCandidateFact[] = []
  const taintedVarArgCallCandidates: TaintedVarArgCallCandidateFact[] = []
  const resourceImbalanceCandidates: ResourceImbalanceCandidateFact[] = []
  const secretVarRefCandidates: SecretVarRefCandidateFact[] = []
  const corsConfigCandidates: CorsConfigCandidateFact[] = []
  const tlsUnsafeCandidates: TlsUnsafeCandidateFact[] = []
  const weakRandomCandidates: WeakRandomCandidateFact[] = []
  const excessiveOptionalParamsCandidates: ExcessiveOptionalParamsCandidateFact[] = []
  const wrapperSuperfluousCandidates: WrapperSuperfluousCandidateFact[] = []
  const deepNestingCandidates: DeepNestingCandidateFact[] = []
  const emptyCatchNoCommentCandidates: EmptyCatchNoCommentCandidateFact[] = []
  const regexLiteralCandidates: RegexLiteralCandidateFact[] = []
  const tryCatchSwallowCandidates: TryCatchSwallowCandidateFact[] = []
  const awaitInLoopCandidates: AwaitInLoopCandidateFact[] = []
  const allocationInLoopCandidates: AllocationInLoopCandidateFact[] = []
  const deadCodeFindings: DeadCodeFindingFact[] = []

  const isTest = TEST_FILE_RE.test(relPath)
  if (isTest) fileTags.push({ file: relPath, tag: 'test' })

  // F-103 — émettre un tag pour les fichiers chargés par convention framework
  // (Next.js page/layout/route/proxy/instrumentation, Expo Router, configs
  // implicites, tests, scripts). Source de vérité unique : `isFrameworkEntryPoint`,
  // partagée avec `core/graph.ts#isEntryPoint()` et `extractors/unused-exports.ts`.
  // Sans ce tag, `composite-orphan-file.dl` flag tous ces fichiers comme dead
  // code car ils ne sont pas importés explicitement.
  if (isFrameworkEntryPoint(relPath)) {
    fileTags.push({ file: relPath, tag: 'framework-routed' })
  }

  visitNumericLiterals(sf, relPath, numericLiterals)
  visitBinaryExpressions(sf, relPath, binaryExpressions)
  visitExemptionMarkers(sf, relPath, exemptionLines)
  visitCallAndNewExpressions(sf, relPath, callExpressions)
  visitFunctionScopesAndParams(sf, relPath, functionScopes, functionParams)

  // Skip total si test file pour éviter les sets candidats inutiles.
  if (!isTest) {
    visitSanitizerCandidates(sf, relPath, sanitizerCandidates)
    visitTaintSinkCandidates(sf, relPath, taintSinkCandidates)
    visitLongFunctionAndComplexityCandidates(
      sf, relPath, longFunctionCandidates, functionComplexities,
    )
    visitHardcodedSecretCandidates(sf, relPath, hardcodedSecretCandidates)
    visitConstantExpressionCandidates(sf, relPath, constantExpressionCandidates)
    visitTaintedArgumentCandidates(sf, relPath, taintedArgumentCandidates)
    visitTaintedVarsCandidates(sf, relPath, taintedVarDeclCandidates, taintedVarArgCallCandidates)
    visitResourceImbalanceCandidates(sf, relPath, resourceImbalanceCandidates)
    visitSecurityPatternsCandidates(
      sf, relPath,
      secretVarRefCandidates, corsConfigCandidates,
      tlsUnsafeCandidates, weakRandomCandidates,
    )
    visitCodeQualityPatternsCandidates(
      sf, relPath,
      regexLiteralCandidates, tryCatchSwallowCandidates,
      awaitInLoopCandidates, allocationInLoopCandidates,
    )
    // ADR-026 A.4.2 — délégation legacy pour parité 100% sur 6 dead-code kinds.
    deadCodeFindings.push(...extractDeadCodeFileBundle(sf, relPath).findings)
  }
  // drift-patterns : own narrow regex, emit unconditionally.
  visitDriftPatternsCandidates(
    sf, relPath,
    excessiveOptionalParamsCandidates, wrapperSuperfluousCandidates,
    deepNestingCandidates, emptyCatchNoCommentCandidates,
  )
  // event-listener / emit / barrels / env-usage : pas de filtre test files (legacy).
  visitEventListenerSiteCandidates(sf, relPath, eventListenerSiteCandidates)
  visitEventEmitSiteCandidates(sf, relPath, eventEmitSiteCandidates)
  visitBarrelsAndImports(sf, relPath, rootDir, barrelFiles, importEdges)
  visitEnvVarReads(sf, relPath, envVarReads)

  return {
    numericLiterals, binaryExpressions, exemptionLines, fileTags,
    callExpressions, functionScopes, functionParams,
    sanitizerCandidates, taintSinkCandidates,
    longFunctionCandidates, functionComplexities,
    hardcodedSecretCandidates,
    eventListenerSiteCandidates,
    barrelFiles, importEdges, envVarReads,
    constantExpressionCandidates,
    taintedArgumentCandidates,
    eventEmitSiteCandidates,
    taintedVarDeclCandidates,
    taintedVarArgCallCandidates,
    resourceImbalanceCandidates,
    secretVarRefCandidates,
    corsConfigCandidates,
    tlsUnsafeCandidates,
    weakRandomCandidates,
    excessiveOptionalParamsCandidates,
    wrapperSuperfluousCandidates,
    deepNestingCandidates,
    emptyCatchNoCommentCandidates,
    regexLiteralCandidates,
    tryCatchSwallowCandidates,
    awaitInLoopCandidates,
    allocationInLoopCandidates,
    deadCodeFindings,
  }
}
