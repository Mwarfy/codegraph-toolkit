// ADR-011
/**
 * Auto-bootstrap entry point — pour usage via `NODE_OPTIONS=--require`.
 *
 * Quand le driver `replay-tests` lance un sub-process (vitest, jest,
 * node script), on ne peut pas modifier son code pour appeler
 * `attachRuntimeCapture()` manuellement. Solution :
 *
 *   NODE_OPTIONS="--require @liby-tools/runtime-graph/capture/auto" \
 *   LIBY_RUNTIME_PROJECT_ROOT=/path/to/project \
 *   LIBY_RUNTIME_FACTS_OUT=/tmp/facts-runtime \
 *     npx vitest run
 *
 * Ce module :
 *   1. Attache la capture OTel au démarrage du process Node
 *   2. Hook process.on('exit') pour flush + export les facts
 *   3. Écrit les facts vers $LIBY_RUNTIME_FACTS_OUT (ou défaut)
 *
 * Le driver parent lit ensuite les facts et merge avec ses propres.
 */

import * as path from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'
import { register } from 'node:module'
import { attachRuntimeCapture } from './otel-attach.js'
import { aggregateSpans } from './span-aggregator.js'
import { startCpuProfile, aggregateProfile, type CpuProfileHandle } from './cpu-profile.js'

// CRITIQUE — register le ESM loader hook AVANT tout `attachRuntimeCapture`.
//
// Les auto-instruments OTel (pg, http, redis, …) utilisent require-in-the-middle
// pour patcher `require()` côté CJS. Sur un projet `"type": "module"` qui charge
// pg via `import pg from 'pg'`, le hook CJS NE VOIT PAS l'import → 0 span.
//
// Le package `@opentelemetry/instrumentation` ≥ 0.40 ship un ESM loader
// (`hook.mjs`) qui s'enregistre via `module.register()` (Node ≥ 20.6) et
// patch les imports ESM. Sans ça, les auto-instruments sont silently dead
// sur tout projet ESM moderne.
//
// Cas vécu Sentinel 2026-05-03 : 3 runs probe → RuntimeRunMeta=1, autres
// facts à 0 lignes. Cause = ce gap. Cf. EXTERNAL-VALIDATION run #1 Hono
// FULL CHAIN (même symptôme côté replay-tests).
//
// On enregistre `import-in-the-middle/hook.mjs` directement (et pas
// `@opentelemetry/instrumentation/hook.mjs` qui est un re-export legacy
// avec l'ancienne API du loader Node — getFormat/getSource — qui crash
// sur Node 22 avec `register()`). iitm est la lib que OTel utilise sous
// le capot ; on bypass juste le wrapper cassé.
try {
  register('import-in-the-middle/hook.mjs', import.meta.url)
} catch {
  // Hook unavailable — auto-instruments resteront sur le path require-in-the-middle
  // (utile pour projets CJS uniquement).
}

const projectRoot = process.env.LIBY_RUNTIME_PROJECT_ROOT ?? process.cwd()
// Sub-dir par PID pour éviter qu'un parent process (ex: npm test) n'écrase
// les facts d'un child (ex: node app.js). Chaque process loaded via
// NODE_OPTIONS=--require écrit dans son propre sub-dir. Le CLI parent
// merge tous les sub-dirs après driver.run() (cf. mergeFactsDirs).
const factsOutBase = process.env.LIBY_RUNTIME_FACTS_OUT
  ?? path.join(projectRoot, '.codegraph/facts-runtime-bootstrap')
const factsOutDir = path.join(factsOutBase, `pid-${process.pid}`)

const startedAtUnix = Math.floor(Date.now() / 1000)
const startTime = Date.now()

// Attach immédiatement au load — pas de lazy init (sinon les modules
// importés AVANT ce require manqueraient l'auto-instrument hooks).
const capture = attachRuntimeCapture({
  projectRoot,
  // Pour replay-tests on veut auto-instrument actif (pour capturer
  // les calls HTTP/DB exécutés par les tests), MAIS l'utilisateur peut
  // override via env si tests pure-fonction.
  enableAutoInstruments: process.env.LIBY_RUNTIME_AUTO_INSTRUMENTS !== 'false',
})

// CPU profile opt-in : LIBY_RUNTIME_CPU_PROFILE=1 → V8 sampling profiler
// démarre en parallèle d'OTel. Capture les hot paths + call edges du code
// applicatif pendant le run (pas juste les I/O). Crucial pour les apps
// pure-CPU où OTel ne voit rien (analyzers, transformers, batch jobs).
//
// Coût ~5-10% overhead pendant le run. Skip par défaut pour pas pénaliser
// les apps qui veulent juste les spans I/O.
let cpuProfileHandle: CpuProfileHandle | null = null
if (process.env.LIBY_RUNTIME_CPU_PROFILE === '1') {
  // Best-effort — si l'inspector module fail (env CI restrictif, etc.),
  // on continue avec la capture OTel seule.
  startCpuProfile().then((h) => { cpuProfileHandle = h }).catch(() => undefined)
}

