/**
 * Effect analysis (Niveau 5 self-optim) — décide automatiquement si un
 * détecteur est 1-pass (pure per-file) ou 2-pass (cross-file global state)
 * en analysant son source code via ts-morph.
 *
 * Méthode (reaching definitions analysis simplifiée) :
 *
 *   Pour chaque détecteur, on cherche :
 *     1. La signature de `extract<X>FileBundle(sf, relPath, ...args)`.
 *     2. Si elle prend > 2 args (au-delà de sf, relPath), c'est un signe
 *        fort de cross-file dependency (le 3e arg est typiquement le
 *        global state injecté par le caller).
 *     3. Dans le corps de `analyze<X>(rootDir, files, project)`, on
 *        compte les itérations sur `project.getSourceFiles()` :
 *          - 1 itération → 1-pass (concat-trivial)
 *          - 2+ itérations → 2-pass (premier pass collect global, second
 *            applique le global)
 *     4. On cherche aussi des accumulateurs `Set<string>` ou `Map<...>`
 *        construits entre les itérations — preuve de global state.
 *
 * Output : JSON par détecteur :
 *   {
 *     pattern: '1-pass' | '2-pass' | 'cross-snapshot' | 'unknown',
 *     globalStateVars: string[],
 *     synthesizable: boolean,    // 1-pass + concat-only Bundle
 *     reasoning: string
 *   }
 *
 * Permet à `synth-aggregation.ts` de DÉCIDER automatiquement :
 *   - 1-pass + concat-only → synth direct (déjà supporté)
 *   - 2-pass → synth avec décomposition declarationsOfFile + globalNames
 *     + sitesOfFile (pattern fait à la main pour deprecated-usage —
 *     généralisable)
 *   - cross-snapshot → fallback exempt (pattern fundamentalement non-
 *     cacheable per-file)
 *
 * Limites :
 *   - Heuristique syntactique, pas vraie reaching definitions sound.
 *   - Confond les itérations imbriquées avec 2-pass séquentiel.
 *   - Ne suit pas les call chains (si l'analyze délègue à un helper
 *     qui itère, c'est pas détecté).
 *
 * Précision attendue : ~85% sur les détecteurs codegraph (suffisant
 * pour décider "synthesizable yes/no" automatiquement, fallback humain
 * sur les cas ambigus).
 */

import { Project, SyntaxKind, type SourceFile, type FunctionDeclaration } from 'ts-morph'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

interface EffectProfile {
  detector: string
  pattern: '1-pass' | '2-pass' | 'cross-snapshot' | 'unknown'
  globalStateVars: string[]
  synthesizable: boolean
  reasoning: string
}

function pascal(kebab: string): string {
  return kebab.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
}

