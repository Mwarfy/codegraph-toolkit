/**
 * Taint Analysis Extractor — structural map phase 3.8 #3.
 *
 * Détecte les flux « source non-trustée → sink dangereux » sans passage par
 * un sanitizer déclaré. Implémentation intra-fonction v1 :
 *
 *   1. Pour chaque fonction/arrow/méthode : construit un scope.
 *   2. Dans l'ordre du code : chaque déclaration `const x = INIT` et chaque
 *      assignation `x = RHS` met à jour un `tainted: Map<varName, sourceName>`.
 *   3. Une expression est « tainted » si :
 *      - elle matche un pattern de source (ex: `req.body`), OU
 *      - elle est un identifier dont le nom est dans `tainted`, OU
 *      - sa racine de chaîne d'accès est dans `tainted` (ex: `body.foo`
 *        quand `body` est tainted).
 *   4. Chaque CallExpression matchant un sink est vérifié : si un arg est
 *      tainted, émettre une `TaintViolation` avec la chaîne reconstituée.
 *   5. Les appels matchant un sanitizer « lavent » le résultat — un
 *      `const x = sanitizer(tainted)` ne taint pas `x`.
 *
 * Limites v1 (assumées) :
 *   - Pas de cross-fonction : si F retourne `req.body` et G fait `eval(F())`,
 *     la violation n'est pas remontée (F n'a pas de sink, G n'a pas de source
 *     directe — chaîne interrompue).
 *   - Pas de flow-sensitive : `x = clean; sink(x); x = tainted` n'émet rien
 *     (x était clean au site du sink — correct). Mais `if (c) x = tainted;
 *     sink(x)` flagge toujours (conservateur).
 *   - Propagation à travers n'importe quel call non-sanitizer, non-source :
 *     `sink(derive(tainted))` → VIOLATION. Faux positif possible mais
 *     conservatif : un helper custom qui serait en fait safe doit être
 *     déclaré comme sanitizer pour éviter le bruit.
 *   - ElementAccess (`x[y]`) dégrade la chaîne en skippant l'index — suffit
 *     pour repérer `req.body[foo]` comme tainted.
 */

import { Project, SyntaxKind, Node, type SourceFile } from 'ts-morph'
import * as path from 'node:path'
import type {
  TaintRules,
  TaintViolation,
  TaintChainStep,
  TaintPattern,
  TaintRule,
} from '../core/types.js'

interface TaintInfo {
  sourceName: string
  sourceLine: number
  sourceDetail: string
}

export async function analyzeTaint(
  rootDir: string,
  files: string[],
  project: Project,
  rules: TaintRules,
): Promise<TaintViolation[]> {
  const fileSet = new Set(files)
  const violations: TaintViolation[] = []

  for (const sf of project.getSourceFiles()) {
    const absPath = sf.getFilePath() as string
    const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/')
    if (!fileSet.has(relPath)) continue
    violations.push(...scanTaintInSourceFile(sf, relPath, rules))
  }

  violations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  return violations
}

/**
 * Helper réutilisable : scanne UN SourceFile et retourne les violations
 * détectées (sans tri global). Réutilisé par la version Salsa.
 */
export function scanTaintInSourceFile(
  sf: SourceFile,
  relPath: string,
  rules: TaintRules,
): TaintViolation[] {
  const violations: TaintViolation[] = []
  const scopes: Node[] = [sf]
  sf.forEachDescendant((node) => {
    const k = node.getKind()
    if (
      k === SyntaxKind.FunctionDeclaration ||
      k === SyntaxKind.FunctionExpression ||
      k === SyntaxKind.ArrowFunction ||
      k === SyntaxKind.MethodDeclaration
    ) {
      scopes.push(node)
    }
  })
  const lineToSymbol = buildLineToSymbol(sf)
  for (const scope of scopes) {
    analyzeScope(scope, relPath, lineToSymbol, rules, violations)
  }
  return violations
}

// ─── Scope analysis ───────────────────────────────────────────────────────

const NESTED_FN_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
])

function isNestedFunctionScope(node: Node, scope: Node): boolean {
  return node !== scope && NESTED_FN_KINDS.has(node.getKind())
}

function handleVarDeclaration(node: Node, tainted: Map<string, TaintInfo>, rules: TaintRules): void {
  const vd = node as any
  const name = vd.getName?.()
  const init = vd.getInitializer?.()
  if (!name || !init) return
  handleAssignment(name, init, tainted, rules)
}

