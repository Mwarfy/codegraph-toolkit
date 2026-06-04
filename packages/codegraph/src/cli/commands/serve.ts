// ADR-005
/**
 * `codegraph serve` — local HTTP server pour le web viewer + API live.
 *
 * Routes API exposées :
 *   - GET /api/snapshots             list saved snapshots
 *   - GET /api/branches              list git branches + recent commits
 *   - GET /api/snapshot?file=        load a snapshot
 *   - GET /api/diff?before=&after=   compute diff between snapshots/refs
 *   - GET /api/analyze?ref=          run analysis at a ref (or current)
 *   - * fallback : serve static depuis dist/web
 *
 * Extrait du god-file `cli/index.ts` (P2b split — plus gros bloc inline).
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ServerResponse } from 'node:http'
import { analyze } from '../../core/analyzer.js'
import { CodeGraph } from '../../core/graph.js'
import type { GraphSnapshot, CodeGraphConfig } from '../../core/types.js'
import { loadConfig, loadSnapshot as _loadSnapshot, defaultSnapshotPath, analyzeAtRef } from '../_shared.js'
import { listAllSnapshotPaths } from '../../incremental/snapshot-loader.js'

void _loadSnapshot // keep for future routes

export interface ServeOpts {
  port?: string
  config?: string
  snapshot?: string
  diff?: string
}

/** Contexte partagé par les route handlers. */
interface ServeContext {
  config: CodeGraphConfig
  webDir: string
}

// ── exec git (execFileSync : pas de shell, args en array → pas d'injection) ──

function gitOutput(args: string[], cwd: string, timeoutMs: number): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: timeoutMs })
}

// ── API response helpers ──

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(JSON.stringify(data))
}

function errorResponse(res: ServerResponse, msg: string, status = 500): void {
  jsonResponse(res, { error: msg }, status)
}

// ── Route handlers ──

// ADR-027 : délégué au loader unifié (`incremental/snapshot-loader.ts`)
// qui retourne le v2 canonique + backups + legacy historiques.
/** GET /api/snapshots — liste les snapshots disponibles. */
async function handleSnapshots(res: ServerResponse, ctx: ServeContext): Promise<void> {
  try {
    const { all } = await listAllSnapshotPaths(ctx.config.snapshotDir)
    const items = await Promise.all(all.map(async (filePath) => {
      const stat = await fs.stat(filePath)
      const f = path.basename(filePath)
      const match = f.match(/^snapshot-(.+?)(?:-([a-f0-9]{7,}))?\.json$/)
      return {
        file: f,
        path: filePath,
        timestamp: match?.[1]?.replace(/T/, ' ').replace(/-/g, (m, i) => i > 9 ? ':' : '-') || f,
        commitHash: match?.[2] || null,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      }
    }))
    jsonResponse(res, { snapshots: items })
  } catch {
    jsonResponse(res, { snapshots: [] })
  }
}

/** GET /api/branches — liste les branches git + commits récents. */
async function handleBranches(res: ServerResponse, ctx: ServeContext): Promise<void> {
  try {
    const raw = gitOutput(
      ['branch', '-a', '--format=%(refname:short)|%(objectname:short)|%(committerdate:iso8601)|%(subject)'],
      ctx.config.rootDir, 10000,
    )
    const currentRaw = gitOutput(['branch', '--show-current'], ctx.config.rootDir, 5000).trim()

    const branches = raw.trim().split('\n').filter(Boolean).map((line) => {
      const [name, hash, date, ...msgParts] = line.split('|')
      return {
        name: name.trim(),
        hash: hash.trim(),
        date: date.trim(),
        message: msgParts.join('|').trim(),
        current: name.trim() === currentRaw,
      }
    })

    // Also get recent commits for quick ref picking
    const logRaw = gitOutput(['log', '--oneline', '-20'], ctx.config.rootDir, 10000)
    const recentCommits = logRaw.trim().split('\n').filter(Boolean).map((line) => {
      const [hash, ...msgParts] = line.split(' ')
      return { hash, message: msgParts.join(' ') }
    })

    jsonResponse(res, { branches, current: currentRaw, recentCommits })
  } catch (e) {
    errorResponse(res, `Git error: ${e instanceof Error ? e.message : String(e)}`, 500)
  }
}

/** GET /api/snapshot?file=... — charge un snapshot spécifique. */
async function handleSnapshot(res: ServerResponse, url: URL, ctx: ServeContext): Promise<void> {
  const file = url.searchParams.get('file')
  if (!file) { errorResponse(res, 'Missing ?file= parameter', 400); return }
  const filePath = path.join(ctx.config.snapshotDir, path.basename(file))
  try {
    const data = await fs.readFile(filePath, 'utf-8')
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(data)
  } catch {
    errorResponse(res, 'Snapshot not found', 404)
  }
}

