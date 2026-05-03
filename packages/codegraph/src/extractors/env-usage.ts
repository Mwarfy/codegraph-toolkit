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
import { buildLineToSymbol } from './_shared/ast-helpers.js'
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
    const readers = scanEnvReadersInSourceFile(sf, relPath)
    for (const r of readers) {
      if (!byName.has(r.varName)) byName.set(r.varName, [])
      byName.get(r.varName)!.push(r.reader)
    }
  }

  return aggregateEnvReaders(byName, secretTokens)
}

/**
 * Helper réutilisable : scanne UN SourceFile et retourne tous les
 * `process.env.X` capturés. Réutilisé par la version Salsa
 * (incremental/env-usage.ts) pour cacher par-fichier.
 *
 * Retourne une paire (varName, reader) parce que l'agrégation par nom
 * se fait au niveau supérieur — on ne veut pas pré-agréger ici sinon
 * la cache hit incremental serait moins fine.
 */
export function scanEnvReadersInSourceFile(
  sf: SourceFile,
  relPath: string,
): { varName: string; reader: EnvVarReader }[] {
  const out: { varName: string; reader: EnvVarReader }[] = []

  // Court-circuit : si `process.env` n'apparaît pas textuellement, skip.
  const content = sf.getFullText()
  if (!content.includes('process.env')) return out

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
      pushReader(out, pa, name, relPath, lineToSymbol)
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
      pushReader(out, ea, name, relPath, lineToSymbol)
      return
    }
  })

  return out
}

/**
 * Agrège un map (name → readers[]) en EnvVarUsage[] trié, avec calcul de
 * `isSecret`. Réutilisé par les chemins legacy + Salsa.
 */
export function aggregateEnvReaders(
  byName: Map<string, EnvVarReader[]>,
  secretTokens: string[],
): EnvVarUsage[] {
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

export const DEFAULT_ENV_SECRET_TOKENS = DEFAULT_SECRET_TOKENS

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

function pushReader(
  out: { varName: string; reader: EnvVarReader }[],
  node: any,
  name: string,
  file: string,
  lineToSymbol: Map<number, string>,
): void {
  const line = node.getStartLineNumber?.() ?? 0
  const symbol = lineToSymbol.get(line) ?? ''
  const hasDefault = parentHasDefault(node)
  const wrappedIn = wrappingCallName(node)
  const reader: EnvVarReader = { file, symbol, line, hasDefault }
  if (wrappedIn !== undefined) reader.wrappedIn = wrappedIn
  out.push({ varName: name, reader })
}

/**
 * Si le `process.env.X` (ou son parent immédiat `?? default`) est passé
 * directement comme argument d'un CallExpression dont le callee est un
 * Identifier ou PropertyAccess (ex: `parseInt(process.env.X, 10)` ou
 * `Number(process.env.X)`), retourne le rightmost identifier du callee.
 *
 * Cas couvert :
 *   parseInt(process.env.X, 10)             → 'parseInt'
 *   parseInt(process.env.X ?? '5', 10)      → 'parseInt'
 *   Number(process.env.X)                   → 'Number'
 *   parseFloat(process.env.X)               → 'parseFloat'
 *   foo.bar(process.env.X)                  → 'bar'
 *
 * Hors-cas (retourne undefined) :
 *   const x = process.env.X                  // pas de call
 *   process.env.X.length                     // pas l'arg d'un call
 *   foo(bar(process.env.X))                  // bar capturé, pas foo
 */
function wrappingCallName(node: any): string | undefined {
  // Remonter au-dessus d'un éventuel `?? 'default'` / `|| 'x'` parent.
  let target = node
  const direct = target.getParent?.()
  if (
    direct &&
    direct.getKind?.() === SyntaxKind.BinaryExpression
  ) {
    const op = direct.getOperatorToken?.()
    const opKind = op?.getKind?.()
    if (
      (opKind === SyntaxKind.QuestionQuestionToken ||
        opKind === SyntaxKind.BarBarToken) &&
      direct.getLeft?.() === target
    ) {
      target = direct
    }
  }

  const parent = target.getParent?.()
  if (!parent || parent.getKind?.() !== SyntaxKind.CallExpression) return undefined
  // Vérifie que `target` est dans la liste des args, pas le callee.
  const args = parent.getArguments?.() ?? []
  if (!args.includes(target)) return undefined
  const callee = parent.getExpression?.()
  if (!callee) return undefined
  const calleeKind = callee.getKind?.()
  if (calleeKind === SyntaxKind.Identifier) return callee.getText?.()
  if (calleeKind === SyntaxKind.PropertyAccessExpression) return callee.getName?.()
  return undefined
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

// buildLineToSymbol moved to _shared/ast-helpers.ts (NCD dedup).

function relativize(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath)
  if (rel.startsWith('..')) return null
  return rel
}
