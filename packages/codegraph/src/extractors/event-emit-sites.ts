/**
 * Event Emit Sites Extractor
 *
 * Scanne les call expressions `emit(...)` / `emitEvent(...)` (y compris
 * les variantes méthode `bus.emit(...)`, `this.emit(...)`) et inspecte le
 * premier argument pour extraire la propriété `type`. Distingue trois cas :
 *
 *   - `kind: 'literal'`        →  `emit({ type: 'render.completed', ... })`
 *                                 → candidat de violation pour les ADRs qui
 *                                   imposent l'usage d'une const (ex: ADR-017
 *                                   Sentinel).
 *   - `kind: 'eventConstRef'`  →  `emit({ type: EVENTS.RENDER_COMPLETED })`
 *                                 ou `emit({ type: VISUAL_EVENTS.STARTED })`.
 *                                 Conforme — on capture l'expression complète
 *                                 (`EVENTS.RENDER_COMPLETED`) pour audit.
 *   - `kind: 'dynamic'`        →  `emit({ type: someVar, ... })` ou tout autre
 *                                 initializer non-littéral et non-property-
 *                                 access. À traiter au cas par cas.
 *
 * Use case primaire : générer les facts Datalog `EmitsEventLiteral(file, line,
 * eventName)` et `EmitsEventConst(file, line, expr)` pour qu'une règle
 * détecte `Violation(F, L, "ADR-017 untyped emit") :- EmitsEventLiteral(F, L, _).`
 *
 * Limites v1 :
 *   - Le premier arg doit être un object literal direct. Une variable
 *     `emit(payload)` n'est pas inspectée.
 *   - L'identifier du callee est restreint à `emit` ou `emitEvent` (rightmost
 *     pour les MethodCalls). Un wrapper `bus.send(...)` ne sera pas vu.
 */

import { Project, SyntaxKind, type SourceFile, type Node } from 'ts-morph'
import * as path from 'node:path'

export interface EventEmitSite {
  /** Chemin relatif au rootDir. */
  file: string
  line: number
  /** Fonction / méthode englobante. '' pour module-level. */
  symbol: string
  /** Identifier de la fonction appelée (`emit`, `emitEvent`). */
  callee: string
  /** True ssi l'appel est de la forme `obj.emit(...)` (vs `emit(...)` libre). */
  isMethodCall: boolean
  /** Receiver du method call ('this', 'bus', etc.). undefined sinon. */
  receiver?: string
  kind: 'literal' | 'eventConstRef' | 'dynamic'
  /** Présent ssi kind='literal'. */
  literalValue?: string
  /**
   * Présent ssi kind='eventConstRef'. Texte exact : `EVENTS.RENDER_COMPLETED`,
   * `VISUAL_EVENTS.STARTED`. La règle Datalog peut splitter sur '.' pour
   * récupérer le namespace et le membre.
   */
  refExpression?: string
}

const EMIT_NAMES = new Set(['emit', 'emitEvent'])

export interface EventEmitSitesOptions {
  /** Override de l'ensemble des callee names à matcher. */
  emitFnNames?: string[]
}

export async function analyzeEventEmitSites(
  rootDir: string,
  files: string[],
  project: Project,
  options: EventEmitSitesOptions = {},
): Promise<EventEmitSite[]> {
  const targetNames = options.emitFnNames
    ? new Set(options.emitFnNames)
    : EMIT_NAMES
  const fileSet = new Set(files)
  const out: EventEmitSite[] = []

  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue
    out.push(...scanEmitSitesInSourceFile(sf, relPath, targetNames))
  }

  out.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  return out
}

/**
 * Helper réutilisable : scanne UN SourceFile et retourne tous les
 * `emit({ type: ... })` capturés. Réutilisé par la version Salsa.
 *
 * Court-circuit textuel : si aucun nom de callee cible n'apparaît
 * dans le fichier, on évite le `forEachDescendant` complet.
 */
export function scanEmitSitesInSourceFile(
  sf: SourceFile,
  relPath: string,
  targetNames: ReadonlySet<string> = EMIT_NAMES,
): EventEmitSite[] {
  const out: EventEmitSite[] = []

  const text = sf.getFullText()
  let any = false
  for (const n of targetNames) {
    if (text.includes(n + '(')) { any = true; break }
  }
  if (!any) return out

  const lineToSymbol = buildLineToSymbol(sf)

  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const callee = call.getExpression?.()
    if (!callee) return

    const calleeKind = callee.getKind?.()
    let calleeName: string | undefined
    let isMethodCall = false
    let receiver: string | undefined

    if (calleeKind === SyntaxKind.Identifier) {
      calleeName = callee.getText?.()
    } else if (calleeKind === SyntaxKind.PropertyAccessExpression) {
      // bus.emit(...), this.emit(...), foo.bar.emit(...)
      calleeName = callee.getName?.()
      isMethodCall = true
      const left = callee.getExpression?.()
      if (left) receiver = left.getText?.()
    } else {
      return
    }

    if (!calleeName || !targetNames.has(calleeName)) return

    const args = call.getArguments?.() as Node[] | undefined
    if (!args || args.length === 0) return
    const firstArg = args[0]
    if (firstArg.getKind() !== SyntaxKind.ObjectLiteralExpression) return

    // Trouver la propriété `type:`
    const obj = firstArg as any
    const props = obj.getProperties?.() as Node[] | undefined
    if (!props) return
    let typeProp: any
    for (const p of props) {
      if (p.getKind() !== SyntaxKind.PropertyAssignment) continue
      const pa = p as any
      const nameNode = pa.getNameNode?.()
      if (!nameNode) continue
      const nameText = nameNode.getKind?.() === SyntaxKind.Identifier
        ? nameNode.getText?.()
        : nameNode.getKind?.() === SyntaxKind.StringLiteral
          ? nameNode.getLiteralText?.()
          : undefined
      if (nameText === 'type') { typeProp = pa; break }
    }
    if (!typeProp) return

    const init = typeProp.getInitializer?.()
    if (!init) return
    const initKind = init.getKind?.()
    const line = call.getStartLineNumber?.() ?? 0
    const symbol = lineToSymbol.get(line) ?? ''

    let kind: EventEmitSite['kind']
    let literalValue: string | undefined
    let refExpression: string | undefined

    if (
      initKind === SyntaxKind.StringLiteral ||
      initKind === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      kind = 'literal'
      literalValue = init.getLiteralText?.()
    } else if (initKind === SyntaxKind.PropertyAccessExpression) {
      kind = 'eventConstRef'
      refExpression = init.getText?.()
    } else {
      kind = 'dynamic'
    }

    out.push({
      file: relPath,
      line,
      symbol,
      callee: calleeName,
      isMethodCall,
      ...(receiver ? { receiver } : {}),
      kind,
      ...(literalValue !== undefined ? { literalValue } : {}),
      ...(refExpression !== undefined ? { refExpression } : {}),
    })
  })

  return out
}

export const DEFAULT_EMIT_NAMES = EMIT_NAMES

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativize(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath)
  if (rel.startsWith('..')) return null
  return rel.replace(/\\/g, '/')
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
