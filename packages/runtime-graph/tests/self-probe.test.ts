/**
 * Self-probe : end-to-end test on the toolkit itself.
 *
 * Pipeline complet :
 *   1. Attach OTel
 *   2. Exerce l'API publique de @liby-tools/datalog (parse + run + format)
 *   3. Stop capture
 *   4. Aggregate spans → RuntimeSnapshot
 *   5. Export facts → tmpDir
 *   6. Run rules (datalog) avec facts statiques du toolkit + facts runtime
 *   7. Assert : pipeline complet, pas d'erreur. Inspecte les alertes.
 *
 * Le test ne valide PAS qu'il y ait 0 alertes — il valide que la pipeline
 * tourne. Les alertes sortantes sont documentées dans le rapport.
 *
 * Exécuté en CI à chaque push : régression de la pipeline détectée
 * immédiatement (vs un MVP qui marcherait seulement en dev).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { attachRuntimeCapture } from '../src/capture/otel-attach.js'
import { aggregateSpans } from '../src/capture/span-aggregator.js'
import { exportFactsRuntime } from '../src/facts/exporter.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const TOOLKIT_ROOT = path.resolve(__dirname, '../../..')

let tmpFactsDir: string

beforeAll(async () => {
  tmpFactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rg-self-probe-'))
})

afterAll(async () => {
  await fs.rm(tmpFactsDir, { recursive: true, force: true })
})

describe('Phase α self-probe — end-to-end on toolkit itself', () => {
  it('captures spans, exports facts, runs rules — full pipeline', async () => {
    // ─── 1. Attach OTel ─────────────────────────────────────────────
    const capture = attachRuntimeCapture({
      projectRoot: TOOLKIT_ROOT,
      // Désactive auto-instruments pour ce test : on capture uniquement
      // les spans manuels (tracer.startActiveSpan). Évite l'overhead +
      // les éventuelles incompatibilités auto-instruments en test env.
      enableAutoInstruments: false,
    })
    expect(capture).toBeDefined()
    expect(capture.projectRoot).toBe(TOOLKIT_ROOT)

    const startedAtUnix = Math.floor(Date.now() / 1000)
    const t0 = Date.now()

    // ─── 2. Exerce l'API toolkit ────────────────────────────────────
    // Datalog parse + eval — le path le plus représentatif pour un
    // run runtime-graph (les datalog rules sont au cœur de la valeur).
    //
    // On crée une trace span explicite pour avoir un span avec
    // code.filepath/code.function attributes — sinon OTel auto-instrument
    // Node ne capture que les spans HTTP/DB/etc. (qu'on n'a pas ici).
    const tracer = capture.tracerProvider.getTracer('@liby-tools/runtime-graph/self-probe')
    await tracer.startActiveSpan('self-probe:exercise-datalog', async (span) => {
      span.setAttribute('code.filepath', path.join(TOOLKIT_ROOT, 'packages/runtime-graph/tests/self-probe.test.ts'))
      span.setAttribute('code.function', 'exerciseDatalog')
      try {
        const datalog = await import('@liby-tools/datalog')

        // Parse a minimal program (datalog.parse takes a single string source)
        await tracer.startActiveSpan('datalog:parse', async (s) => {
          s.setAttribute('code.filepath', path.join(TOOLKIT_ROOT, 'packages/datalog/src/parser.ts'))
          s.setAttribute('code.function', 'parse')
          datalog.parse(`
            .decl Foo(x: symbol, y: number)
            .input Foo
            .decl Result(x: symbol)
            .output Result
            Result(X) :- Foo(X, _).
          `)
          s.end()
        })

        // Run a tiny program with inline facts via runFromString
        await tracer.startActiveSpan('datalog:runFromString', async (s) => {
          s.setAttribute('code.filepath', path.join(TOOLKIT_ROOT, 'packages/datalog/src/runner.ts'))
          s.setAttribute('code.function', 'runFromString')
          datalog.runFromString({
            rules: `
              .decl Foo(x: symbol, y: number)
              .input Foo
              .decl Bar(x: symbol)
              .output Bar
              Bar(X) :- Foo(X, N), N > 0.
            `,
            facts: new Map([['Foo', [['a', 1], ['b', 0], ['c', 5]]]]),
          })
          s.end()
        })
      } finally {
        span.end()
      }
    })

    // ─── 3. Stop capture ────────────────────────────────────────────
    // Debug : peek before stop
    const peeked = capture.peek()
    if (peeked.length === 0) {
      console.log('[self-probe DEBUG] 0 spans peeked. Provider:', capture.tracerProvider.constructor?.name)
    }
    const spans = await capture.stop()
    const elapsedMs = Date.now() - t0
    expect(spans.length).toBeGreaterThan(0)

    // ─── 4. Aggregate spans → RuntimeSnapshot ───────────────────────
    const snapshot = aggregateSpans(spans, {
      projectRoot: TOOLKIT_ROOT,
      runMeta: {
        driver: 'self-probe',
        startedAtUnix,
        durationMs: elapsedMs,
        totalSpans: spans.length,
      },
    })

    // We MUST have caught our explicit spans
    const exerciseSym = snapshot.symbolsTouched.find(s => s.fn === 'exerciseDatalog')
    expect(exerciseSym, 'self-probe span captured').toBeDefined()
    expect(exerciseSym!.file).toContain('runtime-graph')

    // We MUST have caught the toolkit datalog spans we explicitly traced
    const parseSym = snapshot.symbolsTouched.find(s => s.fn === 'parse')
    expect(parseSym, 'datalog parse span captured').toBeDefined()
    expect(parseSym!.file).toContain('packages/datalog')

    const runFromStringSym = snapshot.symbolsTouched.find(s => s.fn === 'runFromString')
    expect(runFromStringSym, 'datalog runFromString span captured').toBeDefined()

    // ─── 5. Export facts → tmpDir ───────────────────────────────────
    const exportResult = await exportFactsRuntime(snapshot, { outDir: tmpFactsDir })
    expect(exportResult.relations).toHaveLength(7)

    // RuntimeRuleExempt empty file (CLI-side helper not in lib path)
    await fs.writeFile(path.join(tmpFactsDir, 'RuntimeRuleExempt.facts'), '', 'utf-8')
    // Empty RuntimeRouteExpected (no HTTP routes in toolkit pure-CLI codebase)
    await fs.writeFile(path.join(tmpFactsDir, 'RuntimeRouteExpected.facts'), '', 'utf-8')

    // Verify TSV format on a known fact
    const symFacts = await fs.readFile(path.join(tmpFactsDir, 'SymbolTouchedRuntime.facts'), 'utf-8')
    expect(symFacts.length).toBeGreaterThan(0)
    expect(symFacts).toContain('exerciseDatalog')

    // ─── 6. Run rules (datalog) ─────────────────────────────────────
    // Merge static facts (toolkit's own .codegraph/facts/) into tmpFactsDir
    const staticFactsDir = path.join(TOOLKIT_ROOT, '.codegraph/facts')
    const hasStatic = await dirExists(staticFactsDir)
    if (!hasStatic) {
      // Skip rules execution — toolkit hasn't been analyzed yet.
      // The full pipeline test (capture + export) is what matters.
      return
    }

    const staticFiles = await fs.readdir(staticFactsDir)
    for (const f of staticFiles) {
      if (!f.endsWith('.facts')) continue
      const dst = path.join(tmpFactsDir, f)
      try { await fs.access(dst); continue } catch { /* fall through */ }
      await fs.copyFile(path.join(staticFactsDir, f), dst)
    }

    const datalog = await import('@liby-tools/datalog')
    // Rules dir is bundled as a sibling of `src/` and `dist/` in the package.
    // From tests/self-probe.test.ts → ../rules
    const rulesDir = path.resolve(__dirname, '../rules')

    const { result } = await datalog.runFromDirs({
      rulesDir,
      factsDir: tmpFactsDir,
      recordProofsFor: ['RuntimeAlert'],
      allowRecursion: false,
    })

    // ─── 7. Assert pipeline ran. Document alerts. ──────────────────
    const alerts = result.outputs.get('RuntimeAlert') ?? []

    // Categorize for visibility (ne pas asserter 0 alertes — c'est documentation,
    // pas validation de "pas de problème dans le toolkit")
    const byCategory = new Map<string, number>()
    for (const tuple of alerts) {
      const cat = String(tuple[0])
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1)
    }

    // Pipeline OK — at least the rules engine ran without datalog errors
    // (un mauvais .dl provoquerait un throw de runFromDirs, pas un return).
    expect(typeof alerts).toBe('object')

    // Print categories for visibility (console output captured by vitest)
    if (alerts.length > 0) {
      console.log('[self-probe] runtime alerts categories:')
      for (const [cat, n] of byCategory) {
        console.log(`  ${cat.padEnd(24)} ${n}`)
      }
    }
  }, 30_000)
})

async function dirExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true } catch { return false }
}
