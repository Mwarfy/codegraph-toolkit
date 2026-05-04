// ADR-024
/**
 * Worker entrypoint pour analyzeTodos. Re-exporte une fn pure qui prend
 * un objet sérialisable (content, relPath) et retourne directement les
 * items à aggréger. Évite de transférer le Bundle entier cross-thread
 * quand on n'utilise que `.todos`.
 *
 * Loadé par worker-runner.ts via dynamic import quand LIBY_BSP_WORKERS=1.
 */

import { extractTodosFileBundle, type TodoMarker } from './todos.js'

export function extractTodosForWorker(input: { content: string; relPath: string }): TodoMarker[] {
  return extractTodosFileBundle(input.content, input.relPath).todos
}
