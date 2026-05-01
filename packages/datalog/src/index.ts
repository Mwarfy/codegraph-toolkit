/**
 * @liby-tools/datalog — public API.
 *
 * Three layers, each independently importable :
 *   - `parse(src)` : `.dl` → AST
 *   - `loadFacts(decls, factsByRelation)` : init Database depuis TSV
 *   - `evaluate(program, db, opts)` : RunResult typé avec proofs optionnels
 *
 * Et un orchestrateur `runFromDirs({ rulesDir, factsDir })` qui assemble
 * les trois pour le cas commun (rules dans un dossier, facts dans un autre).
 */

export { parse } from './parser.js'
export type { ParseOptions } from './parser.js'

export { loadFacts, loadFactsFromDir, insertTuple } from './facts-loader.js'
export type { LoadFactsOptions } from './facts-loader.js'

export { stratify } from './stratify.js'
export type { Stratum, StratifyOptions } from './stratify.js'

export { evaluate, formatProof } from './eval.js'
export type { EvalOptions } from './eval.js'

export {
  runFromDirs, runFromString, loadProgramFromDir, loadProgramFromDirs,
  mergePrograms, formatRunResult,
} from './runner.js'
export type { RunFromDirsOptions, FormatRunOptions } from './runner.js'

export {
  encodeValue, tupleKey, tupleHash,
  compareTuples, compareValues, sortTuples,
} from './canonical.js'

export {
  DatalogError,
} from './types.js'
export type {
  DatalogValue, Term, Atom, ColumnType, ColumnDecl, RelationDecl,
  Rule, Program, SourcePos,
  Tuple, Relation, Database,
  Provenance, ProofNode,
  RunResult,
} from './types.js'
