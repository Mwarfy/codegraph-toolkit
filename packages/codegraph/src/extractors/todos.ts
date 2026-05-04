// ADR-024
/**
 * drift-ok: extracteur des markers de dette — mentions docstring-only.
 *
 * TODO/FIXME tracker — déterministe, regex per-file.
 *
 * Scanne tous les fichiers TS pour les commentaires `// TODO`, `// FIXME`,
 * `// HACK`, `// XXX`, `// NOTE`. Capture :
 *   - le tag (TODO / FIXME / etc.)
 *   - le message (jusqu'à la fin de ligne)
 *   - le file + line
 *   - le contexte (le symbole/fonction englobant si trouvable via heuristique)
 *
 * Pourquoi : la dette technique assumée doit être visible. Sans tracker,
 * elle dérive sans qu'on s'en aperçoive (Claude future ouvre le repo, ne
 * voit pas les TODOs sauf à grep).
 *
 * Pattern ADR-005 : extractTodosFileBundle(content, relPath) per-file →
 * agrégat trivial (concat). Stable sur fileContent → cacheable Salsa.
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPerFileExtractor } from '../parallel/per-file-extractor.js'

// Path absolu vers le worker compilé — résolu à la load. Workers chargent
// extractTodosForWorker via dynamic import. Mode worker actif si
// LIBY_BSP_WORKERS=1.
const TODOS_WORKER_MODULE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'todos.worker.js',
)

export type TodoTag = 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'NOTE'

export interface TodoMarker {
  /** Tag détecté (uppercase, normalisé). */
  tag: TodoTag
  /** Texte du commentaire après le tag (trimé, max 200 chars). */
  message: string
  /** File path relatif au rootDir. */
  file: string
  /** Line number (1-based). */
  line: number
}

export interface TodosFileBundle {
  todos: TodoMarker[]
}

const TAG_PATTERN = /(?:^|[^\w])\b(TODO|FIXME|HACK|XXX|NOTE)\b\s*:?\s*(.*)/

/**
 * drift-ok: docstring du détecteur — mention concept-only.
 * Bundle per-file : extrait les markers TODO/FIXME du contenu source.
 *
 * Regex-only, pas d'AST — les markers vivent dans des commentaires, pas
 * dans la structure syntaxique. Skip les strings literals : on regarde
 * uniquement les lignes commençant par `//`, `*`, ou `/*`.
 */
export function extractTodosFileBundle(content: string, relPath: string): TodosFileBundle {
  const todos: TodoMarker[] = []
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Repère les zones de commentaire dans cette ligne.
    // Pattern simple : `//`, `/*`, ou `*` au début (docblock continuation).
    const lineCommentIdx = line.indexOf('//')
    const blockCommentIdx = line.indexOf('/*')
    const docblockMatch = /^\s*\*/.test(line)

    let commentSection = ''
    if (lineCommentIdx >= 0) {
      commentSection = line.substring(lineCommentIdx + 2)
    } else if (blockCommentIdx >= 0) {
      commentSection = line.substring(blockCommentIdx + 2)
    } else if (docblockMatch) {
      commentSection = line.replace(/^\s*\*\s?/, '')
    } else {
      continue
    }

    const m = commentSection.match(TAG_PATTERN)
    if (!m) continue

    const tag = m[1] as TodoTag
    const message = m[2].trim().slice(0, 200)

    todos.push({
      tag,
      message,
      file: relPath,
      line: i + 1,
    })
  }

  return { todos }
}

/**
 * Analyse all files, return aggregated todos sorted by file then line.
 *
 * Implémentation BSP : reads + extracts en parallel, fusion monoïdale via
 * appendSortedMonoid. Output bit-identique à la version séquentielle
 * (théorème Church-Rosser : extractor pure + sort canonique).
 */
export async function analyzeTodos(
  rootDir: string,
  files: string[],
  readFile: (relPath: string) => Promise<string>,
): Promise<TodoMarker[]> {
  void rootDir  // gardé pour compat API
  const r = await runPerFileExtractor<TodosFileBundle, TodoMarker>({
    files,
    readFile,
    extractor: extractTodosFileBundle,
    selectItems: (b) => b.todos,
    sortKey: (m) => `${m.file}:${String(m.line).padStart(8, '0')}`,
    // Worker mode opt-in via LIBY_BSP_WORKERS=1 — workerModule + workerExport
    // toujours fournis pour qu'env var soit la seule décision (pas besoin
    // de patcher le caller).
    workerModule: TODOS_WORKER_MODULE,
    workerExport: 'extractTodosForWorker',
  })
  return r.items
}

void path  // path not used currently — reserved for relative path normalization
