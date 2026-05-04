/**
 * Data Flows Extractor — structural map phase 1.5
 *
 * Pour chaque entry-point (route HTTP, event listener, tool MCP), trace la
 * trajectoire bout-en-bout : handler → steps (via typedCalls BFS) → sinks
 * (db-write, event-emit, http-response, bullmq-enqueue). Les sinks de type
 * event déclenchent un chaînage `downstream` vers leurs listeners.
 *
 * Dépend de `typedCalls` (phase 1.2) : la traversée utilise `callEdges` pour
 * suivre la chaîne d'appels entre fonctions nommées. Les arrows inline et
 * les méthodes d'instance ne sont pas traversées (typedCalls ne les capture
 * pas v1), ce qui crée des faux négatifs assumés.
 *
 * Détection d'entry-points v1 :
 *   - HTTP : pattern Sentinel `if (path === '/api/...' && method === 'X')`
 *     OU `if (method === 'X' && path === '/api/...')`.
 *   - Event listener : `listen('name', handlerFn)` / `bus.on('name', handler)`
 *     avec handler = Identifier (fonction nommée). Arrows inline : entry
 *     émis avec handler vide + sinks scannés directement dans l'arrow.
 *   - MCP tool : fichiers matchant `/mcp/tools/` qui exportent des fonctions
 *     `handle*` ou des consts `TOOL_*`.
 *
 * Phase 3.6 (B.3 + B.4) :
 *   - Entry-points `interval` : `setInterval(handler, ms)` et `setTimeout`
 *     module-level (scheduled start).
 *   - Entry-points `bullmq-job` : `new Worker('queue', handler, ...)`.
 *   - Sink `http-outbound` : `fetch(url, ...)`, `axios.<method>(url, ...)`,
 *     `got(url, ...)` — permet de voir les dépendances externes comme
 *     sinks d'un flow.
 *
 * Non couvert (documenté) : routes regex complexes (`path.match(...)`),
 * crons node-cron (`cron.schedule(...)`), SDK typés (googleapis, AWS SDK,
 * etc. — pas toujours de signature HTTP visible).
 */

import { Project, SyntaxKind, type Node, type SourceFile } from 'ts-morph'
import * as path from 'node:path'
import {
  collectFunctionRanges, findContainerAtLine, type FnRange,
  extractLiteralString,
} from './_shared/ast-helpers.js'
import type {
  DataFlow,
  DataFlowEntry,
  DataFlowStep,
  DataFlowSink,
  DataFlowEntryKind,
  TypedCalls,
  TypedSignature,
  GraphEdge,
} from '../core/types.js'

// ─── Options ────────────────────────────────────────────────────────────────

export interface DataFlowsOptions {
  /** Profondeur max BFS dans le graphe d'appels typé. Default 8. */
  maxDepth?: number
  /** Profondeur max de chaînage downstream via event-emit. Default 1. */
  downstreamDepth?: number
  /** Noms de fonctions de query DB (callee). Default : query, execute, sql. */
  queryFnNames?: string[]
  /** Noms de fonctions d'emit. Default : emit. Property access sera matché sur le right side. */
  emitFnNames?: string[]
  /** Noms de fonctions de listen. Default : listen, on. */
  listenFnNames?: string[]
  /** Noms de fonctions de réponse HTTP. Default : json, send, end. */
  httpResponseFnNames?: string[]
  /** Noms de fonctions d'enqueue BullMQ. Default : add. */
  bullmqEnqueueFnNames?: string[]
  /** Fragment de path identifiant un fichier MCP tool. Default : `/mcp/tools/`. */
  mcpToolsPathFragment?: string
  /**
   * Noms de fonctions de timer module-level. Default : setInterval, setTimeout.
   * Chaque call détecté émet un entry-point `interval`.
   */
  intervalFnNames?: string[]
  /**
   * Noms de constructeurs reconnus comme workers BullMQ.
   * Default : Worker. Un `new Worker('queue', handler)` émet un entry-point
   * `bullmq-job` avec id = queue name.
   */
  bullmqWorkerCtors?: string[]
  /**
   * Noms de fonctions d'HTTP client sortant. Default : fetch, got.
   */
  httpOutboundFnNames?: string[]
  /**
   * Property access pour clients HTTP typed (appelés comme `<obj>.<method>`).
   * Default : axios, http.
   */
  httpOutboundClients?: string[]
}

const DEFAULT_MAX_DEPTH = 8
const DEFAULT_DOWNSTREAM_DEPTH = 1
const DEFAULT_QUERY_FNS = ['query', 'execute', 'sql']
const DEFAULT_EMIT_FNS = ['emit']
const DEFAULT_LISTEN_FNS = ['listen', 'on']
const DEFAULT_HTTP_RESP_FNS = ['json', 'send', 'end']
const DEFAULT_BULLMQ_FNS = ['add']
const DEFAULT_MCP_FRAGMENT = '/mcp/tools/'
const DEFAULT_INTERVAL_FNS = ['setInterval', 'setTimeout']
const DEFAULT_BULLMQ_WORKER_CTORS = ['Worker']
const DEFAULT_HTTP_OUTBOUND_FNS = ['fetch', 'got']
const DEFAULT_HTTP_OUTBOUND_CLIENTS = ['axios', 'http']
const HTTP_OUTBOUND_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request'])

// ─── Public API ─────────────────────────────────────────────────────────────

