// ADR-011
/**
 * replay-tests driver — lance la suite de tests existante du projet
 * sous OTel SDK pre-attached, pour capturer un run runtime à HAUTE
 * couverture sans driver synthetic dédié.
 *
 * Pourquoi : 99% des projets TS ont déjà une suite vitest/jest qui
 * exerce les paths nominaux. Plutôt que d'écrire un driver synthetic
 * dédié, on REJOUE cette suite avec OTel actif → couverture max gratuite.
 *
 * Architecture sub-process :
 *   - On spawn `npm test` (ou commande custom) avec NODE_OPTIONS
 *     "--require @liby-tools/runtime-graph/capture/auto"
 *   - Le bootstrap attache OTel AU CHARGEMENT du process node enfant
 *   - Le bootstrap hook process.on('exit') pour flush facts → tmpDir
 *   - On lit les facts du tmpDir + merge dans notre snapshot principal
 *
 * Pourquoi sub-process et pas in-process :
 *   - vitest a son propre worker pool — un attach in-process ne capture
 *     pas les workers
 *   - jest pareil
 *   - le sub-process garantit l'isolation et la coverage complete
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Driver, DriverRunOptions, DriverRunResult } from '../core/types.js'

interface ReplayTestsConfig {
  /** Commande à lancer. Default : npm test. */
  command?: string
  /** Args. Default : []. Si command='npm' on append 'test'. */
  args?: string[]
  /** Working dir. Default : projectRoot. */
  cwd?: string
  /** Continuer même si la suite de tests échoue (exit non-zero). Default true. */
  continueOnTestFailure?: boolean
  /** Délai max d'attente pour le sub-process. Default : durationMs * 0.95. */
  timeoutMs?: number
  /** Activer auto-instruments dans le sub-process. Default : true. */
  enableAutoInstruments?: boolean
}

export const replayTestsDriver: Driver = {
  name: 'replay-tests',
  async run(opts: DriverRunOptions): Promise<DriverRunResult> {
    const config: ReplayTestsConfig = (opts.config as ReplayTestsConfig) ?? {}
    const command = config.command ?? 'npm'
    const args = config.args ?? (command === 'npm' ? ['test'] : [])
    const cwd = config.cwd ?? opts.projectRoot
    const continueOnFailure = config.continueOnTestFailure ?? true
    const timeoutMs = config.timeoutMs ?? Math.floor(opts.durationMs * 0.95)
    const enableAutoInstruments = config.enableAutoInstruments ?? true

    const warnings: string[] = []

    // Tmp dir pour collecter les facts du sub-process
    const factsBootstrapDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rg-replay-'))

    // Resolve auto-bootstrap path. Le package est installé soit
    // npm-linked soit publié — dans les deux cas le path est sous
    // node_modules/@liby-tools/runtime-graph/dist/capture/auto-bootstrap.js
    const bootstrapPath = await resolveBootstrapPath(opts.projectRoot)
    if (!bootstrapPath) {
      warnings.push('@liby-tools/runtime-graph/capture/auto bootstrap not found. Install via npm.')
      return { actionsCount: 0, warnings }
    }

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${bootstrapPath}`.trim(),
          LIBY_RUNTIME_PROJECT_ROOT: opts.projectRoot,
          LIBY_RUNTIME_FACTS_OUT: factsBootstrapDir,
          LIBY_RUNTIME_AUTO_INSTRUMENTS: enableAutoInstruments ? 'true' : 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c))
      child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        warnings.push(`replay-tests timed out after ${timeoutMs}ms — killed sub-process`)
      }, timeoutMs)

      child.on('error', (err) => {
        clearTimeout(timer)
        warnings.push(`spawn ${command}: ${err.message}`)
        resolve({ actionsCount: 0, warnings })
      })

      child.on('exit', async (code) => {
        clearTimeout(timer)

        if (code !== 0 && !continueOnFailure) {
          const stderr = Buffer.concat(stderrChunks).toString('utf-8').slice(-500)
          warnings.push(`test sub-process exited code=${code}\nstderr tail:\n${stderr}`)
          // Cleanup tmpDir (no facts to merge)
          await fs.rm(factsBootstrapDir, { recursive: true, force: true }).catch(() => undefined)
          resolve({ actionsCount: 0, warnings })
          return
        }
        if (code !== 0) {
          warnings.push(`test sub-process exited code=${code} (continuing — facts may be partial)`)
        }

        // Read RuntimeRunMeta to extract spans count for actionsCount.
        // Don't cleanup tmpDir — caller merges via bootstrapFactsDir field
        // and is responsible for cleanup.
        const spansCount = await readBootstrapMetaSpans(factsBootstrapDir)

        resolve({
          actionsCount: spansCount,
          warnings,
          bootstrapFactsDir: factsBootstrapDir,
        })
      })
    })
  },
}

/**
 * Resolve le path absolu de auto-bootstrap.js dans node_modules du projet
 * observé. Robust : essaye plusieurs locations standards.
 */
async function resolveBootstrapPath(projectRoot: string): Promise<string | null> {
  const candidates = [
    // Standard install
    path.join(projectRoot, 'node_modules/@liby-tools/runtime-graph/dist/capture/auto-bootstrap.js'),
    // Workspace / monorepo (toolkit dev)
    path.join(projectRoot, 'packages/runtime-graph/dist/capture/auto-bootstrap.js'),
    // Sibling dev (codegraph-toolkit-sibling pattern)
    path.join(projectRoot, '../codegraph-toolkit/packages/runtime-graph/dist/capture/auto-bootstrap.js'),
  ]
  for (const c of candidates) {
    try {
      await fs.access(c)
      return c
    } catch { /* next */ }
  }
  // Fallback : resolve via require.resolve depuis ce module
  try {
    const __filename = fileURLToPath(import.meta.url)
    const here = path.dirname(__filename)
    const local = path.resolve(here, './auto-bootstrap.js')
    await fs.access(local)
    return local
  } catch { /* fall through */ }
  return null
}

/**
 * Le bootstrap écrit dans des sub-dirs `pid-<N>/` pour éviter les
 * collisions parent/child (ex: npm test parent écraserait le node child).
 * Cette helper somme les totalSpans de tous les sub-dirs pid-*.
 */
async function readBootstrapMetaSpans(factsDir: string): Promise<number> {
  let total = 0
  try {
    const entries = await fs.readdir(factsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('pid-')) continue
      try {
        const metaFile = path.join(factsDir, entry.name, 'RuntimeRunMeta.facts')
        const content = await fs.readFile(metaFile, 'utf-8')
        const line = content.trim().split('\n')[0]
        if (!line) continue
        const cols = line.split('\t')
        total += parseInt(cols[3] ?? '0', 10) || 0
      } catch { /* skip */ }
    }
  } catch { /* dir absent */ }
  return total
}

/**
 * Helper exporté : copie les .facts du tmpDir bootstrap vers le main
 * outDir du run runtime-graph. Appelé par CLI après driver.run().
 */
export async function importBootstrapFacts(srcDir: string, dstDir: string): Promise<void> {
  await fs.mkdir(dstDir, { recursive: true })
  const files = await fs.readdir(srcDir)
  for (const f of files) {
    if (!f.endsWith('.facts')) continue
    const src = path.join(srcDir, f)
    const dst = path.join(dstDir, f)
    await fs.copyFile(src, dst)
  }
}