// Sur exit, flush + write facts. Best-effort — si crash, capture peek
// quand même via signal handlers en β2 (Phase α : exit-only suffisant).
//
// IMPORTANT — on écrit TOUJOURS RuntimeRunMeta même avec 0 spans, pour
// que le caller ait un signal "bootstrap a tourné, voici le résultat
// (peut-être vide)" plutôt qu'un dossier vide indiscernable de "bootstrap
// pas chargé du tout".
const flushOnExit = (): void => {
  try {
    // Synchronous read avant shutdown (cf. bug fix commit ca252d2).
    const spans = capture.peek()
    const elapsedMs = Date.now() - startTime
    const snapshot = aggregateSpans(spans, {
      projectRoot,
      runMeta: {
        driver: 'auto-bootstrap',
        startedAtUnix,
        durationMs: elapsedMs,
        totalSpans: spans.length,
      },
    })

    // Synchronous write (process.on('exit') ne supporte pas async).
    // Le aggregator est sync, l'exporter écrit fs synchronously ici.
    mkdirSync(factsOutDir, { recursive: true })

    // Inline TSV serialization sync pour respecter le exit hook.
    // Le format match exporter.ts (mais sync pour exit handler).
    writeRelationSync(factsOutDir, 'SymbolTouchedRuntime',
      snapshot.symbolsTouched.map(s => [s.file, s.fn, String(s.count), String(s.p95LatencyMs)]))
    writeRelationSync(factsOutDir, 'HttpRouteHit',
      snapshot.httpRouteHits.map(h => [h.method, h.path, String(h.status), String(h.count), String(h.p95LatencyMs)]))
    writeRelationSync(factsOutDir, 'DbQueryExecuted',
      snapshot.dbQueriesExecuted.map(d => [d.table, d.op, String(d.count), String(d.lastAtUnix)]))
    writeRelationSync(factsOutDir, 'RedisOpExecuted',
      snapshot.redisOps.map(r => [r.op, r.keyPattern, String(r.count)]))
    writeRelationSync(factsOutDir, 'EventEmittedAtRuntime',
      snapshot.eventsEmitted.map(e => [e.type, String(e.count), String(e.lastAtUnix)]))
    writeRelationSync(factsOutDir, 'CallEdgeRuntime',
      snapshot.callEdges.map(c => [c.fromFile, c.fromFn, c.toFile, c.toFn, String(c.count)]))
    writeRelationSync(factsOutDir, 'RuntimeRunMeta', [[
      snapshot.meta.driver,
      String(snapshot.meta.startedAtUnix),
      String(snapshot.meta.durationMs),
      String(snapshot.meta.totalSpans),
    ]])
  } catch {
    // Best-effort — un crash dans le hook exit ne doit pas masquer
    // l'erreur originale du process observé.
  }
}

// Async flush du CPU profile via beforeExit (process.on('exit') est sync, ne
// supporte pas await — l'inspector.stop() est async). beforeExit fire sur
// natural exit (script termine main scope). Pas appelé sur process.exit()
// explicit — pour ces cas, set LIBY_SKIP_CPU_PROFILE=1 ou déclencher manuellement.
let cpuFlushed = false
async function flushCpuProfile(): Promise<void> {
  if (cpuFlushed || !cpuProfileHandle) return
  cpuFlushed = true
  try {
    const profile = await cpuProfileHandle.stop()
    const facts = aggregateProfile(profile, { projectRoot })
    mkdirSync(factsOutDir, { recursive: true })
    writeRelationSync(factsOutDir, 'SymbolTouchedRuntime',
      facts.symbolsTouched.map((s) => [s.file, s.fn, String(s.count), String(s.p95LatencyMs)]))
    writeRelationSync(factsOutDir, 'CallEdgeRuntime',
      facts.callEdges.map((e) => [e.fromFile, e.fromFn, e.toFile, e.toFn, String(e.count)]))
  } catch {
    // CPU profile stop failed — keep OTel facts intact.
  }
}

function writeRelationSync(dir: string, name: string, rows: string[][]): void {
  const lines = rows.map(cols => cols.join('\t').replace(/[\n\r]/g, ' '))
  lines.sort()
  writeFileSync(
    path.join(dir, `${name}.facts`),
    lines.length > 0 ? lines.join('\n') + '\n' : '',
    'utf-8',
  )
}

process.on('exit', flushOnExit)
// beforeExit pour les async work (CPU profile stop). Fire sur natural exit
// uniquement (pas process.exit). Pour les apps qui exit explicitement,
// override via LIBY_SKIP_CPU_PROFILE=1.
process.on('beforeExit', () => { void flushCpuProfile() })
// Pour les SIGINT/SIGTERM qui contournent process.on('exit'), forcer le flush.
process.on('SIGINT', () => { flushOnExit(); process.exit(130) })
process.on('SIGTERM', () => { flushOnExit(); process.exit(143) })
