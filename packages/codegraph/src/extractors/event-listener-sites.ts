/**
 * Event Listener Sites Extractor (Phase 5 Tier 17).
 *
 * Symetrique de `event-emit-sites.ts` : capture les call sites
 * `bus.on('event.name', handler)`, `subscribe('event.name', handler)`,
 * `addEventListener('event.name', handler)`, `listen('event.name', handler)`.
 *
 * Pourquoi : on a `EmitsLiteral` / `EmitsConstRef` mais pas de symetrie
 * cote listeners. Bloque toute analyse event-orphan / listener-orphan
 * (cf. ADR-004 cross-block). Cette extraction comble le gap.
 *
 * Pattern v1 :
 *   - Callee text matche /^(on|once|subscribe|addEventListener|listen|listensTo)$/
 *     OU se termine par `.on` / `.subscribe` / `.addEventListener` / `.listen`.
 *   - Premier arg est StringLiteral OU PropertyAccessExpression
 *     (pour `EVENTS.RENDER_COMPLETED`).
 *   - On capture file, line, eventName (literal value ou expression text),
 *     callee, isMethodCall, receiver.
 *
 * Limites v1 :
 *   - Le 1er arg doit etre literal/const-ref. `bus.on(eventName, handler)`
 *     avec variable est skip (kind='dynamic').
 *   - Pas de tracking des handlers passes en 2eme arg.
 */

import { type Project, SyntaxKind, type SourceFile, Node } from 'ts-morph'
import { findContainingSymbol } from './_shared/ast-helpers.js'

const LISTENER_NAMES = new Set([
  'on', 'once', 'subscribe', 'addEventListener', 'listen', 'listensTo',
])

export interface EventListenerSite {
  file: string
  line: number
  symbol: string
  callee: string
  isMethodCall: boolean
  receiver?: string
  kind: 'literal' | 'eventConstRef' | 'dynamic'
  literalValue?: string
  refExpression?: string
}

export async function analyzeEventListenerSites(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<EventListenerSite[]> {
  const fileSet = new Set(files)
  const out: EventListenerSite[] = []

  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue
    out.push(...scanListenerSitesInSourceFile(sf, relPath))
  }

  out.sort((a, b) =>
    a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line,
  )
  return out
}

export function scanListenerSitesInSourceFile(
  sf: SourceFile,
  relPath: string,
): EventListenerSite[] {
  const text = sf.getFullText()
  // Court-circuit textuel
  let hasCandidate = false
  for (const n of LISTENER_NAMES) {
    if (text.includes(n + '(') || text.includes('.' + n + '(')) {
      hasCandidate = true
      break
    }
  }
  if (!hasCandidate) return []

  const out: EventListenerSite[] = []
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let calleeName = ''
    let isMethodCall = false
    let receiver: string | undefined

    if (Node.isIdentifier(callee)) {
      calleeName = callee.getText()
    } else if (Node.isPropertyAccessExpression(callee)) {
      calleeName = callee.getName()
      isMethodCall = true
      receiver = callee.getExpression().getText()
    } else {
      continue
    }
    if (!LISTENER_NAMES.has(calleeName)) continue

    const args = call.getArguments()
    if (args.length === 0) continue
    const arg0 = args[0]
    const line = call.getStartLineNumber()
    const symbol = findContainingSymbol(call)
    const fullCalleeText = isMethodCall && receiver
      ? `${receiver}.${calleeName}`
      : calleeName

    if (Node.isStringLiteral(arg0) || Node.isNoSubstitutionTemplateLiteral(arg0)) {
      out.push({
        file: relPath, line, symbol, callee: fullCalleeText,
        isMethodCall, receiver,
        kind: 'literal',
        literalValue: arg0.getLiteralValue(),
      })
    } else if (Node.isPropertyAccessExpression(arg0)) {
      out.push({
        file: relPath, line, symbol, callee: fullCalleeText,
        isMethodCall, receiver,
        kind: 'eventConstRef',
        refExpression: arg0.getText(),
      })
    } else {
      out.push({
        file: relPath, line, symbol, callee: fullCalleeText,
        isMethodCall, receiver,
        kind: 'dynamic',
      })
    }
  }
  return out
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
