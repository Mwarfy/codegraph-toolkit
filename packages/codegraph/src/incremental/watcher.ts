// ADR-007
/**
 * `codegraph watch` mode (Sprint 9 — Phase 2).
 *
 * Démon qui maintient le sharedProject ts-morph + DB Salsa en RAM
 * et écoute les changements filesystem via `fs.watch`. Sur change,
 * recompute le snapshot via le pipeline incremental (warm path) et
 * écrit `.codegraph/snapshot.json` + facts datalog.
 *
 * Cible perf : warm <50ms par change après le 1er analyze (qui reste
 * cold à 10-15s).
 *
 * Usage typique :
 *   - Dev local : `codegraph watch` lancé en background, IDE/dashboard
 *     consomme `.codegraph/snapshot.json`.
 *   - CI : pas pertinent (process unique = pas de gain).
 *
 * Limites v1 :
 *   - fs.watch recursive est macOS-only natif. Sur Linux, on watche
 *     les dossiers individuellement (parcours initial des fichiers
 *     pour identifier les dirs à watcher).
 *   - Pas de filtrage avancé : on respecte les `exclude` patterns du
 *     codegraph config + skip des fichiers cachés/temporaires.
 *   - Debounce 50ms : aggregate plusieurs events filesystem en un
 *     recompute. Vim/IDE peuvent émettre 3-5 events par save.
 *   - Pas de protocole live (websocket, IPC). Le consumer doit poll
 *     le fichier snapshot.json.
 */

import { watch as fsWatch, type FSWatcher } from 'node:fs'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { minimatch } from 'minimatch'
import { analyze, discoverFiles } from '../core/analyzer.js'
import type { CodeGraphConfig } from '../core/types.js'
import { savePersistedCache as incSavePersistedCache } from './persistence.js'
import { sharedDb as incSharedDb } from './database.js'
import { getMtimeMap as incGetMtimeMap } from './queries.js'

export interface WatchOptions {
  /** Debounce en ms entre fs event et recompute. Default 50. */
  debounceMs?: number
  /** Callback appelé à chaque recompute (snapshot écrit). */
  onUpdate?: (info: { changedFiles: string[]; durationMs: number }) => void
  /** Callback appelé sur erreur de recompute. */
  onError?: (err: unknown) => void
  /** Si true, écrit aussi le snapshot.json + facts à chaque update. Default true. */
  writeSnapshot?: boolean
}

export class CodeGraphWatcher {
  private config: CodeGraphConfig
  private opts: Required<Omit<WatchOptions, 'onUpdate' | 'onError'>> & Pick<WatchOptions, 'onUpdate' | 'onError'>
  private watchers: FSWatcher[] = []
  private pendingTimer: NodeJS.Timeout | null = null
  private pendingChanges = new Set<string>()
  private running = false
  private analyzing = false
  private persistTimer: NodeJS.Timeout | null = null
  /**
   * Liste des fichiers actifs maintenue en RAM (Sprint 10). Évite le
   * walk fs récursif à chaque analyze. Mise à jour sur fs event 'add'
   * / 'remove' détecté via shouldTrack + fs.access.
   */
  private files: string[] = []

  constructor(config: CodeGraphConfig, options: WatchOptions = {}) {
    this.config = config
    this.opts = {
      debounceMs: options.debounceMs ?? 50,
      writeSnapshot: options.writeSnapshot ?? true,
      onUpdate: options.onUpdate,
      onError: options.onError,
    }
  }

  /**
   * Démarre le watcher. Fait un premier analyze complet (cold) puis
   * écoute les fs events. Bloquant tant que stop() n'est pas appelé.
   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    // Sprint 10 : pré-discover la liste de fichiers UNE FOIS, puis la
    // maintenir en RAM via fs events. Skip le walk fs récursif à
    // chaque analyze (~500ms évités).
    this.files = await discoverFiles(
      this.config.rootDir, this.config.include, this.config.exclude,
    )

    // Premier analyze : LOAD le cache disque si dispo (warm cross-process),
    // mais skip le SAVE — le watcher saugarde plus tard via persistTick.
    await this.runAnalyze([], { skipLoad: false, skipSave: true })

    // Save périodique pour ne pas perdre l'état si crash.
    this.persistTimer = setInterval(() => void this.persistNow(), 30_000)

    // Watch les dossiers du rootDir récursivement.
    // Sur macOS recursive: true marche nativement. Sur Linux, on
    // walke les dirs et on watche chacun.
    const rootDir = this.config.rootDir
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const watcher = fsWatch(rootDir, { recursive: true }, (_event, filename) => {
        if (!filename) return
        this.scheduleRecompute(filename)
      })
      this.watchers.push(watcher)
    } else {
      // Linux : walk + watch chaque dossier
      const dirs = await this.discoverWatchDirs(rootDir)
      for (const dir of dirs) {
        try {
          const watcher = fsWatch(dir, (_event, filename) => {
            if (!filename) return
            const rel = path.relative(rootDir, path.join(dir, filename)).replace(/\\/g, '/')
            this.scheduleRecompute(rel)
          })
          this.watchers.push(watcher)
        } catch {}
      }
    }
  }

  /** Stoppe le watcher proprement. Save final avant de quitter. */
  async stop(): Promise<void> {
    this.running = false
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    if (this.persistTimer) clearInterval(this.persistTimer)
    for (const w of this.watchers) {
      try { w.close() } catch {}
    }
    this.watchers = []
    this.pendingChanges.clear()
    await this.persistNow()
  }

