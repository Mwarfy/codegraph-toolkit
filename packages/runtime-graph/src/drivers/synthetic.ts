// ADR-011
/**
 * Synthetic driver — provoque l'exécution en lançant des requêtes HTTP
 * sur les routes que le codegraph statique a découvertes.
 *
 * Pattern Phase α : on lit `.codegraph/facts/EntryPoint.facts` (extrait
 * par `npx codegraph analyze` du toolkit), filtre les rows kind='http-route',
 * et pour chacune issue un curl.
 *
 * Body génération : minimal en α (POST → `{}`, GET → no body). Phase β
 * ajoutera Zod-fuzzer pour générer du payload réaliste à partir des schemas
 * Zod détectés dans le code.
 *
 * Le driver ne configure PAS la capture OTel — celle-ci est attachée au
 * boot du process observé. Le driver suppose que l'app cible tourne déjà
 * sur baseUrl (config.config.baseUrl) avec l'OTel SDK actif.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Driver, DriverRunOptions, DriverRunResult } from '../core/types.js'

interface SyntheticConfig {
  /** URL de base de l'app cible. Default: http://localhost:3000 */
  baseUrl?: string
  /** Path du facts dir codegraph statique. Default: <projectRoot>/.codegraph/facts */
  staticFactsDir?: string
  /** Délai entre requêtes en ms. Default: 100 */
  requestDelayMs?: number
  /** Méthodes HTTP à exclure (ex: DELETE). Default: ['DELETE'] */
  excludeMethods?: string[]
  /** Routes glob à exclure (ex: '/admin/*'). Default: [] */
  excludePaths?: string[]
}

interface EntryPointRow {
  file: string
  kind: string
  id: string
}

export const syntheticDriver: Driver = {
  name: 'synthetic',
  async run(opts: DriverRunOptions): Promise<DriverRunResult> {
    const config: SyntheticConfig = (opts.config as SyntheticConfig) ?? {}
    const baseUrl = config.baseUrl ?? 'http://localhost:3000'
    const staticFactsDir = config.staticFactsDir ?? path.join(opts.projectRoot, '.codegraph/facts')
    const requestDelayMs = config.requestDelayMs ?? 100
    const excludeMethods = new Set(config.excludeMethods ?? ['DELETE'])
    const excludePaths = config.excludePaths ?? []

    const warnings: string[] = []

    // Lire EntryPoint.facts
    const entryPoints = await readEntryPoints(staticFactsDir)
    if (entryPoints.length === 0) {
      warnings.push(`No EntryPoint facts found in ${staticFactsDir}. Run \`npx codegraph analyze\` first.`)
      return { actionsCount: 0, warnings }
    }

    // Filter HTTP routes
    const httpRoutes = entryPoints
      .filter(ep => ep.kind === 'http-route')
      .map(ep => parseRouteId(ep.id))
      .filter((r): r is { method: string; path: string } => r !== null)
      .filter(r => !excludeMethods.has(r.method))
      .filter(r => !excludePaths.some(glob => globMatch(glob, r.path)))

    if (httpRoutes.length === 0) {
      warnings.push('No HTTP routes after filtering. Check excludeMethods / excludePaths.')
      return { actionsCount: 0, warnings }
    }

    // Loop : issue request per route. Respect durationMs as a hard timeout.
    const startTime = Date.now()
    const deadline = startTime + opts.durationMs
    let actionsCount = 0

    for (const route of httpRoutes) {
      if (Date.now() >= deadline) break

      try {
        await issueRequest(baseUrl, route.method, route.path)
        actionsCount++
      } catch (err) {
        warnings.push(
          `${route.method} ${route.path}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      // await-ok: rate-limit between requests (driver = sequential by design,
      // burst would skew latency measurement)
      await sleep(requestDelayMs)
    }

    return { actionsCount, warnings }
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function readEntryPoints(factsDir: string): Promise<EntryPointRow[]> {
  const file = path.join(factsDir, 'EntryPoint.facts')
  try {
    const content = await fs.readFile(file, 'utf-8')
    return content
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => {
        const [file, kind, id] = line.split('\t')
        return { file, kind, id }
      })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * Parse une route id du format codegraph.
 * Codegraph encode les routes comme `<METHOD> <PATH>` ou parfois juste path.
 * On accepte les deux formes pour robustesse.
 */
function parseRouteId(id: string): { method: string; path: string } | null {
  const trimmed = id.trim()
  // Form 1: "GET /api/orders"
  const m = trimmed.match(/^([A-Z]+)\s+(\/.*)$/)
  if (m) return { method: m[1], path: m[2] }
  // Form 2: just path (assume GET)
  if (trimmed.startsWith('/')) return { method: 'GET', path: trimmed }
  return null
}

async function issueRequest(baseUrl: string, method: string, routePath: string): Promise<void> {
  // Strip OpenAPI param syntax for synthetic curl :
  //   /api/users/:id   → /api/users/1
  //   /api/users/{id}  → /api/users/1
  const concretePath = routePath.replace(/[:{][^/}]+[}]?/g, '1')
  const url = `${baseUrl.replace(/\/$/, '')}${concretePath}`

  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5000),
  }
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    init.body = JSON.stringify({})                                     // empty body — minimal Zod-fuzz in α
  }

  const res = await fetch(url, init)
  // We don't care about the status — even a 4xx/5xx is a valid runtime touch.
  // The HttpRouteHit fact will record the status and let datalog rules decide.
  void res.status
  // Drain body to free socket
  await res.text().catch(() => undefined)
}

function globMatch(glob: string, path: string): boolean {
  // Simple glob : * matches any non-/ segment, ** matches any.
  const re = new RegExp('^' + glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*') + '$')
  return re.test(path)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
