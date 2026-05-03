// ADR-005
/**
 * CLI shared helpers — extraits du god-file `cli/index.ts` (P2a split).
 *
 * Ces helpers sont importés par `cli/index.ts` ET les modules
 * `cli/commands/<name>.ts` au fur et à mesure des extractions. Tous
 * orientés CLI : I/O fs, fail-fast via `process.exit(1)`, formatting
 * chalk pour le terminal.
 */

import chalk from 'chalk'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { CodeGraphConfig, GraphSnapshot } from '../core/types.js'
import { listDetectorNames, defaultDetectorNames } from '../detectors/index.js'

/**
 * Hydrate un config partiel avec les defaults sensibles. Mutates +
 * returns. Utilisé internalement par `loadConfig` après lecture du
 * fichier ou en fallback no-config.
 */
function applyConfigDefaults(
  cfg: Partial<CodeGraphConfig> & { rootDir: string },
): CodeGraphConfig {
  return {
    rootDir: cfg.rootDir,
    include: cfg.include ?? ['**/*.ts', '**/*.tsx'],
    exclude: cfg.exclude ?? [
      '**/node_modules/**', '**/dist/**', '**/build/**',
      '**/*.test.ts', '**/*.spec.ts', '**/test/**',
      '**/*.d.ts',
    ],
    entryPoints: cfg.entryPoints ?? ['**/server.ts', '**/main.ts', '**/index.ts'],
    detectors: cfg.detectors ?? defaultDetectorNames(),
    snapshotDir: cfg.snapshotDir ?? path.join(cfg.rootDir, '.codegraph'),
    maxSnapshots: cfg.maxSnapshots ?? 50,
    tsconfigPath: cfg.tsconfigPath,
    detectorOptions: cfg.detectorOptions,
    rules: cfg.rules,
    concerns: cfg.concerns,
  }
}

export async function loadConfig(
  opts: { config?: string; root?: string; detectors?: string },
): Promise<CodeGraphConfig> {
  // Try to load config file (--config <path>)
  if (opts.config) {
    const configPath = path.resolve(opts.config)
    if (configPath.endsWith('.json')) {
      const raw = JSON.parse(await fs.readFile(configPath, 'utf-8'))
      // Resolve rootDir relative to config file location
      if (raw.rootDir && !path.isAbsolute(raw.rootDir)) {
        raw.rootDir = path.resolve(path.dirname(configPath), raw.rootDir)
      }
      // --root override : permet au caller d'utiliser la même config
      // (include, entryPoints, detectors) mais de pointer vers un autre
      // checkout du code.
      if (opts.root) {
        raw.rootDir = path.resolve(opts.root)
        if (!raw.snapshotDir || !path.isAbsolute(raw.snapshotDir)) {
          raw.snapshotDir = path.join(raw.rootDir, raw.snapshotDir || '.codegraph')
        }
      } else if (raw.snapshotDir && !path.isAbsolute(raw.snapshotDir)) {
        raw.snapshotDir = path.resolve(path.dirname(configPath), raw.snapshotDir)
      }
      return applyConfigDefaults(raw)
    }
    const mod = await import(configPath)
    return applyConfigDefaults(mod.default || mod)
  }

  // Try default config locations
  const root = path.resolve(opts.root || '.')
  const defaultPaths = [
    path.join(root, 'codegraph.config.ts'),
    path.join(root, 'codegraph.config.js'),
    path.join(root, 'codegraph.config.json'),
  ]

  for (const p of defaultPaths) {
    try {
      // await-ok: probe avec return on first match, séquentiel requis
      await fs.access(p)
      if (p.endsWith('.json')) {
        // await-ok: probe path validé ci-dessus, séquentiel requis (return)
        const raw = JSON.parse(await fs.readFile(p, 'utf-8'))
        if (raw.rootDir && !path.isAbsolute(raw.rootDir)) {
          raw.rootDir = path.resolve(path.dirname(p), raw.rootDir)
        } else if (!raw.rootDir) {
          raw.rootDir = root
        }
        return applyConfigDefaults(raw)
      }
      // await-ok: dynamic import du config TS/JS, séquentiel (return)
      const mod = await import(p)
      return applyConfigDefaults({ rootDir: root, ...(mod.default || mod) })
    } catch {
      // Try next
    }
  }

  // Fallback to sensible defaults
  const detectorNames = opts.detectors
    ? opts.detectors.split(',').map((s) => s.trim())
    : listDetectorNames()

  return {
    rootDir: root,
    include: ['**/*.ts', '**/*.tsx'],
    exclude: [
      '**/node_modules/**', '**/dist/**', '**/build/**',
      '**/*.test.ts', '**/*.spec.ts', '**/test/**',
      '**/*.d.ts',
    ],
    entryPoints: [
      '**/server.ts', '**/main.ts', '**/index.ts',
    ],
    detectors: detectorNames,
    snapshotDir: path.join(root, '.codegraph'),
    maxSnapshots: 50,
  }
}

