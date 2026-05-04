// ADR-024
/**
 * Worker bootstrap — exécuté DANS chaque worker_thread spawné par le pool.
 *
 * Reçoit via parentPort des messages `{ id, modulePath, exportName, args }`.
 * Importe dynamiquement le module + appelle l'export. Le résultat est
 * renvoyé via parentPort `{ id, result }` ou `{ id, error }`.
 *
 * Contract :
 *   - Le module exporté doit être pure : pas de side effect, pas d'I/O
 *     dépendant du main thread. Lecture fs autorisée (worker a son propre
 *     fs handle).
 *   - args et result doivent être structuredClone-able (pas de closures,
 *     pas de class instances avec methods).
 *
 * Worker reste en vie tant que parentPort est ouvert. Le pool gère le
 * lifecycle : spawn → dispatch → terminate.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

interface TaskMessage {
  id: number
  modulePath: string
  exportName: string
  args: unknown[]
}

interface ResultMessage {
  id: number
  result?: unknown
  error?: string
}

if (!parentPort) {
  throw new Error('worker-runner.ts must be loaded in a worker_thread')
}

void workerData  // available pour future config (verbose mode, etc.)

const port = parentPort
const moduleCache = new Map<string, Promise<Record<string, unknown>>>()

async function loadModule(modulePath: string): Promise<Record<string, unknown>> {
  let mod = moduleCache.get(modulePath)
  if (!mod) {
    // Convertit chemin absolu en URL file:// pour import dynamique
    const url = modulePath.startsWith('file://') ? modulePath : pathToFileURL(modulePath).href
    mod = import(url) as Promise<Record<string, unknown>>
    moduleCache.set(modulePath, mod)
  }
  return mod
}

port.on('message', async (msg: TaskMessage) => {
  try {
    const mod = await loadModule(msg.modulePath)
    const fn = mod[msg.exportName]
    if (typeof fn !== 'function') {
      throw new Error(`Export "${msg.exportName}" is not a function in ${msg.modulePath}`)
    }
    const result = await (fn as (...a: unknown[]) => unknown)(...msg.args)
    const reply: ResultMessage = { id: msg.id, result }
    port.postMessage(reply)
  } catch (err) {
    const reply: ResultMessage = {
      id: msg.id,
      error: err instanceof Error ? err.message : String(err),
    }
    port.postMessage(reply)
  }
})
