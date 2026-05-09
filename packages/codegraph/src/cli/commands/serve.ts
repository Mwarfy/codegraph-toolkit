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
import { analyze } from '../../core/analyzer.js'
import { CodeGraph } from '../../core/graph.js'
import type { GraphSnapshot } from '../../core/types.js'
import { loadConfig, loadSnapshot as _loadSnapshot, defaultSnapshotPath, analyzeAtRef } from '../_shared.js'

void _loadSnapshot // keep for future routes

export interface ServeOpts {
  port?: string
  config?: string
  snapshot?: string
  diff?: string
}

export async function runServeCommand(opts: ServeOpts): Promise<void> {
  const port = parseInt(opts.port ?? '3333', 10)
  const config = await loadConfig(opts)
  // `import.meta.dirname` n'existe qu'à partir de Node 20.11 ; fileURLToPath
  // est portable sur 20.9+ (contrainte de l'env de dev Sentinel).
  const { fileURLToPath } = await import('node:url')
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web')
  const { execSync } = await import('node:child_process')

  // Preload snapshot and/or diff into web dir
  if (opts.snapshot) {
    await fs.writeFile(
      path.join(webDir, 'snapshot.json'),
      await fs.readFile(opts.snapshot, 'utf-8'),
    )
  }
  if (opts.diff) {
    await fs.writeFile(
      path.join(webDir, 'diff.json'),
      await fs.readFile(opts.diff, 'utf-8'),
    )
  }

  // ── API Helpers ──

  function jsonResponse(res: import('node:http').ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    })
    res.end(JSON.stringify(data))
  }

  function errorResponse(res: import('node:http').ServerResponse, msg: string, status = 500): void {
    jsonResponse(res, { error: msg }, status)
  }

  // ── HTTP Server with API routes + static fallback ──

  const { createServer } = await import('node:http')
  const handler = (await import('serve-handler')).default

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`)
    const pathname = url.pathname

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
      // ── GET /api/snapshots — list available snapshots
      if (pathname === '/api/snapshots') {
        const snapshotDir = config.snapshotDir
        try {
          const files = await fs.readdir(snapshotDir)
          const snapshots = files
            .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
            .sort()
            .reverse()

          const items = await Promise.all(snapshots.map(async (f) => {
            const filePath = path.join(snapshotDir, f)
            const stat = await fs.stat(filePath)
            // Extract commit hash and timestamp from filename
            // Format: snapshot-YYYY-MM-DDTHH-MM-SS-abcdef1.json
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
        return
      }

      // ── GET /api/branches — list git branches
      if (pathname === '/api/branches') {
        try {
          const raw = execSync('git branch -a --format="%(refname:short)|%(objectname:short)|%(committerdate:iso8601)|%(subject)"', {
            cwd: config.rootDir, encoding: 'utf-8', timeout: 10000,
          })
          const currentRaw = execSync('git branch --show-current', {
            cwd: config.rootDir, encoding: 'utf-8', timeout: 5000,
          }).trim()

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
          const logRaw = execSync('git log --oneline -20', {
            cwd: config.rootDir, encoding: 'utf-8', timeout: 10000,
          })
          const recentCommits = logRaw.trim().split('\n').filter(Boolean).map((line) => {
            const [hash, ...msgParts] = line.split(' ')
            return { hash, message: msgParts.join(' ') }
          })

          jsonResponse(res, { branches, current: currentRaw, recentCommits })
        } catch (e: any) {
          errorResponse(res, `Git error: ${e.message}`, 500)
        }
        return
      }

      // ── GET /api/snapshot?file=...  — load a specific snapshot
      if (pathname === '/api/snapshot') {
        const file = url.searchParams.get('file')
        if (!file) { errorResponse(res, 'Missing ?file= parameter', 400); return }
        const filePath = path.join(config.snapshotDir, path.basename(file))
        try {
          const data = await fs.readFile(filePath, 'utf-8')
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(data)
        } catch {
          errorResponse(res, 'Snapshot not found', 404)
        }
        return
      }

      // ── GET /api/diff?before=...&after=... — compute diff between two snapshots or refs
      if (pathname === '/api/diff') {
        const beforeArg = url.searchParams.get('before')
        const afterArg = url.searchParams.get('after')
        if (!beforeArg) { errorResponse(res, 'Missing ?before= parameter', 400); return }

        let before: GraphSnapshot
        let after: GraphSnapshot

        // Resolve "before" — snapshot file or git ref
        if (beforeArg.endsWith('.json')) {
          const p = path.isAbsolute(beforeArg) ? beforeArg : path.join(config.snapshotDir, path.basename(beforeArg))
          before = JSON.parse(await fs.readFile(p, 'utf-8'))
        } else {
          before = await analyzeAtRef(beforeArg, config)
        }

        // Resolve "after" — snapshot file, git ref, or current tree
        if (!afterArg || afterArg === 'current') {
          after = (await analyze(config)).snapshot
        } else if (afterArg.endsWith('.json')) {
          const p = path.isAbsolute(afterArg) ? afterArg : path.join(config.snapshotDir, path.basename(afterArg))
          after = JSON.parse(await fs.readFile(p, 'utf-8'))
        } else {
          after = await analyzeAtRef(afterArg, config)
        }

        const diff = CodeGraph.diff(before, after)

        // Also save to web dir so viewer can reload
        await fs.writeFile(path.join(webDir, 'snapshot.json'), JSON.stringify(after, null, 2))
        await fs.writeFile(path.join(webDir, 'diff.json'), JSON.stringify(diff, null, 2))

        jsonResponse(res, { diff, snapshot: after })
        return
      }

      // ── GET /api/analyze?ref=...  — run analysis at a ref (or current tree)
      if (pathname === '/api/analyze') {
        const ref = url.searchParams.get('ref')
        let snapshot: GraphSnapshot

        if (ref && ref !== 'current') {
          snapshot = await analyzeAtRef(ref, config)
        } else {
          const result = await analyze(config)
          snapshot = result.snapshot
          // Save as new snapshot
          const outPath = await defaultSnapshotPath(config)
          await fs.mkdir(path.dirname(outPath), { recursive: true })
          await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2))
        }

        await fs.writeFile(path.join(webDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2))
        // Clear diff when loading a fresh snapshot
        try { await fs.unlink(path.join(webDir, 'diff.json')) } catch { /* no diff.json to clear — fine */ }

        jsonResponse(res, { snapshot })
        return
      }

      // ── Static file fallback ──
      return handler(req, res, { public: webDir })

    } catch (e: any) {
      errorResponse(res, e.message || 'Internal error', 500)
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