interface NormalizedDataFlowOptions {
  maxDepth: number
  downstreamDepth: number
  queryFns: Set<string>
  emitFns: Set<string>
  listenFns: Set<string>
  httpRespFns: Set<string>
  bullmqFns: Set<string>
  mcpFragment: string
  intervalFns: Set<string>
  bullmqWorkerCtors: Set<string>
  httpOutboundFns: Set<string>
  httpOutboundClients: Set<string>
}

function normalizeDataFlowOptions(options: DataFlowsOptions): NormalizedDataFlowOptions {
  return {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    downstreamDepth: options.downstreamDepth ?? DEFAULT_DOWNSTREAM_DEPTH,
    queryFns: new Set(options.queryFnNames ?? DEFAULT_QUERY_FNS),
    emitFns: new Set(options.emitFnNames ?? DEFAULT_EMIT_FNS),
    listenFns: new Set(options.listenFnNames ?? DEFAULT_LISTEN_FNS),
    httpRespFns: new Set(options.httpResponseFnNames ?? DEFAULT_HTTP_RESP_FNS),
    bullmqFns: new Set(options.bullmqEnqueueFnNames ?? DEFAULT_BULLMQ_FNS),
    mcpFragment: options.mcpToolsPathFragment ?? DEFAULT_MCP_FRAGMENT,
    intervalFns: new Set(options.intervalFnNames ?? DEFAULT_INTERVAL_FNS),
    bullmqWorkerCtors: new Set(options.bullmqWorkerCtors ?? DEFAULT_BULLMQ_WORKER_CTORS),
    httpOutboundFns: new Set(options.httpOutboundFnNames ?? DEFAULT_HTTP_OUTBOUND_FNS),
    httpOutboundClients: new Set(options.httpOutboundClients ?? DEFAULT_HTTP_OUTBOUND_CLIENTS),
  }
}

export async function analyzeDataFlows(
  rootDir: string,
  files: string[],
  project: Project,
  typedCalls: TypedCalls,
  _allEdges: GraphEdge[],
  options: DataFlowsOptions = {},
): Promise<DataFlow[]> {
  const opts = normalizeDataFlowOptions(options)
  const fileSet = new Set(files)

  const fileBundles = new Map<string, DataFlowFileBundle>()
  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue
    fileBundles.set(relPath, extractDataFlowsFileBundle(sf, relPath, {
      queryFns: opts.queryFns,
      emitFns: opts.emitFns,
      listenFns: opts.listenFns,
      httpRespFns: opts.httpRespFns,
      bullmqFns: opts.bullmqFns,
      mcpFragment: opts.mcpFragment,
      intervalFns: opts.intervalFns,
      bullmqWorkerCtors: opts.bullmqWorkerCtors,
      httpOutboundFns: opts.httpOutboundFns,
      httpOutboundClients: opts.httpOutboundClients,
    }))
  }

  return buildDataFlowsFromBundles(fileBundles, typedCalls, {
    maxDepth: opts.maxDepth,
    downstreamDepth: opts.downstreamDepth,
  })
}

/**
 * Pure builder réutilisable : à partir des bundles per-file (déjà
 * extraits) + typedCalls global, exécute Pass 3 (BFS) + Pass 4
 * (downstream) + tri. Réutilisé côté Salsa après caching des bundles.
 */
/**
 * Index lookup `file:symbol` → TypedSignature et map des edges
 * sortants par `from`. Utilises dans le BFS pour resolution O(1).
 */
function buildTypedCallIndex(typedCalls: TypedCalls): {
  sigIndex: Map<string, TypedSignature>
  edgesByFrom: Map<string, typeof typedCalls.callEdges>
} {
  const sigIndex = new Map<string, TypedSignature>()
  for (const s of typedCalls.signatures) {
    sigIndex.set(`${s.file}:${s.exportName}`, s)
  }
  const edgesByFrom = new Map<string, typeof typedCalls.callEdges>()
  for (const e of typedCalls.callEdges) {
    if (!edgesByFrom.has(e.from)) edgesByFrom.set(e.from, [])
    edgesByFrom.get(e.from)!.push(e)
  }
  return { sigIndex, edgesByFrom }
}

interface AggregatedBundles {
  sinksByContainer: Map<string, DataFlowSink[]>
  entries: DataFlowEntry[]
  inlineListenerSinks: Map<string, DataFlowSink[]>
}

function aggregateBundles(fileBundles: Map<string, DataFlowFileBundle>): AggregatedBundles {
  const sinksByContainer = new Map<string, DataFlowSink[]>()
  const entries: DataFlowEntry[] = []
  const inlineListenerSinks = new Map<string, DataFlowSink[]>()
  for (const bundle of fileBundles.values()) {
    for (const [container, sinks] of bundle.sinksByContainer) {
      if (!sinksByContainer.has(container)) sinksByContainer.set(container, [])
      sinksByContainer.get(container)!.push(...sinks)
    }
    entries.push(...bundle.entries)
    for (const [container, sinks] of bundle.inlineListenerSinks) {
      if (!inlineListenerSinks.has(container)) inlineListenerSinks.set(container, [])
      inlineListenerSinks.get(container)!.push(...sinks)
    }
  }
  return { sinksByContainer, entries, inlineListenerSinks }
}

