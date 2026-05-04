// ADR-024
/**
 * Worker pool — Phase β du BSP. Dispatch les tâches sur N worker_threads
 * pour exploiter les cores réels (vs Promise.all main thread = single core).
 *
 * Architecture :
 *   - N workers spawnés au constructeur, gardés en vie pour la durée du pool
 *   - Round-robin task assignment via une queue + workers idle
 *   - Chaque worker exécute `worker-runner.ts` : reçoit { modulePath, exportName, args }
 *     via postMessage, importe dynamiquement le module, appelle l'export,
 *     renvoie le résultat
 *   - Lifecycle : `dispatch(...)` → enqueue + assign / `terminate()` → cleanup
 *
 * Contraintes (par design des worker_threads) :
 *   - args + result doivent être structuredClone-able
 *   - Le `workerFn` n'est plus une closure — c'est un module path + export name
 *   - Module exporté doit être pure (pas de state shared, pas de side effects
 *     qui dépendent du main thread)
 *
 * Pool size par défaut = os.availableParallelism() (Node 18.14+ — typiquement
 * le nb de cores logiques utilisables). Utilise os.cpus().length comme fallback.
 *
 * Coût overhead :
 *   - spawn worker : ~10-30ms par worker (one-shot au pool init)
 *   - postMessage : ~50-200μs par task (structuredClone + IPC)
 *   - Crossover ROI : ~5-10ms par task minimum pour rentabiliser l'overhead
 *
 * Le pool est SAFE-BY-CONSTRUCTION : pas d'état partagé entre workers, chaque
 * task = pure fn call. La déterminisme est garanti par le monoïde dans le
 * scheduler caller (cf. bsp-scheduler.ts).
 */

import { Worker } from 'node:worker_threads'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

interface PendingTask {
  id: number
  modulePath: string
  exportName: string
  args: unknown[]
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

interface ResultMessage {
  id: number
  result?: unknown
  error?: string
}

export interface WorkerPoolOptions {
  /** Nombre de workers. Default = os.availableParallelism(). */
  size?: number
  /**
   * Path absolu vers worker-runner.js compilé. Default : résolu relativement
   * au fichier worker-pool compilé (dist/parallel/worker-runner.js).
   * Override pour les tests qui run depuis src (vitest TS).
   */
  runnerPath?: string
}

export class WorkerPool {
  private workers: Worker[] = []
  private idleWorkers: Worker[] = []
  private pending = new Map<number, PendingTask>()
  private queue: PendingTask[] = []
  private nextId = 0
  private terminated = false

  constructor(opts: WorkerPoolOptions = {}) {
    const size = opts.size ?? defaultPoolSize()
    const runnerPath = opts.runnerPath ?? resolveRunnerPath()

    for (let i = 0; i < size; i++) {
      const worker = new Worker(runnerPath, { workerData: { workerIndex: i } })
      worker.on('message', (msg: ResultMessage) => this.onResult(worker, msg))
      worker.on('error', (err) => this.onError(worker, err))
      this.workers.push(worker)
      this.idleWorkers.push(worker)
    }
  }

  /**
   * Dispatch une tâche sur le pool. Le worker importe `modulePath`, appelle
   * `exportName(...args)`, retourne le résultat. Garantit le typage côté
   * caller via le param générique R.
   */
  dispatch<R>(modulePath: string, exportName: string, args: unknown[]): Promise<R> {
    if (this.terminated) {
      return Promise.reject(new Error('WorkerPool already terminated'))
    }
    return new Promise<R>((resolve, reject) => {
      const task: PendingTask = {
        id: this.nextId++,
        modulePath,
        exportName,
        args,
        resolve: resolve as (v: unknown) => void,
        reject,
      }
      this.pending.set(task.id, task)
      this.assignNext(task)
    })
  }

  /**
   * Cleanup : terminate tous les workers. Pending tasks sont rejetées.
   */
  async terminate(): Promise<void> {
    this.terminated = true
    for (const task of this.pending.values()) {
      task.reject(new Error('WorkerPool terminated before task completed'))
    }
    this.pending.clear()
    this.queue = []
    await Promise.all(this.workers.map((w) => w.terminate()))
    this.workers = []
    this.idleWorkers = []
  }

  get size(): number {
    return this.workers.length
  }

  private assignNext(task: PendingTask): void {
    const worker = this.idleWorkers.pop()
    if (!worker) {
      this.queue.push(task)
      return
    }
    worker.postMessage({
      id: task.id,
      modulePath: task.modulePath,
      exportName: task.exportName,
      args: task.args,
    })
  }

  private onResult(worker: Worker, msg: ResultMessage): void {
    const task = this.pending.get(msg.id)
    if (!task) return
    this.pending.delete(msg.id)
    if (msg.error !== undefined) {
      task.reject(new Error(msg.error))
    } else {
      task.resolve(msg.result)
    }
    // Worker is now idle — assign next queued task ou retourne au pool
    const next = this.queue.shift()
    if (next) {
      worker.postMessage({
        id: next.id,
        modulePath: next.modulePath,
        exportName: next.exportName,
        args: next.args,
      })
    } else {
      this.idleWorkers.push(worker)
    }
  }

  private onError(worker: Worker, err: Error): void {
    // Reject toutes les tasks pending sur ce worker (impossible de savoir
    // exactement laquelle a foiré → on conservative : reject la plus ancienne).
    // En pratique l'erreur fatal kill le worker, donc on en spawn un nouveau.
    void worker
    // Pour l'instant : best-effort. Phase γ : retry sur fresh worker.
    for (const task of this.pending.values()) {
      task.reject(err)
    }
    this.pending.clear()
  }
}

/**
 * Singleton lazy — le pool est partagé pour tout le process. Évite N spawn/
 * terminate par parallelMap call. Lifecycle managé par le caller via
 * `terminateGlobalPool()` à la fin du process.
 */
let globalPool: WorkerPool | null = null

export function getGlobalPool(opts?: WorkerPoolOptions): WorkerPool {
  if (!globalPool) globalPool = new WorkerPool(opts)
  return globalPool
}

export async function terminateGlobalPool(): Promise<void> {
  if (globalPool) {
    await globalPool.terminate()
    globalPool = null
  }
}

function defaultPoolSize(): number {
  // Node 18.14+ : os.availableParallelism() respecte les cgroup limits (CI)
  if (typeof os.availableParallelism === 'function') {
    return Math.max(1, os.availableParallelism())
  }
  return Math.max(1, os.cpus().length)
}

function resolveRunnerPath(): string {
  // Le worker-runner.js compilé vit dans le même dist/ que ce fichier
  const here = fileURLToPath(import.meta.url)
  return path.join(path.dirname(here), 'worker-runner.js')
}