/**
 * Charge un snapshot — soit depuis un path explicite, soit depuis le
 * dernier `snapshot-*.json` dans `config.snapshotDir`. Process exit (1)
 * si rien trouvé — pattern CLI fail-fast.
 */
export async function loadSnapshot(
  snapshotPath?: string,
  opts?: { config?: string },
): Promise<GraphSnapshot> {
  if (snapshotPath) {
    return JSON.parse(await fs.readFile(snapshotPath, 'utf-8'))
  }

  const config = await loadConfig(opts || {})
  const snapshotDir = config.snapshotDir

  try {
    const files = await fs.readdir(snapshotDir)
    // Filtre strict sur `snapshot-*.json` pour ne pas collecter les
    // dérivés synopsis.json et diff.json qui vivent dans le même dossier.
    const snapshots = files
      .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse()

    if (snapshots.length === 0) {
      console.error(chalk.red('No snapshots found. Run "codegraph analyze" first.'))
      process.exit(1)
    }

    return JSON.parse(
      await fs.readFile(path.join(snapshotDir, snapshots[0]), 'utf-8'),
    )
  } catch {
    console.error(chalk.red(`Snapshot directory not found: ${snapshotDir}`))
    console.error(chalk.dim('Run "codegraph analyze" first to generate a snapshot.'))
    process.exit(1)
  }
}

/**
 * Keeps the most recent `keep` snapshots in `dir`, deletes the rest.
 * Returns the number deleted. Only touches files matching `snapshot-*.json`.
 */
export async function pruneSnapshots(dir: string, keep: number): Promise<number> {
  if (!Number.isFinite(keep) || keep <= 0) return 0
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return 0
  }
  const snapshots = files
    .filter((f) => f.startsWith('snapshot-') && f.endsWith('.json'))
    .sort()                                                              // timestamp lex-sortable
    .reverse()                                                           // newest first
  if (snapshots.length <= keep) return 0
  const toDelete = snapshots.slice(keep)
  // Delete N stale snapshots en parallèle (fichiers indépendants).
  const results = await Promise.all(
    toDelete.map(async (f): Promise<number> => {
      try {
        await fs.unlink(path.join(dir, f))
        return 1
      } catch {
        return 0  // skip silently — one stale file shouldn't break the analyze
      }
    }),
  )
  return results.reduce((a, b) => a + b, 0)
}

/**
 * Construit un path de snapshot avec timestamp + commit hash optionnel.
 * Format : `snapshot-2026-05-03T12-34-56-abc1234.json`.
 */
export async function defaultSnapshotPath(config: CodeGraphConfig): Promise<string> {
  const dir = config.snapshotDir
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  let suffix = ''
  try {
    const { execSync } = await import('node:child_process')
    suffix = '-' + execSync('git rev-parse --short HEAD', {
      cwd: config.rootDir, encoding: 'utf-8',
    }).trim()
  } catch {
    // Not a git repo
  }

  return path.join(dir, `snapshot-${timestamp}${suffix}.json`)
}

/** Format un score de santé [0,1] en pourcentage coloré. */
export function formatHealth(score: number): string {
  const pct = Math.round(score * 100)
  if (pct >= 90) return chalk.green(`${pct}%`)
  if (pct >= 70) return chalk.yellow(`${pct}%`)
  return chalk.red(`${pct}%`)
}

/** Sync-style fs.exists — utilisé par les commands pour gate des paths. */
export async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true } catch { return false }
}

/**
 * Run codegraph analyze on a past git ref by temporarily checking out
 * a worktree, running analyze, then cleaning up.
 *
 * Utilisé par `diff`, `arch-check`, `serve` (3 commands).
 */
export async function analyzeAtRef(
  ref: string,
  config: CodeGraphConfig,
): Promise<GraphSnapshot> {
  const { execSync } = await import('node:child_process')
  const { analyze } = await import('../core/analyzer.js')
  const tmpDir = path.join(config.rootDir, '.codegraph', `_worktree_${Date.now()}`)

  try {
    const hash = execSync(`git rev-parse ${ref}`, {
      cwd: config.rootDir, encoding: 'utf-8',
    }).trim()

    execSync(`git worktree add --detach "${tmpDir}" ${hash}`, {
      cwd: config.rootDir, encoding: 'utf-8', stdio: 'pipe',
    })

    const tmpConfig: CodeGraphConfig = {
      ...config,
      rootDir: tmpDir,
      snapshotDir: path.join(tmpDir, '.codegraph'),
    }

    const result = await analyze(tmpConfig)
    result.snapshot.commitHash = hash.slice(0, 7)
    return result.snapshot
  } finally {
    // Best-effort cleanup. Si remove échoue, fallback fs.rm + worktree prune.
    try {
      execSync(`git worktree remove --force "${tmpDir}"`, {
        cwd: config.rootDir, encoding: 'utf-8', stdio: 'pipe',
      })
    } catch {
      try { await fs.rm(tmpDir, { recursive: true }) } catch { /* nothing */ }
      try {
        execSync(`git worktree prune`, { cwd: config.rootDir, stdio: 'pipe' })
      } catch { /* nothing */ }
    }
  }
}