function indexListenersByEvent(entries: DataFlowEntry[]): Map<string, DataFlowEntry[]> {
  const listenersByEvent = new Map<string, DataFlowEntry[]>()
  for (const e of entries) {
    if (e.kind !== 'event-listener') continue
    const eventName = e.id.replace(/^event:/, '')
    if (!listenersByEvent.has(eventName)) listenersByEvent.set(eventName, [])
    listenersByEvent.get(eventName)!.push(e)
  }
  return listenersByEvent
}

const FLOW_KIND_ORDER: Record<DataFlowEntryKind, number> = {
  'http-route': 0,
  'mcp-tool': 1,
  'event-listener': 2,
  'bullmq-job': 3,
  'cron': 4,
  'interval': 5,
}

function sortFlows(flows: DataFlow[]): void {
  flows.sort((a, b) => {
    const ka = FLOW_KIND_ORDER[a.entry.kind]
    const kb = FLOW_KIND_ORDER[b.entry.kind]
    if (ka !== kb) return ka - kb
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
  })
}

export function buildDataFlowsFromBundles(
  fileBundles: Map<string, DataFlowFileBundle>,
  typedCalls: TypedCalls,
  opts: { maxDepth: number; downstreamDepth: number },
): DataFlow[] {
  const { maxDepth, downstreamDepth } = opts
  const { sigIndex, edgesByFrom } = buildTypedCallIndex(typedCalls)
  const { sinksByContainer, entries, inlineListenerSinks } = aggregateBundles(fileBundles)
  const listenersByEvent = indexListenersByEvent(entries)

  const flows: DataFlow[] = entries.map(entry =>
    buildFlow(entry, sigIndex, edgesByFrom, sinksByContainer, inlineListenerSinks, maxDepth),
  )

  if (downstreamDepth > 0) {
    for (const flow of flows) {
      attachDownstream(flow, flows, listenersByEvent, downstreamDepth, new Set())
    }
  }

  sortFlows(flows)
  return flows
}

/**
 * Bundle de tout ce qu'on peut extraire d'UN SourceFile sans toucher
 * au global (sigIndex, edgesByFrom). Utilisé par la version Salsa.
 */
export interface DataFlowFileBundle {
  /** Map: container ("file:fnName") → liste de sinks. */
  sinksByContainer: Map<string, DataFlowSink[]>
  /** Entries (http, listener, mcp, interval, worker) détectés. */
  entries: DataFlowEntry[]
  /** Sinks inline d'un arrow listener (clé : container synthétique). */
  inlineListenerSinks: Map<string, DataFlowSink[]>
}

export interface DataFlowFileBundleOptions {
  queryFns: ReadonlySet<string>
  emitFns: ReadonlySet<string>
  listenFns: ReadonlySet<string>
  httpRespFns: ReadonlySet<string>
  bullmqFns: ReadonlySet<string>
  mcpFragment: string
  intervalFns: ReadonlySet<string>
  bullmqWorkerCtors: ReadonlySet<string>
  httpOutboundFns: ReadonlySet<string>
  httpOutboundClients: ReadonlySet<string>
}

/**
 * Helper réutilisable : extraction Pass 1 (sinks) + Pass 2 (entries)
 * pour UN SourceFile. Réutilisé par la version Salsa pour cacher
 * tout ça par-fichier.
 */
export function extractDataFlowsFileBundle(
  sf: SourceFile,
  relPath: string,
  opts: DataFlowFileBundleOptions,
): DataFlowFileBundle {
  const ranges = collectFunctionRanges(sf)

  const sinksByContainer = new Map<string, DataFlowSink[]>()
  scanSinks({
    sf, file: relPath, ranges,
    queryFns: opts.queryFns as Set<string>,
    emitFns: opts.emitFns as Set<string>,
    httpRespFns: opts.httpRespFns as Set<string>,
    bullmqFns: opts.bullmqFns as Set<string>,
    out: sinksByContainer,
  })
  scanHttpOutboundSinks(sf, relPath, ranges, opts.httpOutboundFns as Set<string>,
                        opts.httpOutboundClients as Set<string>, sinksByContainer)

  const entries: DataFlowEntry[] = []
  const inlineListenerSinks = new Map<string, DataFlowSink[]>()

  detectHttpEntries(sf, relPath, ranges, entries)
  detectListenerEntries({
    sf, file: relPath, ranges,
    listenFns: opts.listenFns as Set<string>,
    queryFns: opts.queryFns as Set<string>,
    emitFns: opts.emitFns as Set<string>,
    httpRespFns: opts.httpRespFns as Set<string>,
    bullmqFns: opts.bullmqFns as Set<string>,
    entries, inlineSinks: inlineListenerSinks,
  })
  if (relPath.includes(opts.mcpFragment)) {
    detectMcpToolEntries(sf, relPath, entries)
  }
  detectIntervalEntries(sf, relPath, ranges, opts.intervalFns as Set<string>, entries)
  detectBullmqWorkerEntries(sf, relPath, ranges, opts.bullmqWorkerCtors as Set<string>, entries)

  return { sinksByContainer, entries, inlineListenerSinks }
}

