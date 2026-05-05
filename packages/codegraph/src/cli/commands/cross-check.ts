// ADR-026 phase D — CLI cross-check (statique × dynamique unifié)
/**
 * `codegraph cross-check` charge les facts statique (`.codegraph/facts/`)
 * + facts dynamique (`.codegraph/facts-runtime/`) + une dir de rules `.dl`
 * et évalue le tout via le composite runner avec cache module-level.
 *
 * Diffère de `datalog-check` (existant) :
 *   - datalog-check : facts statique seuls, rules invariants du repo
 *   - cross-check   : statique × dynamique, rules cross-cut joining
 *     SymbolTouchedRuntime / HttpRouteHit / etc. avec ExportedFunction /
 *     CycleNode / ImportEdge / etc.
 *
 * Workflow typique :
 *   1. `codegraph analyze`              → .codegraph/facts/*.facts
 *   2. `liby-runtime-graph run`          → .codegraph/facts-runtime/*.facts
 *   3. `codegraph cross-check rules-dir` → DEAD_HANDLER, DEAD_ROUTE,
 *                                          HOT_PATH_UNTESTED, etc.
 *
 * En mode watcher unifié (programmatique) le caller peut bypass cette CLI
 * et appeler directement `runCompositeRules` après `setRuntimeFacts`.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import chalk from 'chalk'
import { runCompositeRules } from '../../datalog-detectors/composite-runner.js'

export interface CrossCheckOpts {
  rulesDir?: string
  factsDir?: string
  factsRuntimeDir?: string
  json?: boolean
  /** Sortie verbose : print stats cache hit + tuples in/out. */
  verbose?: boolean
}

interface ViolationOut {
  rule: string
  args: readonly unknown[]
}

export async function runCrossCheckCommand(opts: CrossCheckOpts): Promise<void> {
  const root = process.cwd()
  const rulesDir = opts.rulesDir ?? path.join(root, '.codegraph/rules-cross-cut')
  const factsDir = opts.factsDir ?? path.join(root, '.codegraph/facts')
  const factsRuntimeDir = opts.factsRuntimeDir ?? path.join(root, '.codegraph/facts-runtime')

  // 1. Charge les rules .dl
  const rulesDl = await loadRulesDir(rulesDir)
  if (rulesDl.length === 0) {
    if (!opts.json) {
      console.error(chalk.yellow(`⚠ no .dl rule found in ${rulesDir}`))
    } else {
      console.log(JSON.stringify({ violations: [], stats: { rulesLoaded: 0 } }))
    }
    return
  }

  // 2. Charge facts statique + runtime → Map<RelationName, TSV>
  const staticFacts = await loadFactsDir(factsDir)
  const runtimeFacts = await loadFactsDir(factsRuntimeDir)

  // 3. Merge (relations sans collision attendue — schemas disjoints)
  const merged = new Map<string, string>(staticFacts)
  for (const [name, tsv] of runtimeFacts) {
    const existing = merged.get(name)
    merged.set(name, existing && existing.length > 0 ? `${existing}\n${tsv}` : tsv)
  }

  // 4. Évalue via composite runner.
  // `includeRuntime: false` car on a déjà mergé les facts disque dans
  // `staticFactsByRelation` ; on ne veut pas double-load la cell Salsa
  // (qui pourrait être vide en CLI standalone, ou désynchro).
  const result = runCompositeRules({
    rulesDl,
    staticFactsByRelation: merged,
    includeRuntime: false,
  })

  // 5. Émet violations
  const violations: ViolationOut[] = []
  for (const [rule, tuples] of result.outputs) {
    for (const t of tuples) {
      violations.push({ rule, args: t })
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      violations,
      stats: {
        cacheHit: result.stats.cacheHit,
        durationMs: Math.round(result.stats.durationMs * 100) / 100,
        tuplesIn: result.stats.tuplesIn,
        tuplesOut: result.stats.tuplesOut,
        rulesLoaded: countRules(rulesDl),
      },
    }))
    return
  }

  // Texte humain
  console.log(chalk.bold(`cross-check : ${violations.length} violation(s)`))
  console.log(chalk.dim(
    `  rules=${countRules(rulesDl)} static=${staticFacts.size}rel runtime=${runtimeFacts.size}rel ` +
    `tuplesIn=${result.stats.tuplesIn} ${result.stats.cacheHit ? '✓ cache hit' : '⊘ cache miss'} ` +
    `${result.stats.durationMs.toFixed(1)}ms`,
  ))
  if (violations.length === 0) {
    console.log(chalk.green('  ✓ aucune violation'))
    return
  }
  for (const v of violations.slice(0, 20)) {
    console.log(`  ${chalk.red('✗')} ${chalk.bold(v.rule)}  ${v.args.join('  ')}`)
  }
  if (violations.length > 20) {
    console.log(chalk.dim(`  (+${violations.length - 20} more — use --json for full)`))
  }
  if (opts.verbose) {
    console.log(chalk.dim(`\nstats : cacheHit=${result.stats.cacheHit} tuplesOut=${result.stats.tuplesOut}`))
  }
}

/**
 * Charge tous les `.dl` d'un dir, concat. Le moteur Datalog accepte
 * plusieurs déclarations dans un seul source ; pas besoin de ranger.
 * Skip silent les fichiers qui ne se lisent pas (permissions etc.).
 */
async function loadRulesDir(dir: string): Promise<string> {
  let entries
  try {
    entries = await fs.readdir(dir)
  } catch {
    return ''
  }
  const dlFiles = entries.filter((f) => f.endsWith('.dl')).sort()
  // Lecture parallèle — fichiers indépendants, ordre préservé via index.
  const contents = await Promise.all(
    dlFiles.map(async (f) => {
      try {
        return { f, content: await fs.readFile(path.join(dir, f), 'utf-8') }
      } catch {
        return null
      }
    }),
  )
  const parts: string[] = []
  for (const entry of contents) {
    if (!entry) continue
    parts.push(`// ─── ${entry.f} ───`)
    parts.push(entry.content)
  }
  return parts.join('\n')
}

/**
 * Charge tous les `.facts` d'un dir en `Map<RelationName, TSV>`. Le nom
 * de la relation est dérivé du basename du fichier (sans extension).
 *
 * Format attendu : 1 tuple par ligne, colonnes séparées par TAB
 * (convention `@liby-tools/codegraph` + `@liby-tools/runtime-graph`).
 */
async function loadFactsDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let entries
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }
  const factsFiles = entries.filter((f) => f.endsWith('.facts'))
  // Lecture parallèle — fichiers indépendants, set sur Map après resolve.
  const reads = await Promise.all(
    factsFiles.map(async (f) => {
      const relName = f.replace(/\.facts$/, '')
      try {
        const content = await fs.readFile(path.join(dir, f), 'utf-8')
        return { relName, content: content.replace(/\n+$/, '') }
      } catch {
        return null
      }
    }),
  )
  for (const r of reads) if (r) out.set(r.relName, r.content)
  return out
}

/** Compte les `.decl` non-input dans la rulesDl (heuristique). */
function countRules(rulesDl: string): number {
  let count = 0
  for (const line of rulesDl.split('\n')) {
    if (line.match(/^\s*[A-Z][A-Za-z0-9_]*\([^)]*\)\s*:-/)) count++
  }
  return count
}
