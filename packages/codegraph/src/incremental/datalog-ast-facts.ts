// ADR-026 phase C — Salsa cache du runner Datalog (visitor per-file)
/**
 * Le runner Datalog (`runDatalogDetectors`) re-walke tous les `SourceFile`
 * du Project ts-morph à chaque `analyze()`. Sur Sentinel (220 fichiers),
 * cet `extractMs` représente ~2800ms du wall clock. La Salsa-isation
 * per-file permet :
 *
 *   - Cold path : identique au runner non-cached (un walk complet)
 *   - Warm path zero-change : 0 walk (toutes les cells hit)
 *   - Warm path 1 fichier modifié : 1 walk (la cell de ce fichier
 *     invalidate via dep tracking sur `fileContent`)
 *
 * L'évaluation Datalog (parse + loadFacts + evaluate) reste
 * non-cachée pour l'instant — Phase C.2 plus tard. La part dominante du
 * coût est le walk AST, pas le moteur Datalog (170ms eval / 2800ms
 * extract sur Sentinel).
 *
 * Inspiration : `incremental/magic-numbers.ts`, `incremental/dead-code.ts`.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractAstFactsBundle,
  type AstFactsBundle,
} from '../datalog-detectors/ast-facts-visitor.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Bundle vide de référence — retourné si SourceFile absent du Project. */
const EMPTY_BUNDLE: AstFactsBundle = {
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

/**
 * Per-file bundle — caché sur fileContent. Retourne tous les tuples
 * primitifs émis par le visitor pour CE fichier. Le runner aggrège
 * ensuite les bundles cross-file pour alimenter le moteur Datalog.
 */
export const astFactsOfFile = derived<string, AstFactsBundle>(
  db,
  'astFactsOfFile',
  (filePath) => {
    fileContent.get(filePath)  // dep tracking — invalidate si content change
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return EMPTY_BUNDLE
    return extractAstFactsBundle(sf, filePath, rootDir)
  },
)

/**
 * Helper qui aggrège les bundles per-file en un seul AstFactsBundle plat.
 * À appeler à la place du loop in-runner quand le mode incremental est
 * actif. Cold path : identique au runner ; warm path : tous les
 * `astFactsOfFile.get(...)` hit cache.
 */
export function aggregateAstFactsIncremental(label: string): AstFactsBundle {
  const files = projectFiles.get(label)
  // Init avec un bundle vide structurellement — clone pour éviter aliasing
  // sur EMPTY_BUNDLE.
  const merged: AstFactsBundle = {
    numericLiterals: [], binaryExpressions: [], exemptionLines: [],
    fileTags: [], callExpressions: [], functionScopes: [], functionParams: [],
    sanitizerCandidates: [], taintSinkCandidates: [], longFunctionCandidates: [],
    functionComplexities: [], hardcodedSecretCandidates: [],
    eventListenerSiteCandidates: [], barrelFiles: [], importEdges: [],
    envVarReads: [], constantExpressionCandidates: [], taintedArgumentCandidates: [],
    eventEmitSiteCandidates: [], taintedVarDeclCandidates: [],
    taintedVarArgCallCandidates: [], resourceImbalanceCandidates: [],
    secretVarRefCandidates: [], corsConfigCandidates: [], tlsUnsafeCandidates: [],
    weakRandomCandidates: [], excessiveOptionalParamsCandidates: [],
    wrapperSuperfluousCandidates: [], deepNestingCandidates: [],
    emptyCatchNoCommentCandidates: [], regexLiteralCandidates: [],
    tryCatchSwallowCandidates: [], awaitInLoopCandidates: [],
    allocationInLoopCandidates: [], deadCodeFindings: [],
  }
  for (const f of files) {
    const b = astFactsOfFile.get(f)
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