export const DEFAULT_DATA_FLOWS_OPTS: DataFlowFileBundleOptions = {
  queryFns: new Set(DEFAULT_QUERY_FNS),
  emitFns: new Set(DEFAULT_EMIT_FNS),
  listenFns: new Set(DEFAULT_LISTEN_FNS),
  httpRespFns: new Set(DEFAULT_HTTP_RESP_FNS),
  bullmqFns: new Set(DEFAULT_BULLMQ_FNS),
  mcpFragment: DEFAULT_MCP_FRAGMENT,
  intervalFns: new Set(DEFAULT_INTERVAL_FNS),
  bullmqWorkerCtors: new Set(DEFAULT_BULLMQ_WORKER_CTORS),
  httpOutboundFns: new Set(DEFAULT_HTTP_OUTBOUND_FNS),
  httpOutboundClients: new Set(DEFAULT_HTTP_OUTBOUND_CLIENTS),
}

// ─── Sink scanning ──────────────────────────────────────────────────────────

interface ScanSinksArgs {
  sf: SourceFile
  file: string
  ranges: FnRange[]
  queryFns: Set<string>
  emitFns: Set<string>
  httpRespFns: Set<string>
  bullmqFns: Set<string>
  out: Map<string, DataFlowSink[]>
}

interface SinkCallCtx {
  callArgs: any[]
  file: string
  line: number
  containerKey: string
  out: Map<string, DataFlowSink[]>
}

function trySinkDbWrite(ctx: SinkCallCtx): void {
  const sql = extractLiteralString(ctx.callArgs[0])
  if (!sql) return
  const table = extractWriteTable(sql)
  if (!table) return
  push(ctx.out, ctx.containerKey, {
    kind: 'db-write', target: table, file: ctx.file, line: ctx.line, container: ctx.containerKey,
  })
}

function trySinkEventEmit(ctx: SinkCallCtx): void {
  const eventName = extractLiteralString(ctx.callArgs[0])
  if (!eventName) return
  push(ctx.out, ctx.containerKey, {
    kind: 'event-emit', target: eventName, file: ctx.file, line: ctx.line, container: ctx.containerKey,
  })
}

function trySinkHttpResponse(ctx: SinkCallCtx): void {
  push(ctx.out, ctx.containerKey, {
    kind: 'http-response', target: '', file: ctx.file, line: ctx.line, container: ctx.containerKey,
  })
}

/**
 * `queue.add('job-name', payload)` — heuristic restriction au left-hand
 * contenant "queue" pour eviter capturer tout `.add(...)` du monde.
 */
function trySinkBullmqEnqueue(expr: any, ctx: SinkCallCtx): void {
  if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return
  const left = expr.getExpression?.()?.getText?.()?.toLowerCase() ?? ''
  if (!left.includes('queue')) return
  const jobName = extractLiteralString(ctx.callArgs[0])
  if (!jobName) return
  push(ctx.out, ctx.containerKey, {
    kind: 'bullmq-enqueue', target: jobName, file: ctx.file, line: ctx.line, container: ctx.containerKey,
  })
}

function scanSinks(args: ScanSinksArgs): void {
  const { sf, file, ranges, queryFns, emitFns, httpRespFns, bullmqFns, out } = args
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const expr = call.getExpression?.()
    if (!expr) return

    const method = getCalleeMethodName(expr)
    if (!method) return

    const line = call.getStartLineNumber?.() ?? 0
    const container = findContainerAtLine(ranges, line)
    if (!container) return  // sink hors fonction, ignoré
    const containerKey = `${file}:${container}`
    const ctx: SinkCallCtx = {
      callArgs: call.getArguments?.() ?? [],
      file, line, containerKey, out,
    }

    if (queryFns.has(method)) trySinkDbWrite(ctx)
    else if (emitFns.has(method)) trySinkEventEmit(ctx)
    else if (httpRespFns.has(method)) trySinkHttpResponse(ctx)
    else if (bullmqFns.has(method)) trySinkBullmqEnqueue(expr, ctx)
  })
}

function getCalleeMethodName(expr: Node): string | null {
  const k = expr.getKind()
  if (k === SyntaxKind.Identifier) return expr.getText()
  if (k === SyntaxKind.PropertyAccessExpression) {
    return (expr as any).getName?.() ?? null
  }
  return null
}

// extractLiteralString moved to _shared/ast-helpers.ts (NCD dedup).

function extractWriteTable(sql: string): string | null {
  const match = sql.match(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i)
  if (!match) return null
  const table = match[1].toLowerCase()
  if (table === 'set' || table === 'from' || table === 'where') return null
  return table
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  if (!m.has(k)) m.set(k, [])
  m.get(k)!.push(v)
}

// ─── Entry detection : HTTP ─────────────────────────────────────────────────

function detectHttpEntries(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  out: DataFlowEntry[],
): void {
  const content = sf.getFullText()
  scanLiteralRoutePatterns(content, file, ranges, out)
  scanRegexRoutePatterns(content, file, ranges, out)
}

