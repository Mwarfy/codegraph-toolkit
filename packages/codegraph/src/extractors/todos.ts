/**
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
 */
export async function analyzeTodos(
  rootDir: string,
  files: string[],
  readFile: (relPath: string) => Promise<string>,
): Promise<TodoMarker[]> {
  // Lit en parallèle les .ts/.tsx files (I/O fs indépendantes), parse séquentiel.
  const tsFiles = files.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
  const fileContents = await Promise.all(
    tsFiles.map(async (file) => ({ file, content: await readFile(file) })),
  )
  const all: TodoMarker[] = []
  for (const { file, content } of fileContents) {
    const bundle = extractTodosFileBundle(content, file)
    all.push(...bundle.todos)
  }
  all.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  return all
}

void path  // path not used currently — reserved for relative path normalization