  /** Écrit le cache disque. Appelé par persistTimer + stop(). */
  async persistNow(): Promise<void> {
    try {
      await incSavePersistedCache(this.config.rootDir, incGetMtimeMap(), incSharedDb)
    } catch (err) {
      this.opts.onError?.(err)
    }
  }

  private scheduleRecompute(rawPath: string): void {
    const rel = rawPath.replace(/\\/g, '/')
    if (!this.shouldTrack(rel)) return
    this.pendingChanges.add(rel)
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const changes = [...this.pendingChanges]
      this.pendingChanges.clear()
      void this.runAnalyze(changes)
    }, this.opts.debounceMs)
  }

  private async runAnalyze(
    changedFiles: string[],
    opts: { skipLoad?: boolean; skipSave?: boolean } = {},
  ): Promise<void> {
    if (this.analyzing) {
      for (const f of changedFiles) this.pendingChanges.add(f)
      return
    }
    this.analyzing = true
    const t0 = performance.now()

    // Sprint 10 : sync la liste de fichiers depuis les fs events.
    // Pour chaque change : si add → push, si remove → splice.
    for (const f of changedFiles) {
      const abs = path.join(this.config.rootDir, f)
      let exists = false
      try { await fs.access(abs); exists = true } catch {}
      const idx = this.files.indexOf(f)
      if (exists && idx === -1) this.files.push(f)
      else if (!exists && idx !== -1) this.files.splice(idx, 1)
    }

    try {
      const result = await analyze(this.config, {
        incremental: true,
        skipPersistenceLoad: opts.skipLoad ?? true,
        skipPersistenceSave: opts.skipSave ?? true,
        preDiscoveredFiles: this.files,
      })

      // Sprint B2 : écrit `.codegraph/snapshot-live.json` + facts à chaque
      // update, pour que les consumers (hook PostToolUse, MCP tools) voient
      // un snapshot live au lieu du dernier post-commit (qui peut dater).
      // Le préfixe `snapshot-` matche le filter du loader. Naming dédié
      // pour ne pas confondre avec les snapshots versionnés post-commit.
      if (this.opts.writeSnapshot) {
        try {
          const snapshotPath = path.join(this.config.rootDir, '.codegraph', 'snapshot-live.json')
          await fs.mkdir(path.dirname(snapshotPath), { recursive: true })
          await fs.writeFile(snapshotPath, JSON.stringify(result.snapshot, null, 2))

          // Régénère aussi les facts datalog (les invariants Sentinel les
          // consomment via .codegraph/facts/). Latence ~50ms supplémentaire.
          const { exportFacts } = await import('../facts/index.js')
          await exportFacts(result.snapshot, {
            outDir: path.join(this.config.rootDir, '.codegraph', 'facts'),
          })
        } catch (writeErr) {
          // Échec d'écriture = pas bloquant, le run en RAM a réussi
          this.opts.onError?.(writeErr)
        }
      }

      const durationMs = performance.now() - t0
      this.opts.onUpdate?.({ changedFiles, durationMs })
    } catch (err) {
      this.opts.onError?.(err)
    } finally {
      this.analyzing = false
      if (this.pendingChanges.size > 0) {
        const more = [...this.pendingChanges]
        this.pendingChanges.clear()
        this.scheduleRecompute(more[0])
      }
    }
  }

  private shouldTrack(relPath: string): boolean {
    // Skip fichiers cachés / tempo
    const base = path.basename(relPath)
    if (base.startsWith('.') && base !== '.gitignore') return false
    if (base.endsWith('~') || base.endsWith('.tmp') || base.endsWith('.swp')) return false
    if (base.includes('.swp')) return false

    // Match include patterns
    let included = false
    for (const pattern of this.config.include ?? []) {
      if (minimatch(relPath, pattern)) { included = true; break }
    }
    if (!included) return false

    for (const pattern of this.config.exclude ?? []) {
      if (minimatch(relPath, pattern)) return false
    }
    return true
  }

  private async discoverWatchDirs(rootDir: string): Promise<string[]> {
    const out: string[] = []
    await this.walkForDirs(rootDir, out)
    return out
  }

  private async walkForDirs(dir: string, acc: string[]): Promise<void> {
    const skipDirs = new Set([
      'node_modules', '.git', 'dist', 'build', '.next',
      'coverage', '.turbo', '.cache', 'docker-data',
    ])
    const dirName = path.basename(dir)
    if (skipDirs.has(dirName)) return

    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) }
    catch { return }
    acc.push(dir)
    for (const e of entries) {
      if (e.isDirectory()) {
        await this.walkForDirs(path.join(dir, e.name), acc)
      }
    }
  }
}