/** Patterns littéraux : path === '...' && method === '...'. */
function scanLiteralRoutePatterns(
  content: string,
  file: string,
  ranges: FnRange[],
  out: DataFlowEntry[],
): void {
  const patterns = [
    /path\s*===\s*['"]([^'"]+)['"]\s*&&\s*method\s*===\s*['"]([A-Z]+)['"]/g,
    /method\s*===\s*['"]([A-Z]+)['"]\s*&&\s*path\s*===\s*['"]([^'"]+)['"]/g,
  ]
  for (let i = 0; i < patterns.length; i++) {
    pushMatchesForRoutePattern(patterns[i], i === 0, content, file, ranges, out)
  }
}

/**
 * Patterns regex Sentinel : path.match(/^\/api\/.../) && method === '...'.
 * On capture le body de la regex et on remplace les groupes par :param.
 */
function scanRegexRoutePatterns(
  content: string,
  file: string,
  ranges: FnRange[],
  out: DataFlowEntry[],
): void {
  const patterns = [
    /path\.match\(\/\^([^)]+?)\$\/\)\s*&&\s*method\s*===\s*['"]([A-Z]+)['"]/g,
    /method\s*===\s*['"]([A-Z]+)['"]\s*&&\s*path\.match\(\/\^([^)]+?)\$\/\)/g,
  ]
  for (let i = 0; i < patterns.length; i++) {
    pushMatchesForRoutePattern(patterns[i], i === 0, content, file, ranges, out, true)
  }
}

/**
 * Drive un regex contre `content` et push 1 entry par match. Si `isRegexBody`,
 * la portion path est traitée comme corps de regex Sentinel (regexToPathTemplate).
 */
function pushMatchesForRoutePattern(
  regex: RegExp,
  pathFirst: boolean,
  content: string,
  file: string,
  ranges: FnRange[],
  out: DataFlowEntry[],
  isRegexBody = false,
): void {
  regex.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    const rawPath = pathFirst ? match[1] : match[2]
    const method = pathFirst ? match[2] : match[1]
    const routePath = isRegexBody ? regexToPathTemplate(rawPath) : rawPath
    if (!routePath) continue
    const line = content.substring(0, match.index).split('\n').length
    const container = findContainerAtLine(ranges, line)
    if (!container) continue
    out.push({
      kind: 'http-route',
      id: `${method} ${routePath}`,
      file,
      line,
      handler: `${file}:${container}`,
    })
  }
}

/**
 * Transforme le body d'une regex Sentinel-style (sans `^` ni `$`, escapes `\/`)
 * en template de route : `\/api\/v1\/approvals\/([^/]+)\/resolve` →
 * `/api/v1/approvals/:param/resolve`. Retourne null si la regex est trop
 * complexe à normaliser (on préfère omettre que d'émettre faux).
 */
function regexToPathTemplate(raw: string): string | null {
  let s = raw
  // Rejeter les regex avec alternatives ou quantifiers complexes — v1.
  if (/\(\?:/.test(s)) return null
  if (/\|/.test(s)) return null
  // Unescape `\/` → `/`.
  s = s.replace(/\\\//g, '/')
  // Remplacer les tokens de paramètre (avec ou sans capture group) par `:param`.
  // Sentinel utilise couramment `[^/]+` non-capturant pour les segments dont
  // la valeur est extraite autrement.
  s = s.replace(/\(\[\^\/\]\+\)/g, ':param')
  s = s.replace(/\[\^\/\]\+/g, ':param')
  s = s.replace(/\(\\w\+\)/g, ':param')
  s = s.replace(/\\w\+/g, ':param')
  s = s.replace(/\(\\d\+\)/g, ':param')
  s = s.replace(/\\d\+/g, ':param')
  // Rejeter s'il reste des caractères regex ambigus.
  if (/[()\\\[\]?+*]/.test(s)) return null
  if (!s.startsWith('/')) return null
  return s
}

// ─── Entry detection : event listeners ──────────────────────────────────────

interface DetectListenerEntriesArgs {
  sf: SourceFile
  file: string
  ranges: FnRange[]
  listenFns: Set<string>
  queryFns: Set<string>
  emitFns: Set<string>
  httpRespFns: Set<string>
  bullmqFns: Set<string>
  entries: DataFlowEntry[]
  inlineSinks: Map<string, DataFlowSink[]>
}

const LISTENER_BUS_NAME_RE = /bus|events?|emit|listen|signal/

/**
 * Heuristique : exclure les `.on(` sur des objets qui ne sont pas des
 * event buses. PropertyAccess accepte uniquement si left = Identifier
 * dont le nom matche bus/events/emit/listen/signal.
 */
function isListenerCallShape(expr: any): boolean {
  if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return true
  const left = expr.getExpression?.()
  if (!left || left.getKind() !== SyntaxKind.Identifier) return false
  const leftName = left.getText().toLowerCase()
  return LISTENER_BUS_NAME_RE.test(leftName)
}

/**
 * Unwrap `handler as Type` / `<Type>handler` — TS cast wrappers que
 * la detection ne doit pas rater.
 */
function unwrapHandlerArg(handlerArg: any): { node: any; kind: number } {
  let h = handlerArg
  let k = h.getKind?.()
  if (k === SyntaxKind.AsExpression || k === SyntaxKind.TypeAssertionExpression) {
    h = h.getExpression?.() ?? h
    k = h.getKind?.()
  }
  return { node: h, kind: k }
}

interface ListenerArrowCtx {
  args: DetectListenerEntriesArgs
  eventName: string
  line: number
  file: string
  handlerArg: any
  entries: DataFlowEntry[]
  inlineSinks: Map<string, DataFlowSink[]>
}

function recordArrowListener(ctx: ListenerArrowCtx): void {
  const { args, eventName, line, file, handlerArg, entries, inlineSinks } = ctx
  const entryId = `${file}:<anon@${line}>`
  entries.push({
    kind: 'event-listener',
    id: `event:${eventName}`,
    file, line,
    handler: entryId,
  })
  const body = handlerArg.getBody?.()
  if (!body) return
  const sinks: DataFlowSink[] = []
  const fakeRange: FnRange = { start: line, end: (body as any).getEndLineNumber?.() ?? line, name: `<anon@${line}>` }
  scanInlineSinks({
    body, file, fakeRange,
    queryFns: args.queryFns, emitFns: args.emitFns,
    httpRespFns: args.httpRespFns, bullmqFns: args.bullmqFns,
    out: sinks,
  })
  if (sinks.length > 0) inlineSinks.set(entryId, sinks)
}

function detectListenerEntries(args: DetectListenerEntriesArgs): void {
  const { sf, file, ranges, listenFns, entries, inlineSinks } = args
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const expr = call.getExpression?.()
    if (!expr) return

    const method = getCalleeMethodName(expr)
    if (!method || !listenFns.has(method)) return
    if (!isListenerCallShape(expr)) return

    const callArgs = call.getArguments?.() ?? []
    const eventName = extractLiteralString(callArgs[0])
    if (!eventName) return
    if (!callArgs[1]) return

    const line = call.getStartLineNumber?.() ?? 0
    const { node: handlerNode, kind: handlerKind } = unwrapHandlerArg(callArgs[1])

    if (handlerKind === SyntaxKind.Identifier) {
      const handlerName = handlerNode.getText()
      // matchRange determine si le handler est local — on emet dans
      // les 2 cas, le BFS tentera le lookup sur "file:handlerName".
      void ranges.find((r) => r.name === handlerName)
      entries.push({
        kind: 'event-listener',
        id: `event:${eventName}`,
        file, line,
        handler: `${file}:${handlerName}`,
      })
      return
    }

    if (handlerKind === SyntaxKind.ArrowFunction || handlerKind === SyntaxKind.FunctionExpression) {
      recordArrowListener({ args, eventName, line, file, handlerArg: handlerNode, entries, inlineSinks })
    }
  })
}

interface ScanInlineSinksArgs {
  body: Node
  file: string
  fakeRange: FnRange
  queryFns: Set<string>
  emitFns: Set<string>
  httpRespFns: Set<string>
  bullmqFns: Set<string>
  out: DataFlowSink[]
}

/**
 * Detecte les sinks d'1 call expression dans le contexte d'un body
 * d'arrow/function inline. Reuse des helpers `trySink*` definis pour
 * `scanSinks` — meme semantique, push direct dans `out` au lieu de
 * Map<container, sinks[]>.
 */
function detectInlineSinkAtCall(call: any, ctx: { file: string; containerKey: string; out: DataFlowSink[]; queryFns: Set<string>; emitFns: Set<string>; httpRespFns: Set<string>; bullmqFns: Set<string> }): void {
  const expr = call.getExpression?.()
  if (!expr) return
  const method = getCalleeMethodName(expr)
  if (!method) return

  const line = call.getStartLineNumber?.() ?? 0
  const callArgs = call.getArguments?.() ?? []
  // Adapter : construit un push-as-array vers `out` (au lieu de map).
  const localMap = new Map<string, DataFlowSink[]>()
  localMap.set(ctx.containerKey, ctx.out)
  const sinkCtx: SinkCallCtx = {
    callArgs, file: ctx.file, line, containerKey: ctx.containerKey, out: localMap,
  }

  if (ctx.queryFns.has(method)) trySinkDbWrite(sinkCtx)
  else if (ctx.emitFns.has(method)) trySinkEventEmit(sinkCtx)
  else if (ctx.httpRespFns.has(method)) trySinkHttpResponse(sinkCtx)
  else if (ctx.bullmqFns.has(method)) trySinkBullmqEnqueue(expr, sinkCtx)
}

function scanInlineSinks(args: ScanInlineSinksArgs): void {
  const { body, file, fakeRange, queryFns, emitFns, httpRespFns, bullmqFns, out } = args
  const containerKey = `${file}:${fakeRange.name}`
  const ctx = { file, containerKey, out, queryFns, emitFns, httpRespFns, bullmqFns }
  const walk = (n: Node): void => {
    if (n.getKind() === SyntaxKind.CallExpression) {
      detectInlineSinkAtCall(n as any, ctx)
    }
    n.forEachChild(walk)
  }
  walk(body)
}

// ─── Entry detection : MCP tools ────────────────────────────────────────────

function detectMcpToolEntries(
  sf: SourceFile,
  file: string,
  out: DataFlowEntry[],
): void {
  // Heuristique : chaque fonction exportée nommée `handle*` est un handler MCP.
  // Les `TOOL_*` consts sont des schémas, on ne les prend pas comme entry.
  for (const fd of sf.getFunctions()) {
    if (!fd.isExported()) continue
    const name = fd.getName()
    if (!name || !name.startsWith('handle')) continue
    out.push({
      kind: 'mcp-tool',
      id: `mcp:${path.basename(file, '.ts')}:${name}`,
      file,
      line: fd.getStartLineNumber(),
      handler: `${file}:${name}`,
    })
  }
}

// ─── Interval / Timer entries (phase 3.6, B.3) ──────────────────────────────

/**
 * Détecte `setInterval(handler, ms)` et `setTimeout(handler, ms)` comme
 * entry-points `interval`. Le handler est :
 *   - Identifier  → `file:name` (traversable par BFS typedCalls)
 *   - Arrow/fn    → handler vide (les sinks inline sont scannés directement
 *                   dans le container englobant, comme pour les listeners)
 *
 * Id lisible : `interval:<fn>:<line>` (discriminant par position dans le
 * fichier car plusieurs setInterval dans un même module sont courants).
 */
function detectIntervalEntries(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  intervalFns: Set<string>,
  out: DataFlowEntry[],
): void {
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const expr = call.getExpression?.()
    if (!expr || expr.getKind() !== SyntaxKind.Identifier) return
    const fnName = expr.getText()
    if (!intervalFns.has(fnName)) return

    const args = call.getArguments?.() ?? []
    if (args.length === 0) return

    const line = call.getStartLineNumber?.() ?? 0
    const handlerNode = args[0]
    const handlerKind = handlerNode.getKind?.()

    let handler: string | undefined
    if (handlerKind === SyntaxKind.Identifier) {
      handler = `${file}:${handlerNode.getText()}`
    }

    out.push({
      kind: 'interval',
      id: `${fnName}:${path.basename(file, '.ts')}:${line}`,
      file,
      line,
      ...(handler ? { handler } : {}),
    })
    void ranges  // placeholder pour future détection container-aware
  })
}

// ─── BullMQ Worker entries (phase 3.6, B.3) ─────────────────────────────────

/**
 * Détecte `new Worker('queueName', handler, ...)` comme entry-point
 * `bullmq-job`. Nom de queue = premier argument string literal.
 * Handler = deuxième argument, même logique que les intervals.
 */
function detectBullmqWorkerEntries(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  workerCtors: Set<string>,
  out: DataFlowEntry[],
): void {
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.NewExpression) return
    const newExpr = node as any
    const ctor = newExpr.getExpression?.()
    if (!ctor || ctor.getKind() !== SyntaxKind.Identifier) return
    const ctorName = ctor.getText()
    if (!workerCtors.has(ctorName)) return

    const args = newExpr.getArguments?.() ?? []
    if (args.length === 0) return

    const queueNode = args[0]
    const queueKind = queueNode.getKind?.()
    if (queueKind !== SyntaxKind.StringLiteral && queueKind !== SyntaxKind.NoSubstitutionTemplateLiteral) {
      return
    }
    const queueName = queueNode.getLiteralText?.()
    if (!queueName) return

    const line = newExpr.getStartLineNumber?.() ?? 0
    let handler: string | undefined
    if (args.length > 1 && args[1].getKind?.() === SyntaxKind.Identifier) {
      handler = `${file}:${args[1].getText()}`
    }

    out.push({
      kind: 'bullmq-job',
      id: `queue:${queueName}`,
      file,
      line,
      ...(handler ? { handler } : {}),
    })
    void ranges
  })
}