async function analyzeDetector(detector: string): Promise<EffectProfile> {
  const extractorPath = path.join(REPO_ROOT, `packages/codegraph/src/extractors/${detector}.ts`)
  let source: string
  try {
    source = await fs.readFile(extractorPath, 'utf-8')
  } catch {
    return {
      detector,
      pattern: 'unknown',
      globalStateVars: [],
      synthesizable: false,
      reasoning: 'extractor file not found',
    }
  }

  const project = new Project({ skipAddingFilesFromTsConfig: true })
  const sf = project.createSourceFile('temp.ts', source, { overwrite: true })

  const Pas = pascal(detector)
  const bundleFn = sf.getFunction(`extract${Pas}FileBundle`)
  const analyzeFn = sf.getFunction(`analyze${Pas}`)
  const computeFn = sf.getFunction(`compute${Pas}`)
  const orchestrator = analyzeFn ?? computeFn

  if (!orchestrator) {
    // Maybe it reads filesystem directly (cross-snapshot pattern).
    if (/readdir.*\.codegraph|snapshot-/i.test(source)) {
      return {
        detector,
        pattern: 'cross-snapshot',
        globalStateVars: [],
        synthesizable: false,
        reasoning: 'reads .codegraph/snapshot-*.json — cross-snapshot temporal pattern',
      }
    }
    return {
      detector,
      pattern: 'unknown',
      globalStateVars: [],
      synthesizable: false,
      reasoning: `no analyze${Pas}/compute${Pas} function found`,
    }
  }

  const orchSource = orchestrator.getText()

  // Count `for (const sf of project.getSourceFiles())` patterns.
  const sfLoopCount = (orchSource.match(/for\s*\(\s*const\s+\w+\s+of\s+\w+\.getSourceFiles\(\)/g) ?? []).length
  const filesLoopCount = (orchSource.match(/for\s*\(\s*const\s+\w+\s+of\s+files\)/g) ?? []).length
  const totalIterations = sfLoopCount + filesLoopCount

  // Detect global state accumulators (Set/Map between iterations).
  const setMapDecls = orchSource.match(/(?:const|let)\s+\w+\s*[:=]\s*(?:new\s+)?(?:Set|Map)<[^>]*>/g) ?? []
  const globalStateVars = setMapDecls
    .map((d) => d.match(/(?:const|let)\s+(\w+)/)?.[1])
    .filter((x): x is string => Boolean(x))

  // Bundle fn signature : if takes > 2 args (beyond sf, relPath),
  // the extra arg is likely global state.
  const bundleArgs = bundleFn ? bundleFn.getParameters().length : 0
  const usesGlobalState = bundleArgs > 2 || globalStateVars.length > 0

  if (totalIterations >= 2 && usesGlobalState) {
    return {
      detector,
      pattern: '2-pass',
      globalStateVars,
      synthesizable: true,                                                // synthesizable via decompose pattern
      reasoning: `${totalIterations} iterations on project.getSourceFiles()/files + ${globalStateVars.length} global state Set/Map vars + bundle takes ${bundleArgs} args (suggests cross-file dep)`,
    }
  }

  if (totalIterations >= 1 && !usesGlobalState) {
    return {
      detector,
      pattern: '1-pass',
      globalStateVars: [],
      synthesizable: true,
      reasoning: `${totalIterations} iteration(s), no global state — pure per-file concat pattern`,
    }
  }

  if (totalIterations === 0) {
    return {
      detector,
      pattern: 'unknown',
      globalStateVars,
      synthesizable: false,
      reasoning: 'no project.getSourceFiles() loop found — may delegate to helper or be non-standard',
    }
  }

  return {
    detector,
    pattern: 'unknown',
    globalStateVars,
    synthesizable: false,
    reasoning: 'mixed signals — manual review needed',
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (arg && arg !== '--all') {
    const profile = await analyzeDetector(arg)
    console.log(JSON.stringify(profile, null, 2))
    return
  }

  // --all : analyze tous les détecteurs disponibles
  const extractorsDir = path.join(REPO_ROOT, 'packages/codegraph/src/extractors')
  const entries = await fs.readdir(extractorsDir)
  const detectors = entries
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.replace(/\.ts$/, ''))
    .filter((n) => !n.startsWith('_'))                                     // skip _shared

  console.log('detector'.padEnd(36) + 'pattern'.padStart(16) + 'synth?'.padStart(10))
  console.log('─'.repeat(62))
  const profiles: EffectProfile[] = []
  for (const d of detectors.sort()) {
    const p = await analyzeDetector(d)
    profiles.push(p)
    const synth = p.synthesizable ? '✓' : '✗'
    console.log(`${d.padEnd(34)}${p.pattern.padStart(18)}${synth.padStart(10)}`)
  }

  console.log()
  console.log('Pattern distribution :')
  const counts: Record<string, number> = {}
  for (const p of profiles) counts[p.pattern] = (counts[p.pattern] ?? 0) + 1
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`)
  }
  const synthCount = profiles.filter((p) => p.synthesizable).length
  console.log(`  → synthesizable : ${synthCount}/${profiles.length} (${Math.round(synthCount / profiles.length * 100)}%)`)
}

main().catch((err) => {
  console.error('effect-analysis fatal:', err)
  process.exit(1)
})
