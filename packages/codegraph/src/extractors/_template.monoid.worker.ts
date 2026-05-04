// ADR-024
/**
 * TEMPLATE — worker entrypoint pour un détecteur per-file (ADR-024).
 *
 * Re-exporte une fn pure qui prend un objet sérialisable {content, relPath}
 * et retourne directement les items à aggréger. Évite de transférer le
 * Bundle complet cross-thread quand seul `.items` est nécessaire.
 *
 * Loadé par worker-runner.ts via dynamic import quand LIBY_BSP_WORKERS=1.
 */

import { extractXxxFileBundle, type XxxItem } from './_template.monoid.js'

export function extractXxxForWorker(input: { content: string; relPath: string }): XxxItem[] {
  return extractXxxFileBundle(input.content, input.relPath).items
}
