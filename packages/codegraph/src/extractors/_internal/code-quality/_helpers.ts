// ADR-005
/**
 * Helpers partagés des sous-détecteurs code-quality.
 *
 * Internes au dossier — pas d'import depuis l'extérieur du toolkit.
 *
 * Anchored ADR-005 (Per-file extractor bundle pattern) : ces helpers
 * factorisent les invariants AST partagés (TEST_FILE_RE skip, FN_KINDS
 * boundary stop pour les ancestor walks, isExempt comment marker).
 */

import { type SourceFile, type Node, SyntaxKind } from 'ts-morph'

export const TEST_FILE_RE =
  /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

export const LOOP_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
])

export const FN_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
])

export type IsExempt = (line: number, marker: string) => boolean

/**
 * Construit un prédicat `isExempt(line, marker)` qui regarde si la ligne
 * juste au-dessus contient `// <marker>` (commentaire d'exemption inline).
 *
 * Pourquoi : permet aux call-sites d'exempter localement un faux-positif
 * sans avoir à grandfather le fichier entier.
 */
export function makeIsExempt(sf: SourceFile): IsExempt {
  const lines = sf.getFullText().split('\n')
  return (line, marker) => {
    if (line < 2 || line - 2 >= lines.length) return false
    return new RegExp(`//\\s*${marker}\\b`).test(lines[line - 2])
  }
}

/**
 * Remonte les ancestors d'un node — retourne le premier loop trouvé
 * AVANT une fonction (au sens "stoppe à la fn boundary"). null sinon.
 *
 * Sert à détecter "node IS DIRECTLY in a loop, pas dans une fn nested".
 */
export function findEnclosingLoop(node: Node): Node | null {
  let cur: Node | undefined = node.getParent()
  while (cur) {
    if (FN_KINDS.has(cur.getKind())) return null
    if (LOOP_KINDS.has(cur.getKind())) return cur
    cur = cur.getParent()
  }
  return null
}

/**
 * True si `node` est dans la "init"/"condition"/"incrementor" d'un loop
 * ancestor (i.e. pas dans le body). Évite les FP du type :
 *   `for (const x of [1, 2, 3])` → array literal NOT par-iteration
 *   `for (let i = 0, arr = [...]; i < arr.length; i++)` → idem
 *
 * Heuristique : l'init d'un loop ne traverse PAS un Block. Le body en
 * traverse toujours un. On remonte du node vers le loopAncestor — si on
 * traverse un Block avant d'arriver au loopAncestor, on était dans le body.
 */
export function isDescendantOfLoopInit(node: Node, loopAncestor: Node): boolean {
  let cur: Node | undefined = node
  while (cur && cur !== loopAncestor) {
    if (cur.getKind() === SyntaxKind.Block) return false
    cur = cur.getParent()
  }
  return cur === loopAncestor
}