// ─── HTTP outbound sinks (phase 3.6, B.4) ───────────────────────────────────

/**
 * Détecte les call sites d'HTTP clients sortants :
 *   - `fetch(url, ...)`, `got(url, ...)` — function-call forme
 *   - `axios.<method>(url, ...)` / `http.<method>(url, ...)` — property-access
 *
 * `target` est l'host si l'URL est un string literal analysable. Sinon
 * `<dynamic>`. Permet de voir les dépendances externes comme sinks des
 * flows (utile pour comprendre où le système appelle YouTube, Gmail, etc.).
 *
 * Faux positifs acceptés :
 *   - `this.fetch(...)` sur une classe qui n'est pas un HTTP client →
 *     target = `<dynamic>`, tag utile mais potentiellement bruyant. Conservateur :
 *     on n'exige que le callee matche exactement, sans validation sémantique.
 */
/**
 * `fetch(url)` ou `<client>.<method>(url)` — match si l'expr de call
 * matche les patterns http outbound configurés.
 */
function isHttpOutboundCall(expr: any, fns: Set<string>, clients: Set<string>): boolean {
  if (expr.getKind() === SyntaxKind.Identifier) {
    return fns.has(expr.getText())
  }
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const obj = expr.getExpression?.()
    const method = expr.getName?.()
    if (!obj || obj.getKind() !== SyntaxKind.Identifier || !method) return false
    return clients.has(obj.getText()) && HTTP_OUTBOUND_METHODS.has(method)
  }
  return false
}

