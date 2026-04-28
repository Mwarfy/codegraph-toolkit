/**
 * Env Usage Extractor — structural map phase 3.6 B.5
 *
 * Scanne `process.env.NAME` et `process.env['NAME']` dans tous les fichiers
 * TS. Produit une section `envUsage` dans le snapshot : liste des variables
 * d'env, avec pour chacune les readers (file, symbol, line, hasDefault).
 *
 * Heuristique `isSecret` : le nom contient l'un des tokens
 * `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|DSN`. Faux positifs assumés
 * (ex: `PUBLIC_API_KEY` reste classé secret — approximation v1).
 *
 * `hasDefault` : le site a un opérateur `??`, `||`, ou `??=` en droite ligne
 * (parent immédiat BinaryExpression ou ExpressionStatement avec opérateur
 * de défaut). Sinon, null. L'idée : distinguer les envs « tolérantes »
 * (avec fallback) des dépendances dures.
 *
 * Limites v1 :
 *   - `process.env[varName]` où `varName` est une variable, pas un literal,
 *     est ignoré (nom dynamique non capturable).
 *   - Les accès indirects via des helpers (`getEnv('FOO')`) ne sont pas
 *     détectés — seul le `process.env` direct l'est.
 *   - `hasDefault` n'introspecte que le parent immédiat. Les patterns plus
 *     profonds (`const x = foo(process.env.X) ?? y`) sont classés sans
 *     default ; c'est volontairement conservateur.
 */

import { Project, SyntaxKind, type SourceFile } from 'ts-morph'
import * as path from 'node:path'
import type { EnvVarUsage, EnvVarReader } from '../core/types.js'

export interface EnvUsageOptions {
  /** Tokens déclenchant `isSecret=true`. Default : KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|DSN. */
  secretTokens?: string[]
}

const DEFAULT_SECRET_TOKENS = [
  'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PRIVATE', 'DSN',
]

export async function analyzeEnvUsage(
  rootDir: string,
  files: string[],
  project: Project,
  options: EnvUsageOptions = {},
): Promise<EnvVarUsage[]> {
  const secretTokens = options.secretTokens ?? DEFAULT_SECRET_TOKENS
  const fileSet = new Set(files)

  // Map : name → accumulator
  const byName = new Map<string, EnvVarReader[]>()

  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue

    // Court-circuit : si `process.env` n'apparaît pas textuellement, skip.
    const content = sf.getFullText()
    if (!content.includes('process.env')) continue

    const lineToSymbol = buildLineToSymbol(sf)

    sf.forEachDescendant((node) => {
      const k = node.getKind()

      // `process.env.NAME` — PropertyAccessExpression
      if (k === SyntaxKind.PropertyAccessExpression) {
        const pa = node as any
        const obj = pa.getExpression?.()
        if (!obj) return
        if (!isProcessEnv(obj)) return
        const name = pa.getName?.()
        if (!name || !isValidEnvName(name)) return

        recordReader(pa, name, relPath, lineToSymbol, byName)
        return
      }

      // `process.env['NAME']` — ElementAccessExpression
      if (k === SyntaxKind.ElementAccessExpression) {
        const ea = node as any
        const obj = ea.getExpression?.()
        if (!obj) return
        if (!isProcessEnv(obj)) return
        const arg = ea.getArgumentExpression?.()
        if (!arg) return
        const argKind = arg.getKind?.()
        if (argKind !== SyntaxKind.StringLiteral && argKind !== SyntaxKind.NoSubstitutionTemplateLiteral) {
          return  // nom dynamique non capturable
        }
        const name = arg.getLiteralText?.()
        if (!name || !isValidEnvName(name)) return

        recordReader(ea, name, relPath, lineToSymbol, byName)
        return
      }
    })
  }

  // Build output : tri par nom.
  const usages: EnvVarUsage[] = []
  for (const [name, readers] of byName) {
    readers.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })
    usages.push({
      name,
      readers,
      isSecret: matchesSecretTokens(name, secretTokens),
    })
  }

  usages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return usages
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isProcessEnv(node: any): boolean {
  if (node.getKind?.() !== SyntaxKind.PropertyAccessExpression) return false
  const left = node.getExpression?.()
  const right = node.getName?.()
  if (!left || right !== 'env') return false
  // left should be `process`.
  if (left.getKind?.() !== SyntaxKind.Identifier) return false
  return left.getText?.() === 'process'
}

// Env var names : uppercase letters, digits, underscore. Min 2 chars.
// Refuse les accès indirects `process.env.toLowerCase` (méthode de l'objet).
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/
function isValidEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name) && name.length >= 2
}

function recordReader(
  node: any,
  name: string,
  file: string,
  lineToSymbol: Map<number, string>,
  out: Map<string, EnvVarReader[]>,
): void {
  const line = node.getStartLineNumber?.() ?? 0
  const symbol = lineToSymbol.get(line) ?? ''
  const hasDefault = parentHasDefault(node)
  if (!out.has(name)) out.set(name, [])
  out.get(name)!.push({ file, symbol, line, hasDefault })
}

/**
 * Regarde le parent immédiat : si c'est une `BinaryExpression` avec `??`
 * ou `||` et que notre node est la left operand, on considère qu'il y a un
 * default. Conservateur : n'explore pas au-delà du parent direct.
 */
function parentHasDefault(node: any): boolean {
  const parent = node.getParent?.()
  if (!parent) return false
  if (parent.getKind?.() !== SyntaxKind.BinaryExpression) return false
  const op = parent.getOperatorToken?.()
  const opKind = op?.getKind?.()
  if (opKind !== SyntaxKind.QuestionQuestionToken && opKind !== SyntaxKind.BarBarToken) {
    return false
  }
  // Le node doit être à gauche (sinon `X ?? process.env.FOO` signifie que
  // process.env.FOO EST le default, pas qu'il en reçoit un).
  const left = parent.getLeft?.()
  return left === node
}

function matchesSecretTokens(name: string, tokens: string[]): boolean {
  const upper = name.toUpperCase()
  for (const t of tokens) {
    if (upper.includes(t.toUpperCase())) return true
  }
  return false
}

function buildLineToSymbol(sf: SourceFile): Map<number, string> {
  const map = new Map<number, string>()

  for (const fd of sf.getFunctions()) {
    const name = fd.getName()
    if (!name) continue
    const s = fd.getStartLineNumber()
    const e = fd.getEndLineNumber()
    for (let l = s; l <= e; l++) if (!map.has(l)) map.set(l, name)
  }

  for (const cd of sf.getClasses()) {
    const cname = cd.getName() ?? '<anonymous>'
    for (const m of cd.getMethods()) {
      const s = m.getStartLineNumber()
      const e = m.getEndLineNumber()
      for (let l = s; l <= e; l++) if (!map.has(l)) map.set(l, `${cname}.${m.getName()}`)
    }
  }

  for (const vs of sf.getVariableStatements()) {
    for (const vd of vs.getDeclarations()) {
      const init = vd.getInitializer()
      if (!init) continue
      const k = init.getKind()
      if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) continue
      const s = vd.getStartLineNumber()
      const e = vd.getEndLineNumber()
      for (let l = s; l <= e; l++) if (!map.has(l)) map.set(l, vd.getName())
    }
  }

  return map
}

function relativize(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath)
  if (rel.startsWith('..')) return null
  return rel
}
