/**
 * Chaos driver — error injection ciblée sur les entry points HTTP.
 *
 * Pourquoi : `synthetic` driver fait des happy-path requests (body=`{}`,
 * params=`1`). Mais le code applicatif a aussi des error paths (validation
 * fail, type mismatch, missing auth). Sans les exercer, on flag à tort
 * les error handlers comme "dead".
 *
 * Approche Phase β minimale : pour chaque route HTTP statique-discoverée,
 * on issue plusieurs requêtes avec des payloads MAL FORMÉS systematiquement :
 *   - GET /resource/:id → /resource/<INVALID_UUID>, /resource/null, /resource/-1
 *   - POST → body=invalid_json, body=large_string, body=missing_field
 *   - Header injection : missing auth, malformed Content-Type
 *
 * Le but : forcer le code à emprunter ses error paths pour les capturer
 * dans les facts runtime. Les status 4xx/5xx sont "valides" (ne fail pas
 * le driver). Phase γ ajoutera Markov chain sampling sur les patterns
 * d'erreurs observés en prod (chaos engineering data-driven).
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Driver, DriverRunOptions, DriverRunResult } from '../core/types.js'

interface ChaosConfig {
  /** Base URL de l'app cible. Default: http://localhost:3000 */
  baseUrl?: string
  /** Path du facts dir codegraph statique. */
  staticFactsDir?: string
  /** Délai entre requêtes (ms). Default: 50 (plus rapide que synthetic — chaos = volume). */
  requestDelayMs?: number
  /** Méthodes HTTP exclues. Default: ['DELETE'] */
  excludeMethods?: string[]
  /** Nombre de variantes chaos par route. Default: 5 */
  variantsPerRoute?: number
}

interface EntryPointRow {
  file: string
  kind: string
  id: string
}

export const chaosDriver: Driver = {
  name: 'chaos',
  async run(opts: DriverRunOptions): Promise<DriverRunResult> {
    const config: ChaosConfig = (opts.config as ChaosConfig) ?? {}
    const baseUrl = config.baseUrl ?? 'http://localhost:3000'
    const staticFactsDir = config.staticFactsDir ?? path.join(opts.projectRoot, '.codegraph/facts')
    const requestDelayMs = config.requestDelayMs ?? 50
    const excludeMethods = new Set(config.excludeMethods ?? ['DELETE'])
    const variantsPerRoute = config.variantsPerRoute ?? 5

    const warnings: string[] = []
    const entryPoints = await readEntryPoints(staticFactsDir)
    if (entryPoints.length === 0) {
      warnings.push(`No EntryPoint facts in ${staticFactsDir}. Run \`npx codegraph analyze\` first.`)
      return { actionsCount: 0, warnings }
    }

    const httpRoutes = entryPoints
      .filter(ep => ep.kind === 'http-route')
      .map(ep => parseRouteId(ep.id))
      .filter((r): r is { method: string; path: string } => r !== null)
      .filter(r => !excludeMethods.has(r.method))

    if (httpRoutes.length === 0) {
      warnings.push('No HTTP routes after filtering.')
      return { actionsCount: 0, warnings }
    }

    const startTime = Date.now()
    const deadline = startTime + opts.durationMs
    let actionsCount = 0

    // Pour chaque route : génère N variants chaos et issue les requêtes.
    // Loop until deadline OR all variants done.
    outer: for (const route of httpRoutes) {
      for (let i = 0; i < variantsPerRoute; i++) {
        if (Date.now() >= deadline) break outer
        const variant = chaosVariant(route, i)
        try {
          await issueChaosRequest(baseUrl, route.method, variant.path, variant.body, variant.headers)
          actionsCount++
        } catch (err) {
          warnings.push(`${route.method} ${variant.path}: ${err instanceof Error ? err.message : String(err)}`)
        }
        await sleep(requestDelayMs)
      }
    }

    return { actionsCount, warnings }
  },
}

// ─── Chaos variant generation ─────────────────────────────────────────────

interface Variant {
  path: string
  body: string | null
  headers: Record<string, string>
}

/**
 * Génère un variant chaos pour une route.
 * Index 0 = happy-ish, 1+ = progressivement plus chaotic.
 *
 * Phase β minimal : 5 variants nominaux. Phase γ ajoutera Markov-chain
 * variants sampled depuis prod error patterns.
 */
function chaosVariant(route: { method: string; path: string }, idx: number): Variant {
  const baseHeaders = { 'content-type': 'application/json' }
  const concretePath = (subst: string) =>
    route.path.replace(/[:{][^/}]+[}]?/g, subst)

  switch (idx % 5) {
    case 0:
      // Invalid path param
      return { path: concretePath('not-a-valid-id'), body: null, headers: baseHeaders }
    case 1:
      // Negative number / boundary
      return { path: concretePath('-1'), body: null, headers: baseHeaders }
    case 2:
      // Malformed JSON body for write methods
      return {
        path: concretePath('1'),
        body: route.method === 'GET' ? null : '{ not valid json',
        headers: baseHeaders,
      }
    case 3:
      // Missing content-type header
      return {
        path: concretePath('1'),
        body: route.method === 'GET' ? null : '{}',
        headers: {},
      }
    case 4:
      // Unicode / extreme characters
      return {
        path: concretePath('💥%00xss'),
        body: null,
        headers: baseHeaders,
      }
    default:
      return { path: concretePath('1'), body: null, headers: baseHeaders }
  }
}

async function issueChaosRequest(
  baseUrl: string,
  method: string,
  routePath: string,
  body: string | null,
  headers: Record<string, string>,
): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}${routePath}`
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(5000),
  }
  if (body !== null && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    init.body = body
  }
  const res = await fetch(url, init)
  // Chaos = on accepte tout status (200, 4xx, 5xx). Le span runtime
  // sera capturé peu importe le status, et la rule HTTP_ERROR_RATE
  // (Phase γ) pourra détecter les patterns intéressants.
  void res.status
  await res.text().catch(() => undefined)
}

// ─── Shared helpers (could be extracted to drivers/_common.ts en Phase γ) ──

async function readEntryPoints(factsDir: string): Promise<EntryPointRow[]> {
  const file = path.join(factsDir, 'EntryPoint.facts')
  try {
    const content = await fs.readFile(file, 'utf-8')
    return content.split('\n').filter(l => l.trim()).map(line => {
      const [file, kind, id] = line.split('\t')
      return { file, kind, id }
    })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

function parseRouteId(id: string): { method: string; path: string } | null {
  const m = id.trim().match(/^([A-Z]+)\s+(\/.*)$/)
  if (m) return { method: m[1], path: m[2] }
  if (id.startsWith('/')) return { method: 'GET', path: id }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
