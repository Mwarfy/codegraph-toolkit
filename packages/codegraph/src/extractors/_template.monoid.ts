// ADR-024
/**
 * TEMPLATE — détecteur per-file au pattern BSP monoïdal (ADR-024).
 *
 * Tout nouveau détecteur codegraph DOIT suivre ce template :
 *   1. extractXxxFileBundle(content, relPath) : pure fn, pas de side effect
 *   2. analyzeXxx(rootDir, files, readFile) : utilise runPerFileExtractor
 *   3. Optionnel : xxx.worker.ts pour mode worker_threads (LIBY_BSP_WORKERS=1)
 *
 * Les détecteurs Project ts-morph utilisent runPerSourceFileExtractor à la
 * place — même algèbre, signature extractor (sf, relPath) au lieu de
 * (content, relPath). Phase γ.2 supporte aussi le mode worker via mini-
 * Project local au worker (re-parse 1 SourceFile depuis content string).
 * L'extractor doit retourner Item[] directement (pas de Bundle wrapper),
 * sinon prévoir une fn wrapper exportée pour le worker entrypoint.
 *
 * Pour copier ce template :
 *   1. Renomme le fichier xxx.ts (ex: my-detector.ts)
 *   2. Renomme XxxItem → MyDetectorItem, XxxFileBundle → MyDetectorFileBundle
 *   3. Implémente extractXxxFileBundle (pure regex / parse / scan)
 *   4. (Optionnel) Crée xxx.worker.ts si fonction lourde (regex complexes,
 *      content > 100KB) — marker `// ADR-024` au top
 *   5. Wire dans core/detectors/ + analyzer.ts mapping
 */

import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { runPerFileExtractor } from '../parallel/per-file-extractor.js'

// ─── Output types ──────────────────────────────────────────────────────────

export interface XxxItem {
  file: string
  line: number
  /** Détaille ici les fields métier. */
  message: string
}

export interface XxxFileBundle {
  items: XxxItem[]
}

// ─── Pure extractor — la vraie logique métier ──────────────────────────────

/**
 * Extracteur pure per-file. Inputs : content + relPath. Output : Bundle.
 *
 * Contract :
 *   - PURE : aucune mutation d'état partagé, aucun I/O, déterministe
 *   - SERIALIZABLE : args + return doivent être structuredClone-able
 *     (pour le mode worker_threads). Pas de Map, Set, Date, fns —
 *     juste plain objects, arrays, primitives.
 *   - DÉTERMINISTE : même input → même output, exactement
 */
export function extractXxxFileBundle(content: string, relPath: string): XxxFileBundle {
  const items: XxxItem[] = []

  // Exemple : scan regex naïf (à remplacer par la logique métier)
  const re = /\/\/\s*EXAMPLE_PATTERN\s*[:?]?\s*(.*)$/gm
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    const line = content.slice(0, match.index).split('\n').length
    items.push({
      file: relPath,
      line,
      message: match[1] ?? '',
    })
  }

  return { items }
}

// ─── Public analyzer — utilise runPerFileExtractor (BSP monoïdal) ──────────

const XXX_WORKER_MODULE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '_template.monoid.worker.js',  // remplace par xxx.worker.js
)

export async function analyzeXxx(
  rootDir: string,
  files: string[],
  readFile: (relPath: string) => Promise<string>,
): Promise<XxxItem[]> {
  void rootDir  // gardé pour API compat
  const r = await runPerFileExtractor<XxxFileBundle, XxxItem>({
    files,
    readFile,
    extractor: extractXxxFileBundle,
    selectItems: (b) => b.items,
    sortKey: (i) => `${i.file}:${String(i.line).padStart(8, '0')}`,
    // Mode worker activé via LIBY_BSP_WORKERS=1 — sans wrapper crée juste
    // ces 2 lignes. Si pas de worker souhaité (détecteur trivial < 5ms),
    // omettre les 2 lignes ci-dessous → fallback main thread automatique.
    workerModule: XXX_WORKER_MODULE,
    workerExport: 'extractXxxForWorker',
  })
  return r.items
}
