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
import { collectFunctionRanges, findContainerAtLine, type FnRange } from './_shared/ast-helpers.js'
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

export async function analyzeDataFlows(
  rootDir: string,
  files: string[],
  project: Project,
  typedCalls: TypedCalls,
  _allEdges: GraphEdge[],
  options: DataFlowsOptions = {},
): Promise<DataFlow[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const downstreamDepth = options.downstreamDepth ?? DEFAULT_DOWNSTREAM_DEPTH
  const queryFns = new Set(options.queryFnNames ?? DEFAULT_QUERY_FNS)
  const emitFns = new Set(options.emitFnNames ?? DEFAULT_EMIT_FNS)
  const listenFns = new Set(options.listenFnNames ?? DEFAULT_LISTEN_FNS)
  const httpRespFns = new Set(options.httpResponseFnNames ?? DEFAULT_HTTP_RESP_FNS)
  const bullmqFns = new Set(options.bullmqEnqueueFnNames ?? DEFAULT_BULLMQ_FNS)
  const mcpFragment = options.mcpToolsPathFragment ?? DEFAULT_MCP_FRAGMENT
  const intervalFns = new Set(options.intervalFnNames ?? DEFAULT_INTERVAL_FNS)
  const bullmqWorkerCtors = new Set(options.bullmqWorkerCtors ?? DEFAULT_BULLMQ_WORKER_CTORS)
  const httpOutboundFns = new Set(options.httpOutboundFnNames ?? DEFAULT_HTTP_OUTBOUND_FNS)
  const httpOutboundClients = new Set(options.httpOutboundClients ?? DEFAULT_HTTP_OUTBOUND_CLIENTS)
  const fileSet = new Set(files)

  // Index : signature "file:symbol" → TypedSignature, pour lookup O(1) dans BFS.
  const sigIndex = new Map<string, TypedSignature>()
  for (const s of typedCalls.signatures) {
    sigIndex.set(`${s.file}:${s.exportName}`, s)
  }

  // Index : edges sortants par from.
  const edgesByFrom = new Map<string, typeof typedCalls.callEdges>()
  for (const e of typedCalls.callEdges) {
    if (!edgesByFrom.has(e.from)) edgesByFrom.set(e.from, [])
    edgesByFrom.get(e.from)!.push(e)
  }

  // ─── Per-file extraction (Salsa-isable) ─────────────────────────────
  const fileBundles = new Map<string, DataFlowFileBundle>()
  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue
    fileBundles.set(relPath, extractDataFlowsFileBundle(sf, relPath, {
      queryFns,
      emitFns,
      listenFns,
      httpRespFns,
      bullmqFns,
      mcpFragment,
      intervalFns,
      bullmqWorkerCtors,
      httpOutboundFns,
      httpOutboundClients,
    }))
  }

  return buildDataFlowsFromBundles(fileBundles, typedCalls, { maxDepth, downstreamDepth })
}

/**
 * Pure builder réutilisable : à partir des bundles per-file (déjà
 * extraits) + typedCalls global, exécute Pass 3 (BFS) + Pass 4
 * (downstream) + tri. Réutilisé côté Salsa après caching des bundles.
 */
