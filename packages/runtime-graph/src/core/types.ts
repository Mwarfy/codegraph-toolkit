/**
 * @liby-tools/runtime-graph — core types
 *
 * Phase α design (cf. plan détaillé Phase α dans codegraph-toolkit/docs/) :
 * - 7 facts runtime canoniques (alignés sur OTel spans + custom hooks)
 * - 5 règles datalog cibles (cross-statique × runtime)
 * - 3 drivers (synthetic, event-bus, replay-tests)
 *
 * Les types ici sont LE contrat entre :
 *   1. la couche capture (OTel auto-instrument)
 *   2. la couche aggregator (spans → facts)
 *   3. la couche exporter (facts → TSV)
 *   4. la couche datalog (facts → violations)
 */

// ─── Facts runtime — schémas canoniques ──────────────────────────────────

/**
 * Une fonction exportée a été touchée pendant l'exécution.
 * Source : OTel spans nominaux (auto-instrument Node) + hook custom.
 *
 * file : path relatif depuis le rootDir du projet (ex: 'src/blocks/foo.ts')
 * fn   : nom du symbole exporté (ex: 'runFeedbackAggregator')
 * count : nombre d'invocations sur la fenêtre du run
 * p95LatencyMs : p95 mesuré (Math.floor pour TSV-friendly)
 */
export interface SymbolTouchedRuntimeFact {
  file: string
  fn: string
  count: number
  p95LatencyMs: number
}

/**
 * Une route HTTP a reçu du trafic.
 * Source : @opentelemetry/instrumentation-http spans.
 */
export interface HttpRouteHitFact {
  method: string                                                       // GET, POST, etc.
  path: string                                                         // /api/orders (template, pas /api/orders/123)
  status: number                                                       // 200, 404, 500
  count: number
  p95LatencyMs: number
}

/**
 * Une query SQL a été exécutée contre une table.
 * Source : @opentelemetry/instrumentation-pg + parsing du db.statement.
 *
 * op : SELECT, INSERT, UPDATE, DELETE (uppercased)
 * lastAtUnix : epoch seconds — permet de joindre avec NowUnix pour quietMin
 */
export interface DbQueryExecutedFact {
  table: string
  op: string
  count: number
  lastAtUnix: number
}

/**
 * Une opération Redis a été exécutée.
 * Source : @opentelemetry/instrumentation-ioredis
 */
export interface RedisOpExecutedFact {
  op: string                                                           // GET, SET, INCR, RPUSH, etc.
  keyPattern: string                                                   // glob-collapsed (user:* au lieu de user:42, user:43...)
  count: number
}

/**
 * Un event a été émis sur le bus event-driven du projet.
 * Source : hook custom — le runtime instrumente la fonction `emit()` du projet.
 * Configuré via runtime-graph.config.ts, défaut Sentinel = kernel/event-bus.
 */
export interface EventEmittedAtRuntimeFact {
  type: string                                                         // 'video.publish.requested', etc.
  count: number
  lastAtUnix: number
}

/**
 * Un edge d'appel observé en runtime (parent span → child span).
 * Permet de comparer avec ImportEdge / SymbolCallEdge statiques.
 *
 * Note : en α on capture seulement les edges où parent ET child ont un
 * code.filepath attribute (i.e. le code applicatif, pas les libs OTel).
 */
export interface CallEdgeRuntimeFact {
  fromFile: string
  fromFn: string
  toFile: string
  toFn: string
  count: number
}

/**
 * Métadonnées du run (audit + reproductibilité).
 * Toujours 1 row par run — sert de NowUnix pour les rules datalog.
 */
export interface RuntimeRunMetaFact {
  driver: string                                                       // 'synthetic' | 'event-bus' | 'replay-tests'
  startedAtUnix: number
  durationMs: number
  totalSpans: number
}

// ─── Aggregated runtime snapshot — émis par capture, consommé par exporter ──

export interface RuntimeSnapshot {
  symbolsTouched: SymbolTouchedRuntimeFact[]
  httpRouteHits: HttpRouteHitFact[]
  dbQueriesExecuted: DbQueryExecutedFact[]
  redisOps: RedisOpExecutedFact[]
  eventsEmitted: EventEmittedAtRuntimeFact[]
  callEdges: CallEdgeRuntimeFact[]
  meta: RuntimeRunMetaFact
}

// ─── Driver interface — comment provoquer le runtime ──────────────────────

/**
 * Un driver est responsable de provoquer l'exécution du système observé,
 * pendant que la couche capture (OTel) collecte les spans.
 *
 * Contract :
 *   - run() est async, retourne quand le trafic synthétique est terminé
 *   - durationMs est respecté (timeout) — le driver doit s'arrêter proprement
 *   - le driver ne configure PAS la capture OTel (déjà attachée au boot)
 */
export interface Driver {
  name: string
  run(opts: DriverRunOptions): Promise<DriverRunResult>
}

export interface DriverRunOptions {
  /** Timeout absolu — le driver doit terminer avant. */
  durationMs: number
  /** Path du projet observé (pour resolve les facts statiques EntryPoint, etc.). */
  projectRoot: string
  /** Configuration spécifique au driver (passé telle quelle). */
  config?: Record<string, unknown>
}

export interface DriverRunResult {
  /** Nombre d'actions réellement effectuées (curl issued, events emitted, etc.). */
  actionsCount: number
  /** Erreurs non-fatales rencontrées (pas d'exception fatale). */
  warnings: string[]
}

// ─── Configuration projet (runtime-graph.config.ts) ──────────────────────

export interface RuntimeGraphConfig {
  /** Path racine du projet observé. Default: process.cwd(). */
  projectRoot?: string

  /**
   * Path où les facts runtime sont écrits.
   * Default: <projectRoot>/.codegraph/facts-runtime/
   * Aligné sur la convention codegraph statique pour permettre le join datalog.
   */
  factsOutDir?: string

  /** Drivers à utiliser pour ce run. Au moins un requis. */
  drivers: Array<{
    name: 'synthetic' | 'event-bus' | 'replay-tests' | string
    config?: Record<string, unknown>
  }>

  /** Capture OTel — config sampling, exclude paths, etc. */
  capture?: {
    sampleRate?: number                                                // 0..1 (default 1.0)
    excludePaths?: string[]                                            // ['/health', '/metrics']
    excludePackages?: string[]                                         // ['@some/lib']
  }

  /** Tables expected (pour STALE_QUERY rule) — clone Sentinel pattern. */
  expectedTables?: Array<{ name: string; maxQuietMin: number }>

  /** Routes expected (pour DEAD_ROUTE rule). */
  expectedRoutes?: Array<{ method: string; path: string }>
}

// ─── Errors ────────────────────────────────────────────────────────────────

export class RuntimeGraphError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RuntimeGraphError'
  }
}