function handleAssignmentExpression(node: Node, tainted: Map<string, TaintInfo>, rules: TaintRules): void {
  const bin = node as any
  const op = bin.getOperatorToken?.()?.getKind?.()
  if (op !== SyntaxKind.EqualsToken) return
  const left = bin.getLeft?.()
  const right = bin.getRight?.()
  if (!left || !right) return
  if (left.getKind?.() !== SyntaxKind.Identifier) return
  const leftName = left.getText?.()
  if (!leftName) return
  handleAssignment(leftName, right, tainted, rules)
}

function analyzeScope(
  scope: Node,
  relPath: string,
  lineToSymbol: Map<number, string>,
  rules: TaintRules,
  violations: TaintViolation[],
): void {
  const tainted = new Map<string, TaintInfo>()
  // Corps du scope : pour fn/method/arrow on prend le body. Pour le file
  // c'est le SourceFile lui-même.
  const body = (scope as any).getBody?.() ?? scope

  body.forEachDescendant((node: Node, traversal: any) => {
    if (isNestedFunctionScope(node, scope)) {
      traversal.skip()
      return
    }
    const k = node.getKind()
    if (k === SyntaxKind.VariableDeclaration) {
      handleVarDeclaration(node, tainted, rules)
    } else if (k === SyntaxKind.BinaryExpression) {
      handleAssignmentExpression(node, tainted, rules)
    } else if (k === SyntaxKind.CallExpression) {
      handleCall(node, tainted, rules, relPath, lineToSymbol, violations)
    }
  })
}

function handleAssignment(
  name: string,
  init: Node,
  tainted: Map<string, TaintInfo>,
  rules: TaintRules,
): void {
  // Sanitizer call → clean (le retour est considéré washed).
  if (isCallExpression(init) && matchesAnyRule(init, rules.sanitizers)) {
    tainted.delete(name)
    return
  }

  // Source direct.
  const sourceHit = matchAsSource(init, rules.sources)
  if (sourceHit) {
    tainted.set(name, {
      sourceName: sourceHit,
      sourceLine: init.getStartLineNumber(),
      sourceDetail: truncate(init.getText(), 80),
    })
    return
  }

  // Propagation : init référence un binding tainted.
  // Crucial : on check AVANT de clear, pour permettre `x = x.foo`.
  const propagated = getTaintFromExpression(init, tainted, rules.sources)
  if (propagated) {
    tainted.set(name, propagated)
    return
  }

  // Rien de tainted dans init → cette ré-assignation lave la variable.
  tainted.delete(name)
}

function handleCall(
  node: Node,
  tainted: Map<string, TaintInfo>,
  rules: TaintRules,
  relPath: string,
  lineToSymbol: Map<number, string>,
  violations: TaintViolation[],
): void {
  // Match sink ?
  let hitSink: TaintRule | null = null
  for (const s of rules.sinks) {
    if (matchesRulePattern(node, s.pattern)) { hitSink = s; break }
  }
  if (!hitSink) return

  const args = (node as any).getArguments?.() as Node[] | undefined
  if (!args || args.length === 0) return

  for (const arg of args) {
    const t = getTaintFromExpression(arg, tainted, rules.sources)
    if (!t) continue

    const line = node.getStartLineNumber()
    const symbol = lineToSymbol.get(line) ?? ''
    const chain: TaintChainStep[] = [
      {
        kind: 'source',
        file: relPath,
        line: t.sourceLine,
        detail: `[${t.sourceName}] ${t.sourceDetail}`,
      },
      {
        kind: 'sink',
        file: relPath,
        line,
        detail: `[${hitSink.name}] ${truncate(node.getText(), 80)}`,
      },
    ]

    violations.push({
      sourceName: t.sourceName,
      sinkName: hitSink.name,
      severity: hitSink.severity ?? 'medium',
      file: relPath,
      line,
      symbol,
      chain,
    })
    return  // un seul event par call même si plusieurs args tainted
  }
}

// ─── Pattern matching ────────────────────────────────────────────────────

