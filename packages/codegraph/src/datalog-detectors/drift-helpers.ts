// ADR-026 // ADR-031 Phase 2 batch 6
/**
 * Drift patterns helpers — converter TodoMarker → DriftSignal (Pattern 3
 * todo-no-owner) + exemption check `// drift-ok`.
 *
 * Historiquement vivaient dans `extractors/drift-patterns.ts` aux côtés de
 * `extractDriftPatternsFileBundle` (Patterns 1+2+4+5 AST). Déplacés ici
 * ADR-031 Phase 2 batch 6 : le Datalog runner couvre les 4 patterns AST
 * via `adaptDriftSignalsFromDatalog`, et reste juste à assembler le
 * Pattern 3 (todo-no-owner) côté caller — c'est la fonction de ce module.
 *
 * Consommateurs :
 *   - `datalog-detectors/runner-adapter.ts` (assemble les 5 kinds)
 *   - `core/analyzer.ts` Phase 2 (path Datalog ; le path legacy/incremental
 *      a été retiré ADR-031 Phase 2 batch 6).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { TodoMarker } from '../extractors/todos.js'

export type DriftSignalKind =
  | 'excessive-optional-params'
  | 'wrapper-superfluous'
  | 'todo-no-owner'
  | 'deep-nesting'
  | 'empty-catch-no-comment'

export interface DriftSignal {
  kind: DriftSignalKind
  file: string
  line: number
  /** Court (≤120 chars), actionnable. */
  message: string
  /** 1=info, 2=worth-a-look, 3=fort. */
  severity: 1 | 2 | 3
  /** Détails spécifiques au kind (sérialisable JSON). */
  details?: Record<string, string | number | boolean>
}

/**
 * Pattern 3 — convert `TodoMarker` into a DriftSignal if the TODO has
 * neither an owner (`@username`) nor an issue ref (`#NNN`). Returns null
 * if the TODO already has an owner.
 *
 * Exempts (pas considérés comme drift) :
 *   `// TODO @alice will fix`
 *   `// TODO #123 break this down`
 *   `// HACK @user #789 ...`
 */
export function todoToDriftSignal(todo: TodoMarker): DriftSignal | null {
  const msg = todo.message ?? ''
  // Regex permissif : @user OU #NNN n'importe où dans le message.
  const hasOwner = /@\w+/.test(msg)
  const hasIssueRef = /#\d+/.test(msg)
  if (hasOwner || hasIssueRef) return null
  return {
    kind: 'todo-no-owner',
    file: todo.file,
    line: todo.line,
    message: `${todo.tag} sans @owner ni #issue : "${msg.slice(0, 60)}"`,
    severity: 1,
    details: { tag: todo.tag, fullMessage: msg.slice(0, 200) },
  }
}

/**
 * drift-ok: docstring décrit la sémantique du marker, pas un to-do.
 * Check `// drift-ok` exemption for a to-do marker :
 *   - line immédiatement précédente, OR
 *   - n'importe quelle ligne du JSDoc englobant (si le marker est dans un
 *     `/** ... *​/` block et le block s'ouvre avec `/** drift-ok` ou est
 *     précédé par `// drift-ok`).
 *
 * Cache : 1 readFileSync par fichier (les markers sont triés implicitement
 * dans la boucle de l'aggregator, mais on lit en lazy via fileLinesCache).
 */
const fileLinesCache = new Map<string, string[]>()

export function isTodoExempt(rootDir: string, todo: TodoMarker): boolean {
  let lines = fileLinesCache.get(todo.file)
  if (!lines) {
    try {
      lines = fs.readFileSync(path.join(rootDir, todo.file), 'utf-8').split('\n')
    } catch {
      return false
    }
    fileLinesCache.set(todo.file, lines)
  }
  const idx = todo.line - 1  // 0-based

  // 1. Direct preceding line : `// drift-ok` ou docblock continuation `* drift-ok`.
  if (idx > 0 && /\/\/\s*drift-ok\b/.test(lines[idx - 1])) return true

  // 2. JSDoc englobant : si le marker est dans un block /** ... */, scanner
  //    toutes les lignes du block (de l'ouverture jusqu'au marker) pour
  //    `drift-ok`. Permet la convention "marker dans le bloc lui-même".
  return isTodoInsideExemptedJsdoc(lines, idx)
}

function isTodoInsideExemptedJsdoc(lines: string[], idx: number): boolean {
  // Walk upward jusqu'à trouver `/**` ou sortir du block (line non-`*`).
  for (let j = idx - 1; j >= 0; j--) {
    const l = lines[j]
    if (/drift-ok\b/.test(l)) return true       // marker dans une ligne du block
    if (/^\s*\/\*\*/.test(l)) {
      // Atteint l'ouverture sans trouver de marker dans le block.
      // Dernière chance : `// drift-ok` sur la ligne JUSTE avant `/**`.
      return j > 0 && /\/\/\s*drift-ok\b/.test(lines[j - 1])
    }
    // Pas une continuation docblock (`* ...`) → on n'est pas dans un JSDoc.
    if (!/^\s*\*/.test(l)) return false
  }
  return false
}
