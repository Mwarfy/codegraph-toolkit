/**
 * Cyclomatic Complexity Detector
 *
 * Pour chaque fichier source, liste les fonctions/méthodes et calcule leur
 * complexité cyclomatique (McCabe) — 1 + nb de points de décision.
 *
 * Points de décision comptés :
 *   - if / else-if
 *   - case (mais pas default)
 *   - for / for-in / for-of
 *   - while / do-while
 *   - catch
 *   - ternaire (?:)
 *   - && et || (court-circuit, créent un nouveau chemin)
 *
 * Le `?.` (optional chaining) n'est PAS compté : ce n'est pas une branche
 * logique, juste du sucre syntaxique sur null-check. Idem pour `??` dans la
 * plupart des linters (mais comptable si on veut être strict).
 *
 * Seuils de référence (McCabe 1976, conventions industrielles) :
 *   ≤ 10  : simple
 *   11-15 : à surveiller
 *   16-25 : complexe, refactor conseillé
 *   > 25  : critique, dette quasi-certaine
 *
 * Output : top 3 fonctions les plus complexes par fichier + stats agrégées.
 * On limite à top 3 pour garder le snapshot compact — au-delà c'est du bruit.
 */

import { Project, SyntaxKind, Node, SourceFile } from 'ts-morph'
import * as path from 'node:path'

export interface FunctionComplexity {
  /** Nom de la fonction/méthode. "<anonymous>" pour les arrows non-nommées. */
  name: string
  /** Ligne de la déclaration. */
  line: number
  /** Complexité cyclomatique (≥ 1). */
  complexity: number
  /** Lignes de code du corps de la fonction (approximatif). */
  loc: number
}

export interface FileComplexityInfo {
  /** Relative file path */
  file: string
  /** Top 3 fonctions les plus complexes (pour focalisation humaine). */
  topFunctions: FunctionComplexity[]
  /** Complexité max observée dans le fichier. */
  maxComplexity: number
  /** Complexité moyenne pondérée par nb fonctions. Rounded à 1 décimale. */
  avgComplexity: number
  /** Nombre total de fonctions/méthodes détectées. */
  totalFunctions: number
}

const FUNCTION_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
])

const DECISION_KINDS = new Set([
  SyntaxKind.IfStatement,
  SyntaxKind.CaseClause,       // switch-case (pas DefaultClause)
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CatchClause,
  SyntaxKind.ConditionalExpression,
])

/**
 * Compte les points de décision à l'intérieur d'un node, SANS entrer dans les
 * fonctions imbriquées. Les nested functions ont leur propre complexité
 * comptée séparément.
 */
function countDecisions(node: Node): number {
  let count = 0
  const kind = node.getKind()

  if (DECISION_KINDS.has(kind)) {
    count++
  } else if (kind === SyntaxKind.BinaryExpression) {
    const op = node.getFirstChildByKind(SyntaxKind.AmpersandAmpersandToken)
      || node.getFirstChildByKind(SyntaxKind.BarBarToken)
    if (op) count++
  }

  for (const child of node.getChildren()) {
    // Ne descend PAS dans les fonctions imbriquées — elles seront visitées
    // au top-level comme une unité indépendante.
    if (FUNCTION_KINDS.has(child.getKind())) continue
    count += countDecisions(child)
  }

  return count
}

/**
 * Complexité cyclomatique d'une fonction = 1 (base) + nb de décisions.
 */
function cyclomaticComplexity(fnBody: Node): number {
  return 1 + countDecisions(fnBody)
}

/**
 * Tente d'extraire un nom significatif pour une fonction. Cascade :
 *   1. FunctionDeclaration/Method/Get/Set/Constructor → getName()
 *   2. ArrowFunction/FunctionExpression affectée à une variable → nom variable
 *   3. Propriété d'objet (key: () => {...}) → nom de la propriété
 *   4. Default → "<anonymous>"
 */
