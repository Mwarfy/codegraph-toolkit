/**
 * OTel attach + in-memory span collection.
 *
 * Phase α design : on n'exporte PAS vers Jaeger/Tempo/etc. — les spans
 * sont collectés en mémoire et passés au span-aggregator qui projette
 * vers les facts datalog. Pas d'infra externe nécessaire pour le MVP.
 *
 * Implementation : BasicTracerProvider avec InMemorySpanExporter +
 * registerInstrumentations pour les auto-instruments Node (HTTP, pg,
 * ioredis, etc.). On register globalement via `trace.setGlobalTracerProvider`
 * pour que les spans manuels (`tracer.startActiveSpan(...)`) soient
 * également capturés.
 */

import { trace, type TracerProvider } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
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
  /**
   * Désactive l'enregistrement des auto-instruments (HTTP/DB/Redis).
   * Utile pour les tests qui veulent capturer UNIQUEMENT des spans
   * manuels (`tracer.startActiveSpan(...)`) sans le bruit auto-instrument.
   * Default: true (auto-instruments enabled).
   */
  enableAutoInstruments?: boolean
}

export interface CaptureHandle {
  /** Snapshot non-fini : utile pour debug en cours de run. */
  peek(): ReadableSpan[]
  /** Arrête la capture et retourne tous les spans collectés. */
  stop(): Promise<ReadableSpan[]>
  /** Path projet (utile pour aggregator). */
  projectRoot: string
  /** Le TracerProvider — utile pour récupérer un tracer dans un test
   *  sans dépendre du global (qui peut être restauré entre tests). */
  tracerProvider: TracerProvider
}

/**
 * Attache OTel au runtime Node courant.
 * IDEMPOTENT : un seul provider global par process. Multiple appels
 * retournent le handle existant.
 */
let _activeHandle: CaptureHandle | null = null

export function attachRuntimeCapture(opts: AttachOptions): CaptureHandle {
  if (_activeHandle) {
    return _activeHandle
  }

  const exporter = new InMemorySpanExporter()
  const processor = new SimpleSpanProcessor(exporter)

  // BasicTracerProvider — accepte spanProcessors via le constructeur.
  // On register globalement pour que `trace.getTracer(...)` (utilisé par
  // l'app et les auto-instruments) retourne un tracer actif.
  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
  })
  trace.setGlobalTracerProvider(provider)

  // Auto-instruments par défaut (HTTP, pg, ioredis, mongodb, etc.).
  // Désactiver fs/dns pour overhead (pas utile pour les facts ciblés).
  // Best-effort : si l'enable des instrumentations fail (env CI sans
  // certaines libs natives, etc.), on continue avec la capture manuelle
  // — les spans explicites du driver fonctionnent toujours.
  if (opts.enableAutoInstruments !== false) {
    try {
      registerInstrumentations({
        tracerProvider: provider,
        instrumentations: getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
          '@opentelemetry/instrumentation-dns': { enabled: false },
          '@opentelemetry/instrumentation-http': {
            ignoreIncomingRequestHook: (req) => {
              const url = (req as { url?: string }).url ?? ''
              return (opts.excludePaths ?? []).some(p => url.startsWith(p))
            },
          },
        }),
      })
    } catch {
      // Auto-instruments unavailable — manual spans still work.
      // (Phase α : silent fallback. β : structured warning surfaced via handle.)
    }
  }

  const handle: CaptureHandle = {
    projectRoot: opts.projectRoot,
    tracerProvider: provider,
    peek() {
      return exporter.getFinishedSpans()
    },
    async stop() {
      // CRITIQUE — flush PUIS lire AVANT shutdown.
      // provider.shutdown() appelle exporter.shutdown() qui clear le
      // buffer in-memory. Lire après → 0 spans.
      try {
        await processor.forceFlush()
      } catch {
        // continue — on lit ce qu'on a
      }
      const spans = [...exporter.getFinishedSpans()]                   // copy avant shutdown
      try {
        await provider.shutdown()
      } catch {
        // best-effort
      }
      trace.disable()
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
