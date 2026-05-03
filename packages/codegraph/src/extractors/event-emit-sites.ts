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
import { buildLineToSymbol } from './_shared/ast-helpers.js'

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
  if (!hasAnyTargetCallee(sf, targetNames)) return out

  const lineToSymbol = buildLineToSymbol(sf)
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    processEmitCall(node, targetNames, lineToSymbol, relPath, out)
  })
  return out
}

/**
 * Court-circuit textuel : si aucun nom de callee cible n'apparaît dans le
 * fichier, on évite le forEachDescendant complet.
 */
function hasAnyTargetCallee(sf: SourceFile, targetNames: ReadonlySet<string>): boolean {
  const text = sf.getFullText()
  for (const n of targetNames) {
    if (text.includes(n + '(')) return true
  }
  return false
}

interface CalleeInfo {
  calleeName: string
  isMethodCall: boolean
  receiver?: string
}

/** Extrait calleeName + isMethodCall + receiver (bus.emit / this.emit / etc). */
function extractCalleeInfo(callee: any): CalleeInfo | null {
  const calleeKind = callee.getKind?.()
  if (calleeKind === SyntaxKind.Identifier) {
    const name = callee.getText?.()
    return name ? { calleeName: name, isMethodCall: false } : null
  }
  if (calleeKind === SyntaxKind.PropertyAccessExpression) {
    const name = callee.getName?.()
    if (!name) return null
    const left = callee.getExpression?.()
    return {
      calleeName: name,
      isMethodCall: true,
      ...(left ? { receiver: left.getText?.() as string | undefined } : {}),
    }
  }
  return null
}

/** Cherche la PropertyAssignment `type:` dans un ObjectLiteral. */
function findTypePropAssignment(props: Node[]): any | null {
  for (const p of props) {
    if (p.getKind() !== SyntaxKind.PropertyAssignment) continue
    const pa = p as any
    const nameNode = pa.getNameNode?.()
    if (!nameNode) continue
    if (readPropName(nameNode) === 'type') return pa
  }
  return null
}

function readPropName(nameNode: any): string | undefined {
  const k = nameNode.getKind?.()
  if (k === SyntaxKind.Identifier) return nameNode.getText?.()
  if (k === SyntaxKind.StringLiteral) return nameNode.getLiteralText?.()
  return undefined
}

interface TypeKind {
  kind: EventEmitSite['kind']
  literalValue?: string
  refExpression?: string
}

/** Classifie l'initializer de la prop `type:` : literal / eventConstRef / dynamic. */
function classifyTypeInit(init: any): TypeKind {
  const initKind = init.getKind?.()
  if (initKind === SyntaxKind.StringLiteral || initKind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return { kind: 'literal', literalValue: init.getLiteralText?.() as string | undefined }
  }
  if (initKind === SyntaxKind.PropertyAccessExpression) {
    return { kind: 'eventConstRef', refExpression: init.getText?.() as string | undefined }
  }
  return { kind: 'dynamic' }
}

/** Process un CallExpression candidat : valide la shape + push si match. */
function processEmitCall(
  call: Node,
  targetNames: ReadonlySet<string>,
  lineToSymbol: Map<number, string>,
  relPath: string,
  out: EventEmitSite[],
): void {
  const c = call as any
  const callee = c.getExpression?.()
  if (!callee) return
  const calleeInfo = extractCalleeInfo(callee)
  if (!calleeInfo || !targetNames.has(calleeInfo.calleeName)) return

  const args = c.getArguments?.() as Node[] | undefined
  if (!args || args.length === 0) return
  const firstArg = args[0]
  if (firstArg.getKind() !== SyntaxKind.ObjectLiteralExpression) return

  const props = (firstArg as any).getProperties?.() as Node[] | undefined
  if (!props) return
  const typeProp = findTypePropAssignment(props)
  if (!typeProp) return

  const init = typeProp.getInitializer?.()
  if (!init) return

  const line = c.getStartLineNumber?.() ?? 0
  const typeKind = classifyTypeInit(init)
  out.push({
    file: relPath,
    line,
    symbol: lineToSymbol.get(line) ?? '',
    callee: calleeInfo.calleeName,
    isMethodCall: calleeInfo.isMethodCall,
    ...(calleeInfo.receiver ? { receiver: calleeInfo.receiver } : {}),
    kind: typeKind.kind,
    ...(typeKind.literalValue !== undefined ? { literalValue: typeKind.literalValue } : {}),
    ...(typeKind.refExpression !== undefined ? { refExpression: typeKind.refExpression } : {}),
  })
}

export const DEFAULT_EMIT_NAMES = EMIT_NAMES

// ─── Helpers ────────────────────────────────────────────────────────────────

function relativize(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath)
  if (rel.startsWith('..')) return null
  return rel.replace(/\\/g, '/')
}

// buildLineToSymbol moved to _shared/ast-helpers.ts (NCD dedup).