function extractOutboundTarget(callArgs: any[]): string {
  if (callArgs.length === 0) return '<dynamic>'
  const firstArg = callArgs[0]
  const k = firstArg.getKind?.()
  if (k !== SyntaxKind.StringLiteral && k !== SyntaxKind.NoSubstitutionTemplateLiteral) {
    return '<dynamic>'
  }
  const url = firstArg.getLiteralText?.() ?? ''
  return extractHost(url) ?? '<dynamic>'
}

function scanHttpOutboundSinks(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  fns: Set<string>,
  clients: Set<string>,
  out: Map<string, DataFlowSink[]>,
): void {
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const expr = call.getExpression?.()
    if (!expr) return
    if (!isHttpOutboundCall(expr, fns, clients)) return

    const target = extractOutboundTarget(call.getArguments?.() ?? [])
    const line = call.getStartLineNumber?.() ?? 0
    const container = findContainerAtLine(ranges, line)
    if (!container) return
    const key = `${file}:${container}`

    if (!out.has(key)) out.set(key, [])
    out.get(key)!.push({
      kind: 'http-outbound',
      target,
      file,
      line,
      container: key,
    })
  })
}

function extractHost(url: string): string | null {
  // URL absolue `https://host/...` → host.
  const absMatch = /^https?:\/\/([^\/?#]+)/i.exec(url)
  if (absMatch) return absMatch[1]
  // URL relative (`/api/foo`) → skip, pas informative comme outbound.
  if (url.startsWith('/')) return null
  // Template avec host variable (`${base}/foo`) → skip.
  return null
}

// ─── BFS flow builder ───────────────────────────────────────────────────────

interface BuildFlowCtx {
  entry: DataFlowEntry
  sigIndex: Map<string, TypedSignature>
  edgesByFrom: Map<string, Array<{ from: string; to: string; argTypes: string[]; returnType: string; line: number }>>
  sinksByContainer: Map<string, DataFlowSink[]>
  inlineSinks: Map<string, DataFlowSink[]>
  maxDepth: number
}

interface BfsState {
  steps: DataFlowStep[]
  sinks: DataFlowSink[]
  visited: Set<string>
}

interface BfsItem {
  node: string
  depth: number
  inputTypes: string[]
  outputType?: string
}

function buildStepFromNode(item: BfsItem, ctx: BuildFlowCtx): DataFlowStep {
  const sig = ctx.sigIndex.get(item.node)
  const [file, symbol] = item.node.split(':')
  return {
    node: item.node,
    file: file ?? ctx.entry.file,
    symbol: symbol ?? item.node,
    line: sig?.line ?? ctx.entry.line,
    depth: item.depth,
    inputTypes: item.inputTypes,
    ...(item.outputType ? { outputType: item.outputType } : {}),
  }
}

function enqueueOutEdges(item: BfsItem, queue: BfsItem[], state: BfsState, ctx: BuildFlowCtx): void {
  if (item.depth >= ctx.maxDepth) return
  const out = ctx.edgesByFrom.get(item.node) ?? []
  for (const e of out) {
    if (state.visited.has(e.to)) continue
    queue.push({
      node: e.to,
      depth: item.depth + 1,
      inputTypes: e.argTypes,
      outputType: e.returnType,
    })
  }
}

function resolveHandlerInputType(entry: DataFlowEntry, sigIndex: Map<string, TypedSignature>): string | undefined {
  if (!entry.handler) return undefined
  const sig = sigIndex.get(entry.handler)
  if (sig && sig.params.length > 0) return sig.params[0].type
  return undefined
}

function buildFlow(
  entry: DataFlowEntry,
  sigIndex: Map<string, TypedSignature>,
  edgesByFrom: Map<string, Array<{ from: string; to: string; argTypes: string[]; returnType: string; line: number }>>,
  sinksByContainer: Map<string, DataFlowSink[]>,
  inlineSinks: Map<string, DataFlowSink[]>,
  maxDepth: number,
): DataFlow {
  const ctx: BuildFlowCtx = { entry, sigIndex, edgesByFrom, sinksByContainer, inlineSinks, maxDepth }
  const state: BfsState = { steps: [], sinks: [], visited: new Set() }
  const queue: BfsItem[] = []

  if (entry.handler) queue.push({ node: entry.handler, depth: 0, inputTypes: [] })

  while (queue.length > 0) {
    const item = queue.shift()!
    if (state.visited.has(item.node)) continue
    state.visited.add(item.node)

    state.steps.push(buildStepFromNode(item, ctx))
    const contSinks = sinksByContainer.get(item.node) ?? inlineSinks.get(item.node) ?? []
    for (const s of contSinks) state.sinks.push(s)

    enqueueOutEdges(item, queue, state, ctx)
  }

  const dedupSinks = dedup(state.sinks, (s) => `${s.kind}|${s.target}|${s.file}|${s.line}`)
  dedupSinks.sort(cmpSink)

  const inputType = resolveHandlerInputType(entry, sigIndex)
  return {
    entry,
    ...(inputType ? { inputType } : {}),
    steps: state.steps,
    sinks: dedupSinks,
  }
}

function attachDownstream(
  flow: DataFlow,
  allFlows: DataFlow[],
  listenersByEvent: Map<string, DataFlowEntry[]>,
  remainingDepth: number,
  visitedDownstream: Set<string>,
): void {
  if (remainingDepth <= 0) return

  const emitSinks = flow.sinks.filter((s) => s.kind === 'event-emit')
  if (emitSinks.length === 0) return

  const downstream: DataFlow[] = []
  for (const sink of emitSinks) {
    const listeners = listenersByEvent.get(sink.target) ?? []
    for (const listener of listeners) {
      const key = `${listener.id}|${listener.handler ?? ''}`
      if (visitedDownstream.has(key)) continue
      visitedDownstream.add(key)
      const listenerFlow = allFlows.find((f) => f.entry.id === listener.id && f.entry.handler === listener.handler)
      if (listenerFlow) downstream.push(shallowCopy(listenerFlow))
    }
  }
  if (downstream.length > 0) flow.downstream = downstream
}

/**
 * Copie superficielle d'un DataFlow pour attachement downstream — on n'y
 * inclut que les champs essentiels, les downstream récursifs sont coupés
 * pour éviter la structure en arbre trop profonde dans le JSON.
 */
function shallowCopy(f: DataFlow): DataFlow {
  return {
    entry: f.entry,
    ...(f.inputType ? { inputType: f.inputType } : {}),
    steps: f.steps,
    sinks: f.sinks,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativize(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}

function dedup<T>(arr: T[], keyFn: (x: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const x of arr) {
    const k = keyFn(x)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

function cmpSink(a: DataFlowSink, b: DataFlowSink): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  if (a.line !== b.line) return a.line - b.line
  return a.target < b.target ? -1 : a.target > b.target ? 1 : 0
}