function extractName(node: Node): string {
  const kind = node.getKind()
  if (kind === SyntaxKind.Constructor) return 'constructor'

  if ('getName' in node && typeof (node as any).getName === 'function') {
    try {
      const name = (node as any).getName()
      if (name) return name
    } catch {}
  }

  const parent = node.getParent()
  if (!parent) return '<anonymous>'
  const pKind = parent.getKind()

  if (pKind === SyntaxKind.VariableDeclaration) {
    const nameNode = parent.getFirstChildByKind(SyntaxKind.Identifier)
    if (nameNode) return nameNode.getText()
  }
  if (pKind === SyntaxKind.PropertyAssignment || pKind === SyntaxKind.PropertyDeclaration) {
    const nameNode = parent.getFirstChildByKind(SyntaxKind.Identifier)
    if (nameNode) return nameNode.getText()
  }
  return '<anonymous>'
}

/**
 * Helper réutilisable : calcule les stats de complexité pour UN
 * SourceFile. Le champ `file` est laissé vide — le caller le patche.
 * Retourne null si aucune fonction n'est détectée.
 *
 * Exporté pour la version Salsa (incremental/complexity.ts) qui
 * cache le résultat per-file via fileContent.
 */
export function analyzeComplexityInSourceFile(sf: SourceFile): FileComplexityInfo | null {
  const functions: FunctionComplexity[] = []

  // On collecte les fonctions via descendants. Les fonctions imbriquées sont
  // bien visitées (chaque node est sa propre unité), mais countDecisions ne
  // re-descend pas dedans → pas de double comptage.
  sf.forEachDescendant((node) => {
    if (!FUNCTION_KINDS.has(node.getKind())) return

    // Le body peut être absent (déclarations d'interface avec signatures).
    const body = (node as any).getBody?.() as Node | undefined
    if (!body) return

    const complexity = cyclomaticComplexity(body)
    const startLine = sf.getLineAndColumnAtPos(node.getStart()).line
    const endLine = sf.getLineAndColumnAtPos(node.getEnd()).line
    const loc = endLine - startLine + 1

    functions.push({
      name: extractName(node),
      line: startLine,
      complexity,
      loc,
    })
  })

  if (functions.length === 0) return null

  const total = functions.reduce((s, f) => s + f.complexity, 0)
  const max = functions.reduce((m, f) => Math.max(m, f.complexity), 0)
  const avg = total / functions.length

  // Top 3 par complexité décroissante, tie-break par LOC.
  const topFunctions = functions
    .slice()
    .sort((a, b) => b.complexity - a.complexity || b.loc - a.loc)
    .slice(0, 3)

  return {
    file: '', // patched by caller
    topFunctions,
    maxComplexity: max,
    avgComplexity: Math.round(avg * 10) / 10,
    totalFunctions: functions.length,
  }
}

/**
 * Analyse tous les fichiers et renvoie les stats de complexité par fichier.
 * Les fichiers sans fonction (fichiers de types pures, re-exports) sont omis.
 *
 * Accepte un `sharedProject` pour réutiliser un ts-morph Project déjà construit
 * (par ex. celui d'analyzeExports). Sans ça, on charge ts-morph 2x → OOM sur
 * projets ≥ 200 fichiers avec heap Node par défaut.
 */
export async function analyzeComplexity(
  rootDir: string,
  files: string[],
  tsConfigPath?: string,
  sharedProject?: Project,
): Promise<FileComplexityInfo[]> {
  let project: Project
  if (sharedProject) {
    project = sharedProject
  } else {
    project = new Project({
      ...(tsConfigPath ? { tsConfigFilePath: tsConfigPath } : {}),
      skipAddingFilesFromTsConfig: true,
      compilerOptions: {
        allowJs: true,
        resolveJsonModule: true,
      },
    })
    for (const relPath of files) {
      const absPath = path.join(rootDir, relPath)
      try {
        project.addSourceFileAtPath(absPath)
      } catch {
        // Skip unparseable files
      }
    }
  }

  const results: FileComplexityInfo[] = []
  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath()
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')
    if (!files.includes(relPath)) continue

    try {
      const info = analyzeComplexityInSourceFile(sf)
      if (info) {
        info.file = relPath
        results.push(info)
      }
    } catch {
      // Skip files that blow up on traversal — rare but possible avec des fichiers générés
    }
  }

  return results
}