export function buildDataFlowsFromBundles(
  fileBundles: Map<string, DataFlowFileBundle>,
  typedCalls: TypedCalls,
  opts: { maxDepth: number; downstreamDepth: number },
): DataFlow[] {
  const { maxDepth, downstreamDepth } = opts

  const sigIndex = new Map<string, TypedSignature>()
  for (const s of typedCalls.signatures) {
    sigIndex.set(`${s.file}:${s.exportName}`, s)
  }

  const edgesByFrom = new Map<string, typeof typedCalls.callEdges>()
  for (const e of typedCalls.callEdges) {
    if (!edgesByFrom.has(e.from)) edgesByFrom.set(e.from, [])
    edgesByFrom.get(e.from)!.push(e)
  }

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

  const listenersByEvent = new Map<string, DataFlowEntry[]>()
  for (const e of entries) {
    if (e.kind !== 'event-listener') continue
    const eventName = e.id.replace(/^event:/, '')
    if (!listenersByEvent.has(eventName)) listenersByEvent.set(eventName, [])
    listenersByEvent.get(eventName)!.push(e)
  }

  const flows: DataFlow[] = []
  for (const entry of entries) {
    const flow = buildFlow(entry, sigIndex, edgesByFrom, sinksByContainer, inlineListenerSinks, maxDepth)
    flows.push(flow)
  }

  if (downstreamDepth > 0) {
    for (const flow of flows) {
      attachDownstream(flow, flows, listenersByEvent, downstreamDepth, new Set())
    }
  }

  const kindOrder: Record<DataFlowEntryKind, number> = {
    'http-route': 0,
    'mcp-tool': 1,
    'event-listener': 2,
    'bullmq-job': 3,
    'cron': 4,
    'interval': 5,
  }
  flows.sort((a, b) => {
    const ka = kindOrder[a.entry.kind]
    const kb = kindOrder[b.entry.kind]
    if (ka !== kb) return ka - kb
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
  })

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
  scanSinks(sf, relPath, ranges, opts.queryFns as Set<string>, opts.emitFns as Set<string>,
            opts.httpRespFns as Set<string>, opts.bullmqFns as Set<string>, sinksByContainer)
  scanHttpOutboundSinks(sf, relPath, ranges, opts.httpOutboundFns as Set<string>,
                        opts.httpOutboundClients as Set<string>, sinksByContainer)

  const entries: DataFlowEntry[] = []
  const inlineListenerSinks = new Map<string, DataFlowSink[]>()

  detectHttpEntries(sf, relPath, ranges, entries)
  detectListenerEntries(sf, relPath, ranges,
    opts.listenFns as Set<string>,
    opts.queryFns as Set<string>,
    opts.emitFns as Set<string>,
    opts.httpRespFns as Set<string>,
    opts.bullmqFns as Set<string>,
    entries, inlineListenerSinks)
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

function scanSinks(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  queryFns: Set<string>,
  emitFns: Set<string>,
  httpRespFns: Set<string>,
  bullmqFns: Set<string>,
  out: Map<string, DataFlowSink[]>,
): void {
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
    const args = call.getArguments?.() ?? []

    // db-write : query/execute/sql avec un literal contenant INSERT/UPDATE/DELETE.
    if (queryFns.has(method)) {
      const sql = extractLiteralString(args[0])
      if (sql) {
        const table = extractWriteTable(sql)
        if (table) {
          push(out, containerKey, {
            kind: 'db-write',
            target: table,
            file,
            line,
            container: containerKey,
          })
        }
      }
      return
    }

    // event-emit : callee = 'emit' (ou method 'emit' sur property access).
    if (emitFns.has(method)) {
      const eventName = extractLiteralString(args[0])
      if (eventName) {
        push(out, containerKey, {
          kind: 'event-emit',
          target: eventName,
          file,
          line,
          container: containerKey,
        })
      }
      return
    }

    // http-response : json/send/end. Pas de target spécifique.
    if (httpRespFns.has(method)) {
      push(out, containerKey, {
        kind: 'http-response',
        target: '',
        file,
        line,
        container: containerKey,
      })
      return
    }

    // bullmq-enqueue : `queue.add('job-name', payload)`.
    if (bullmqFns.has(method)) {
      // On restreint à `add` sur property access pour éviter de capturer
      // tout `.add(...)` du monde. Heuristique : left side contient "queue" ou
      // "Queue" dans le nom.
      if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
        const left = (expr as any).getExpression?.()?.getText?.()?.toLowerCase() ?? ''
        if (!left.includes('queue')) return
      } else {
        return
      }
      const jobName = extractLiteralString(args[0])
      if (jobName) {
        push(out, containerKey, {
          kind: 'bullmq-enqueue',
          target: jobName,
          file,
          line,
          container: containerKey,
        })
      }
    }
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

function extractLiteralString(node: any): string | null {
  if (!node) return null
  const k = node.getKind?.()
  if (k === SyntaxKind.StringLiteral) return node.getLiteralText?.() ?? null
  if (k === SyntaxKind.NoSubstitutionTemplateLiteral) return node.getLiteralText?.() ?? null
  // Pour les TemplateExpression (avec ${...}), capture le texte brut moins backticks.
  if (k === SyntaxKind.TemplateExpression) {
    return node.getText?.().slice(1, -1) ?? null
  }
  return null
}

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

  // Patterns littéraux : path === '...' && method === '...'
  const literalPatterns = [
    /path\s*===\s*['"]([^'"]+)['"]\s*&&\s*method\s*===\s*['"]([A-Z]+)['"]/g,
    /method\s*===\s*['"]([A-Z]+)['"]\s*&&\s*path\s*===\s*['"]([^'"]+)['"]/g,
  ]

  for (let i = 0; i < literalPatterns.length; i++) {
    const regex = literalPatterns[i]
    const pathFirst = i === 0
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      const routePath = pathFirst ? match[1] : match[2]
      const method = pathFirst ? match[2] : match[1]
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

  // Patterns regex Sentinel : path.match(/^\/api\/.../) && method === '...'
  // On capture le body de la regex et on remplace les groupes par :param.
  const regexPatterns = [
    /path\.match\(\/\^([^)]+?)\$\/\)\s*&&\s*method\s*===\s*['"]([A-Z]+)['"]/g,
    /method\s*===\s*['"]([A-Z]+)['"]\s*&&\s*path\.match\(\/\^([^)]+?)\$\/\)/g,
  ]

  for (let i = 0; i < regexPatterns.length; i++) {
    const regex = regexPatterns[i]
    const pathFirst = i === 0
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      const rawRe = pathFirst ? match[1] : match[2]
      const method = pathFirst ? match[2] : match[1]
      const routePath = regexToPathTemplate(rawRe)
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

function detectListenerEntries(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  listenFns: Set<string>,
  queryFns: Set<string>,
  emitFns: Set<string>,
  httpRespFns: Set<string>,
  bullmqFns: Set<string>,
  entries: DataFlowEntry[],
  inlineSinks: Map<string, DataFlowSink[]>,
): void {
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const expr = call.getExpression?.()
    if (!expr) return

    const method = getCalleeMethodName(expr)
    if (!method || !listenFns.has(method)) return

    // Exclure les `.on(` sur des objets qui ne sont pas des event buses :
    // heuristique — si le left side ressemble à un name DOM (element, socket,
    // stream), on skip. Pour v1 on garde le filtre minimal : si c'est un
    // PropertyAccess, on accepte uniquement si le left est un Identifier
    // (bus, events, emitter, etc.) — les chaînes `foo.bar.on()` sont ignorées.
    if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const left = (expr as any).getExpression?.()
      if (!left || left.getKind() !== SyntaxKind.Identifier) return
      const leftName = left.getText().toLowerCase()
      if (!/bus|events?|emit|listen|signal/.test(leftName)) return
    }

    const args = call.getArguments?.() ?? []
    const eventName = extractLiteralString(args[0])
    if (!eventName) return

    const line = call.getStartLineNumber?.() ?? 0
    let handlerArg = args[1]
    if (!handlerArg) return

    // Unwrap `handler as Type` / `<Type>handler` — tc `as` cast pour types.
    let hk = handlerArg.getKind?.()
    if (hk === SyntaxKind.AsExpression || hk === SyntaxKind.TypeAssertionExpression) {
      handlerArg = handlerArg.getExpression?.() ?? handlerArg
      hk = handlerArg.getKind?.()
    }

    const handlerKind = hk

    // Handler = Identifier (fonction nommée).
    if (handlerKind === SyntaxKind.Identifier) {
      const handlerName = handlerArg.getText()
      // Vérifier que handlerName correspond à une fonction locale.
      const matchRange = ranges.find((r) => r.name === handlerName)
      const entry: DataFlowEntry = {
        kind: 'event-listener',
        id: `event:${eventName}`,
        file,
        line,
        handler: `${file}:${handlerName}`,
      }
      if (matchRange) {
        entries.push(entry)
      } else {
        // Handler importé — on émet l'entry avec handler non-résolu, le BFS
        // tentera quand même un lookup sur "file:handlerName".
        entries.push(entry)
      }
      return
    }

    // Handler = arrow/function inline → scanner ses sinks directement.
    if (handlerKind === SyntaxKind.ArrowFunction || handlerKind === SyntaxKind.FunctionExpression) {
      const entryId = `${file}:<anon@${line}>`
      const entry: DataFlowEntry = {
        kind: 'event-listener',
        id: `event:${eventName}`,
        file,
        line,
        handler: entryId,
      }
      entries.push(entry)
      // Scan sinks dans le body de l'arrow.
      const body = handlerArg.getBody?.()
      if (body) {
        const sinks: DataFlowSink[] = []
        const fakeRange: FnRange = { start: line, end: (body as any).getEndLineNumber?.() ?? line, name: `<anon@${line}>` }
        scanInlineSinks(body, file, fakeRange, queryFns, emitFns, httpRespFns, bullmqFns, sinks)
        if (sinks.length > 0) inlineSinks.set(entryId, sinks)
      }
    }
  })
}

function scanInlineSinks(
  body: Node,
  file: string,
  fakeRange: FnRange,
  queryFns: Set<string>,
  emitFns: Set<string>,
  httpRespFns: Set<string>,
  bullmqFns: Set<string>,
  out: DataFlowSink[],
): void {
  const containerKey = `${file}:${fakeRange.name}`
  const walk = (n: Node) => {
    if (n.getKind() === SyntaxKind.CallExpression) {
      const call = n as any
      const expr = call.getExpression?.()
      if (expr) {
        const method = getCalleeMethodName(expr)
        if (method) {
          const line = call.getStartLineNumber?.() ?? 0
          const args = call.getArguments?.() ?? []

          if (queryFns.has(method)) {
            const sql = extractLiteralString(args[0])
            if (sql) {
              const t = extractWriteTable(sql)
              if (t) out.push({ kind: 'db-write', target: t, file, line, container: containerKey })
            }
          } else if (emitFns.has(method)) {
            const ev = extractLiteralString(args[0])
            if (ev) out.push({ kind: 'event-emit', target: ev, file, line, container: containerKey })
          } else if (httpRespFns.has(method)) {
            out.push({ kind: 'http-response', target: '', file, line, container: containerKey })
          } else if (bullmqFns.has(method) && expr.getKind() === SyntaxKind.PropertyAccessExpression) {
            const left = (expr as any).getExpression?.()?.getText?.()?.toLowerCase() ?? ''
            if (left.includes('queue')) {
              const job = extractLiteralString(args[0])
              if (job) out.push({ kind: 'bullmq-enqueue', target: job, file, line, container: containerKey })
            }
          }
        }
      }
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

    let matched = false

    if (expr.getKind() === SyntaxKind.Identifier) {
      // Forme : `fetch(url, ...)`, `got(url, ...)`.
      const name = expr.getText()
      if (fns.has(name)) matched = true
    } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      // Forme : `axios.get(url, ...)`, `http.post(url, ...)`.
      const obj = expr.getExpression?.()
      const method = expr.getName?.()
      if (obj && obj.getKind() === SyntaxKind.Identifier && method) {
        const clientName = obj.getText()
        if (clients.has(clientName) && HTTP_OUTBOUND_METHODS.has(method)) {
          matched = true
        }
      }
    }

    if (!matched) return

    const args = call.getArguments?.() ?? []
    let target = '<dynamic>'
    if (args.length > 0) {
      const firstArg = args[0]
      const k = firstArg.getKind?.()
      if (k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral) {
        const url = firstArg.getLiteralText?.() ?? ''
        target = extractHost(url) ?? '<dynamic>'
      }
    }

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

function buildFlow(
  entry: DataFlowEntry,
  sigIndex: Map<string, TypedSignature>,
  edgesByFrom: Map<string, Array<{ from: string; to: string; argTypes: string[]; returnType: string; line: number }>>,
  sinksByContainer: Map<string, DataFlowSink[]>,
  inlineSinks: Map<string, DataFlowSink[]>,
  maxDepth: number,
): DataFlow {
  const steps: DataFlowStep[] = []
  const sinks: DataFlowSink[] = []
  const visited = new Set<string>()
  const queue: Array<{ node: string; depth: number; inputTypes: string[]; outputType?: string }> = []

  if (entry.handler) {
    queue.push({ node: entry.handler, depth: 0, inputTypes: [] })
  }

  while (queue.length > 0) {
    const { node, depth, inputTypes, outputType } = queue.shift()!
    if (visited.has(node)) continue
    visited.add(node)

    const sig = sigIndex.get(node)
    const [file, symbol] = node.split(':')
    steps.push({
      node,
      file: file ?? entry.file,
      symbol: symbol ?? node,
      line: sig?.line ?? entry.line,
      depth,
      inputTypes,
      ...(outputType ? { outputType } : {}),
    })

    // Sinks attachés à cette fonction.
    const contSinks = sinksByContainer.get(node) ?? inlineSinks.get(node) ?? []
    for (const s of contSinks) sinks.push(s)

    if (depth >= maxDepth) continue

    const out = edgesByFrom.get(node) ?? []
    for (const e of out) {
      if (!visited.has(e.to)) {
        queue.push({
          node: e.to,
          depth: depth + 1,
          inputTypes: e.argTypes,
          outputType: e.returnType,
        })
      }
    }
  }

  // Dédup sinks par (kind, target, file, line).
  const dedupSinks = dedup(sinks, (s) => `${s.kind}|${s.target}|${s.file}|${s.line}`)
  dedupSinks.sort(cmpSink)

  // inputType : first param du handler si détectable.
  let inputType: string | undefined
  if (entry.handler) {
    const sig = sigIndex.get(entry.handler)
    if (sig && sig.params.length > 0) inputType = sig.params[0].type
  }

  return {
    entry,
    ...(inputType ? { inputType } : {}),
    steps,
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