/** Résout un argument (fichier `.json` ou git ref) en snapshot. */
async function resolveSnapshotArg(arg: string, ctx: ServeContext): Promise<GraphSnapshot> {
  if (arg.endsWith('.json')) {
    const p = path.isAbsolute(arg) ? arg : path.join(ctx.config.snapshotDir, path.basename(arg))
    return JSON.parse(await fs.readFile(p, 'utf-8'))
  }
  return analyzeAtRef(arg, ctx.config)
}

/** GET /api/diff?before=&after= — diff entre deux snapshots/refs. */
async function handleDiff(res: ServerResponse, url: URL, ctx: ServeContext): Promise<void> {
  const beforeArg = url.searchParams.get('before')
  const afterArg = url.searchParams.get('after')
  if (!beforeArg) { errorResponse(res, 'Missing ?before= parameter', 400); return }

  const before = await resolveSnapshotArg(beforeArg, ctx)
  const after = (!afterArg || afterArg === 'current')
    ? (await analyze(ctx.config)).snapshot
    : await resolveSnapshotArg(afterArg, ctx)

  const diff = CodeGraph.diff(before, after)

  // Also save to web dir so viewer can reload
  await fs.writeFile(path.join(ctx.webDir, 'snapshot.json'), JSON.stringify(after, null, 2))
  await fs.writeFile(path.join(ctx.webDir, 'diff.json'), JSON.stringify(diff, null, 2))

  jsonResponse(res, { diff, snapshot: after })
}

/** GET /api/analyze?ref=... — analyse à un ref (ou current tree). */
async function handleAnalyze(res: ServerResponse, url: URL, ctx: ServeContext): Promise<void> {
  const ref = url.searchParams.get('ref')
  let snapshot: GraphSnapshot

  if (ref && ref !== 'current') {
    snapshot = await analyzeAtRef(ref, ctx.config)
  } else {
    snapshot = (await analyze(ctx.config)).snapshot
    // Save as new snapshot
    const outPath = await defaultSnapshotPath(ctx.config)
    await fs.mkdir(path.dirname(outPath), { recursive: true })
    await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2))
  }

  await fs.writeFile(path.join(ctx.webDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2))
  // Clear diff when loading a fresh snapshot
  try { await fs.unlink(path.join(ctx.webDir, 'diff.json')) } catch { /* no diff.json to clear — fine */ }

  jsonResponse(res, { snapshot })
}

/** Dispatch une route /api/*. Retourne false si non gérée (→ static fallback). */
async function routeApi(url: URL, res: ServerResponse, ctx: ServeContext): Promise<boolean> {
  switch (url.pathname) {
    case '/api/snapshots': await handleSnapshots(res, ctx); return true
    case '/api/branches': await handleBranches(res, ctx); return true
    case '/api/snapshot': await handleSnapshot(res, url, ctx); return true
    case '/api/diff': await handleDiff(res, url, ctx); return true
    case '/api/analyze': await handleAnalyze(res, url, ctx); return true
    default: return false
  }
}

export async function runServeCommand(opts: ServeOpts): Promise<void> {
  const port = parseInt(opts.port ?? '3333', 10)
  const config = await loadConfig(opts)
  // `import.meta.dirname` n'existe qu'à partir de Node 20.11 ; fileURLToPath
  // est portable sur 20.9+ (contrainte de l'env de dev Sentinel).
  const { fileURLToPath } = await import('node:url')
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web')
  const ctx: ServeContext = { config, webDir }

  // Preload snapshot and/or diff into web dir
  if (opts.snapshot) {
    await fs.writeFile(path.join(webDir, 'snapshot.json'), await fs.readFile(opts.snapshot, 'utf-8'))
  }
  if (opts.diff) {
    await fs.writeFile(path.join(webDir, 'diff.json'), await fs.readFile(opts.diff, 'utf-8'))
  }

  const { createServer } = await import('node:http')
  const handler = (await import('serve-handler')).default

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end()
      return
    }

    try {
      if (await routeApi(url, res, ctx)) return
      // Static file fallback
      return handler(req, res, { public: webDir })
    } catch (e) {
      errorResponse(res, e instanceof Error ? e.message : 'Internal error', 500)
    }
  })

  server.listen(port, () => {
    console.log(chalk.bold(`\n🌐 CodeGraph Viewer`))
    console.log(`   ${chalk.cyan(`http://localhost:${port}`)}\n`)
    console.log(chalk.dim('   API endpoints:'))
    console.log(chalk.dim('     GET /api/snapshots       — list saved snapshots'))
    console.log(chalk.dim('     GET /api/branches        — list git branches + recent commits'))
    console.log(chalk.dim('     GET /api/snapshot?file=  — load a snapshot'))
    console.log(chalk.dim('     GET /api/diff?before=&after=  — compute diff'))
    console.log(chalk.dim('     GET /api/analyze?ref=    — run analysis\n'))
    console.log(chalk.dim('   Press Ctrl+C to stop\n'))
  })
}
