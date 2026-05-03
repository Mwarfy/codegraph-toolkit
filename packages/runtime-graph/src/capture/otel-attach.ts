/**
 * OTel auto-instrumentation attach + in-memory span collection.
 *
 * Phase α design : on n'exporte PAS vers Jaeger/Tempo/etc. — les spans
 * sont collectés en mémoire et passés au span-aggregator qui projette
 * vers les facts datalog. Pas d'infra externe nécessaire pour le MVP.
 *
 * Pourquoi ce choix :
 *   1. Pas de dépendance opérationnelle (collector, backend storage)
 *   2. Run synthetic typiquement < 10min → mémoire bornée
 *   3. Permet d'ajouter exporter externe en β sans casser l'API α
 *
 * Pattern d'usage côté projet observé :
 *   import { attachRuntimeCapture } from '@liby-tools/runtime-graph/capture'
 *   const capture = attachRuntimeCapture({ projectRoot: __dirname })
 *   // ... laisser tourner / driver pousse du trafic ...
 *   const snapshot = await capture.stop()                  // → RuntimeSnapshot
 *
 * Ou en mode CLI auto-attach :
 *   NODE_OPTIONS="--require @liby-tools/runtime-graph/capture/auto" node app.js
 *   (variant à implémenter post-α)
 */

import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { RuntimeGraphError } from '../core/types.js'

export interface AttachOptions {
  /** Path racine du projet observé. Sert à filtrer les spans (file ∈ projectRoot only). */
  projectRoot: string
  /** Sample rate 0..1. Default 1.0 (tout capturer). */
  sampleRate?: number
  /** Paths HTTP à exclure (health checks, metrics endpoints). */
  excludePaths?: string[]
  /** Packages npm à exclure de l'auto-instrument. */
  excludePackages?: string[]
}

export interface CaptureHandle {
  /** Snapshot non-fini : utile pour debug en cours de run. */
  peek(): ReadableSpan[]
  /** Arrête la capture et retourne tous les spans collectés. */
  stop(): Promise<ReadableSpan[]>
  /** Path projet (utile pour aggregator). */
  projectRoot: string
}

/**
 * Attache OTel auto-instrument au runtime Node courant.
 * IDEMPOTENT : un seul SDK par process. Multiple appels retournent le handle existant.
 */
let _activeHandle: CaptureHandle | null = null

export function attachRuntimeCapture(opts: AttachOptions): CaptureHandle {
  if (_activeHandle) {
    return _activeHandle
  }

  const exporter = new InMemorySpanExporter()
  const processor = new SimpleSpanProcessor(exporter)

  // Auto-instruments par défaut : http, pg, ioredis, mongodb, mysql2, etc.
  // On désactive ceux qui pourraient overheaders en α (ex: fs).
  const instrumentations = getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-dns': { enabled: false },
    // HTTP avec exclude paths configurables
    '@opentelemetry/instrumentation-http': {
      ignoreIncomingRequestHook: (req) => {
        const url = req.url ?? ''
        return (opts.excludePaths ?? []).some(p => url.startsWith(p))
      },
    },
  })

  const sdk = new NodeSDK({
    spanProcessors: [processor],
    instrumentations,
  })

  try {
    sdk.start()
  } catch (err) {
    throw new RuntimeGraphError(
      'capture.start_failed',
      `OTel SDK failed to start: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  const handle: CaptureHandle = {
    projectRoot: opts.projectRoot,
    peek() {
      return exporter.getFinishedSpans()
    },
    async stop() {
      try {
        // Force flush pour que les spans en cours d'export soient capturés.
        await processor.forceFlush()
        await sdk.shutdown()
      } catch (err) {
        // Best-effort : si le shutdown fail, on retourne quand même les spans
        // déjà capturés. Le caller verra un warning mais aura les data.
        // (Pas de log ici — la lib doit rester silencieuse, le caller logge.)
      }
      const spans = exporter.getFinishedSpans()
      exporter.reset()
      _activeHandle = null
      return spans
    },
  }

  _activeHandle = handle
  return handle
}

/**
 * Retourne le handle actif (utile pour debug ou multi-driver).
 * Throw si attachRuntimeCapture n'a pas été appelé.
 */
export function getActiveCapture(): CaptureHandle {
  if (!_activeHandle) {
    throw new RuntimeGraphError(
      'capture.not_attached',
      'No active runtime capture. Call attachRuntimeCapture() first.',
    )
  }
  return _activeHandle
}