function matchesRulePattern(node: Node, pattern: TaintPattern): boolean {
  const k = node.getKind()
  if (pattern.kind === 'call') {
    if (k !== SyntaxKind.CallExpression) return false
    const expr = (node as any).getExpression?.()
    if (!expr) return false
    if (expr.getKind?.() !== SyntaxKind.Identifier) return false
    return expr.getText?.() === pattern.name
  }
  if (pattern.kind === 'method-call') {
    if (k !== SyntaxKind.CallExpression) return false
    const expr = (node as any).getExpression?.()
    if (!expr) return false
    if (expr.getKind?.() !== SyntaxKind.PropertyAccessExpression) return false
    return expr.getName?.() === pattern.methodName
  }
  if (pattern.kind === 'property-access') {
    const chain = extractAccessChain(node)
    if (!chain) return false
    if (chain.length < pattern.path.length) return false
    for (let i = 0; i < pattern.path.length; i++) {
      if (chain[i] !== pattern.path[i]) return false
    }
    return true
  }
  return false
}

function matchesAnyRule(node: Node, rulesList: TaintRule[]): boolean {
  for (const r of rulesList) {
    if (matchesRulePattern(node, r.pattern)) return true
  }
  return false
}

function matchAsSource(node: Node, sources: TaintRule[]): string | null {
  for (const s of sources) {
    if (s.pattern.kind === 'property-access' && matchesRulePattern(node, s.pattern)) {
      return s.name
    }
  }
  return null
}

function isCallExpression(node: Node): boolean {
  return node.getKind() === SyntaxKind.CallExpression
}

/**
 * `a.b.c` → `['a', 'b', 'c']`
 * `a[idx].c` → `['a', 'c']` (skipe l'index)
 * `foo` → `['foo']`
 * `x()` → null
 * `x + y` → null
 */
function extractAccessChain(node: Node): string[] | null {
  const parts: string[] = []
  let cur: Node | undefined = node
  while (cur) {
    const k = cur.getKind()
    if (k === SyntaxKind.PropertyAccessExpression) {
      parts.unshift((cur as any).getName?.() ?? '')
      cur = (cur as any).getExpression?.()
      continue
    }
    if (k === SyntaxKind.ElementAccessExpression) {
      cur = (cur as any).getExpression?.()
      continue
    }
    if (k === SyntaxKind.Identifier) {
      parts.unshift((cur as any).getText?.() ?? '')
      return parts
    }
    if (k === SyntaxKind.ThisKeyword) {
      parts.unshift('this')
      return parts
    }
    return null
  }
  return null
}

/**
 * Retourne TaintInfo si l'expression est actuellement tainted. Trois voies :
 *   - match direct d'un source pattern
 *   - identifier dont le nom est dans `tainted`
 *   - PropertyAccess dont la racine est dans `tainted`
 *   - Call dont au moins un arg est tainted (propagation conservatrice —
 *     un helper custom doit être déclaré sanitizer pour éviter)
 */
function getTaintFromExpression(
  node: Node,
  tainted: Map<string, TaintInfo>,
  sources: TaintRule[],
): TaintInfo | null {
  // Source directe
  const src = matchAsSource(node, sources)
  if (src) {
    return {
      sourceName: src,
      sourceLine: node.getStartLineNumber(),
      sourceDetail: truncate(node.getText(), 80),
    }
  }

  const k = node.getKind()

  // Identifier : tainted ?
  if (k === SyntaxKind.Identifier) {
    const name = node.getText()
    return tainted.get(name) ?? null
  }

  // PropertyAccess / ElementAccess : chain root ?
  if (k === SyntaxKind.PropertyAccessExpression || k === SyntaxKind.ElementAccessExpression) {
    const chain = extractAccessChain(node)
    if (chain && chain.length > 0) {
      return tainted.get(chain[0]!) ?? null
    }
    return null
  }

  // Call : propagation à travers l'appel.
  if (k === SyntaxKind.CallExpression) {
    const args = (node as any).getArguments?.() as Node[] | undefined
    if (!args) return null
    for (const a of args) {
      const t = getTaintFromExpression(a, tainted, sources)
      if (t) return t
    }
    return null
  }

  // Template literals avec expressions : si une expression embeddée est tainted.
  if (k === SyntaxKind.TemplateExpression) {
    const spans = (node as any).getTemplateSpans?.() as Node[] | undefined
    if (spans) {
      for (const span of spans) {
        const expr = (span as any).getExpression?.()
        if (expr) {
          const t = getTaintFromExpression(expr, tainted, sources)
          if (t) return t
        }
      }
    }
  }

  return null
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean
}

function buildLineToSymbol(sf: any): Map<number, string> {
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
