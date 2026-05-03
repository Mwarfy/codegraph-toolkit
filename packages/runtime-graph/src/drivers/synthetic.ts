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
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Driver, DriverRunOptions, DriverRunResult } from '../core/types.js'
import { readEntryPoints, parseRouteId, sleep, type EntryPointRow } from './_common.js'

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
  /**
   * SPAWN MODE (bug #3 fix) : si défini, le driver démarre l'app
   * lui-même (avec OTel auto-bootstrap pré-attaché), attend qu'elle
   * soit prête, exerce les routes, puis kill cleanly.
   *
   * Avant ce mode : l'utilisateur devait manuellement lancer son app
   * avec NODE_OPTIONS=--require ... auto-bootstrap.js avant d'exécuter
   * le driver. Fragile et pas reproductible.
   */
  spawn?: {
    /** Command to run (ex: 'node', 'npx', 'bun'). */
    cmd: string
    /** Args (ex: ['app.js'], ['tsx', 'server.ts']). */
    args: string[]
    /** cwd pour le spawn. Default: projectRoot. */
    cwd?: string
    /** Timeout pour que l'app soit ready (port open). Default: 30s. */
    readyTimeoutMs?: number
    /** Path du auto-bootstrap.js (injecté via NODE_OPTIONS). */
    bootstrapPath?: string
    /** Env vars supplémentaires pour le spawn. */
    env?: Record<string, string>
  }
}

// EntryPointRow imported from ./_common (NCD dedup).

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

    // ─── SPAWN MODE (bug #3 fix) — driver démarre l'app lui-même ────────
    let spawned: ChildProcess | null = null
    if (config.spawn) {
      try {
        spawned = await spawnAppWithBootstrap(config.spawn, baseUrl, opts.projectRoot)
      } catch (err) {
        warnings.push(`spawn failed: ${err instanceof Error ? err.message : String(err)}`)
        return { actionsCount: 0, warnings }
      }
    }

    try {
      const result = await runSyntheticRequests({
        baseUrl, staticFactsDir, requestDelayMs,
        excludeMethods, excludePaths, durationMs: opts.durationMs, warnings,
      })
      return result
    } finally {
      // Toujours kill le spawn — sinon l'app fuit entre les runs.
      if (spawned) {
        spawned.kill('SIGTERM')
        // Wait briefly for graceful exit, then SIGKILL
        await sleep(500)
        if (!spawned.killed) spawned.kill('SIGKILL')
      }
    }
  },
}

interface SyntheticRequestsArgs {
  baseUrl: string
  staticFactsDir: string
  requestDelayMs: number
  excludeMethods: Set<string>
  excludePaths: string[]
  durationMs: number
  warnings: string[]
}

async function runSyntheticRequests(args: SyntheticRequestsArgs): Promise<DriverRunResult> {
  const {
    baseUrl, staticFactsDir, requestDelayMs,
    excludeMethods, excludePaths, durationMs, warnings,
  } = args
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
    const deadline = startTime + durationMs
    let actionsCount = 0

    for (const route of httpRoutes) {
      if (Date.now() >= deadline) break

      try {
        // await-ok: driver synthetic — séquentiel par design (rate-limit + observability)
        await issueRequest(baseUrl, route.method, route.path)
        actionsCount++
      } catch (err) {
        warnings.push(
          `${route.method} ${route.path}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      // await-ok: rate-limit between requests — burst would skew latency measurement
      await sleep(requestDelayMs)
    }

    return { actionsCount, warnings }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Spawn l'app avec OTel auto-bootstrap pré-attaché via NODE_OPTIONS.
 * Attend que le baseUrl répond avant de retourner. Fix bug #3.
 */
async function spawnAppWithBootstrap(
  spawnCfg: NonNullable<SyntheticConfig['spawn']>,
  baseUrl: string,
  projectRoot: string,
): Promise<ChildProcess> {
  // Path du auto-bootstrap.js : par défaut, on suppose que runtime-graph
  // est installé comme dep et résolvable. Sinon utilisateur passe un path.
  let bootstrapPath = spawnCfg.bootstrapPath
  if (!bootstrapPath) {
    // Resolve depuis ce module → ../capture/auto-bootstrap.js
    const __filename = fileURLToPath(import.meta.url)
    bootstrapPath = path.resolve(path.dirname(__filename), '../capture/auto-bootstrap.js')
  }

  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${bootstrapPath}`.trim(),
    LIBY_RUNTIME_PROJECT_ROOT: projectRoot,
    ...spawnCfg.env,
  }

  const child = spawn(spawnCfg.cmd, spawnCfg.args, {
    cwd: spawnCfg.cwd ?? projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Wait for app to be ready : poll baseUrl until 200 or timeout.
  const readyTimeout = spawnCfg.readyTimeoutMs ?? 30_000
  const deadline = Date.now() + readyTimeout
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`spawned process exited early with code ${child.exitCode}`)
    }
    try {
      // await-ok: readiness probe loop — séquentiel par design (poll + sleep)
      const res = await fetch(baseUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      })
      // Any HTTP response (even 404) means the server is alive.
      if (res.status >= 0) return child
    } catch {
      // ECONNREFUSED / timeout — keep polling
    }
    // await-ok: backoff entre poll iterations
    await sleep(250)
  }
  child.kill('SIGKILL')
  throw new Error(`spawned app did not become ready at ${baseUrl} within ${readyTimeout}ms`)
}

// readEntryPoints + parseRouteId moved to ./_common (NCD dedup).

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

// sleep moved to ./_common (NCD dedup).
