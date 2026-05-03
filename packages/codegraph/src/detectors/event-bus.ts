/**
 * Event Bus Detector
 *
 * Discovers event-based connections via emit/listen patterns.
 *
 * Patterns détectés (généralistes) :
 * 1. Direct emit calls : `emit({ type: 'event.name', ... })`
 *                         `emitEvent({ type: 'event.name', ... })`
 * 2. Direct listen calls : `listen('event.name', handler)`
 *
 * Patterns optionnels (convention class-based — fail silencieux ailleurs) :
 * 3. `get emits() { return ['event.name'] }`
 *    `get listensTo() { return ['event.name', '*.found'] }`
 *
 * Glob patterns comme '*.found' sont expandés contre les événements connus.
 */

import type { Detector, DetectorContext, DetectedLink } from '../core/types.js'
import { minimatch } from 'minimatch'

interface EventDeclaration {
  file: string
  eventNames: string[]
  line: number
}

export class EventBusDetector implements Detector {
  name = 'event-bus'
  edgeType = 'event' as const
  description = 'Event-bus emit/listen relationships between blocks'

  async detect(ctx: DetectorContext): Promise<DetectedLink[]> {
    const { allEmitters, allListeners } = await this.collectEmittersAndListeners(ctx)
    const allEmittedEvents = collectEmittedEventNames(allEmitters)
    const links = this.buildLinksFromEmittersListeners(allEmitters, allListeners, allEmittedEvents)
    return this.deduplicateLinks(links)
  }

  /**
   * Lit en parallèle les .ts/.tsx files + extract block-style declarations
   * + direct emit/listen calls via 4 regex.
   */
  private async collectEmittersAndListeners(
    ctx: DetectorContext,
  ): Promise<{ allEmitters: EventDeclaration[]; allListeners: EventDeclaration[] }> {
    const emitters: EventDeclaration[] = []
    const listeners: EventDeclaration[] = []
    const directEmits: EventDeclaration[] = []
    const directListens: EventDeclaration[] = []

    const tsFiles = ctx.files.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    const fileContents = await Promise.all(
      tsFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
    )
    for (const { file, content } of fileContents) {
      this.scanFileDeclarations(file, content, emitters, listeners, directEmits, directListens)
    }
    return {
      allEmitters: [...emitters, ...directEmits],
      allListeners: [...listeners, ...directListens],
    }
  }

  private scanFileDeclarations(
    file: string,
    content: string,
    emitters: EventDeclaration[],
    listeners: EventDeclaration[],
    directEmits: EventDeclaration[],
    directListens: EventDeclaration[],
  ): void {
    // Local regexes pour éviter race lastIndex partagé entre fichiers.
    const emitsRe = /get\s+emits\(\)\s*(?::\s*string\[\])?\s*\{\s*return\s*\[([^\]]*)\]/g
    const listensToRe = /get\s+listensTo\(\)\s*(?::\s*string\[\])?\s*\{\s*return\s*\[([^\]]*)\]/g
    const emitCallRe = /(?:emit|emitEvent)\(\s*\{[^}]*type:\s*['"]([^'"]+)['"]/g
    const listenCallRe = /listen\(\s*['"]([^'"]+)['"]/g

    this.collectArrayDeclarations(file, content, emitsRe, emitters)
    this.collectArrayDeclarations(file, content, listensToRe, listeners)
    this.collectDirectCalls(file, content, emitCallRe, directEmits)
    this.collectDirectCalls(file, content, listenCallRe, directListens)
  }

  /** Scan block-style `get emits() { return ['a', 'b'] }` ou listensTo. */
  private collectArrayDeclarations(
    file: string,
    content: string,
    re: RegExp,
    out: EventDeclaration[],
  ): void {
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      const events = this.parseStringArray(match[1])
      if (events.length > 0) {
        out.push({ file, eventNames: events, line: this.getLineNumber(content, match.index) })
      }
    }
  }

  /** Scan direct calls `emit({ type: 'foo' })` ou listen('foo'). */
  private collectDirectCalls(
    file: string,
    content: string,
    re: RegExp,
    out: EventDeclaration[],
  ): void {
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      out.push({
        file,
        eventNames: [match[1]],
        line: this.getLineNumber(content, match.index),
      })
    }
  }

  private buildLinksFromEmittersListeners(
    allEmitters: EventDeclaration[],
    allListeners: EventDeclaration[],
    allEmittedEvents: Set<string>,
  ): DetectedLink[] {
    const links: DetectedLink[] = []
    for (const listener of allListeners) {
      for (const listenPattern of listener.eventNames) {
        // Expand glob patterns against known events.
        const matchingEvents = this.expandGlob(listenPattern, allEmittedEvents)
        for (const eventName of matchingEvents) {
          this.appendLinksForEvent(eventName, listenPattern, listener, allEmitters, links)
        }
        // If glob matched nothing : potential external source — don't create
        // a link, le listener file restera connecté via d'autres edges.
      }
    }
    return links
  }

  private appendLinksForEvent(
    eventName: string,
    listenPattern: string,
    listener: EventDeclaration,
    allEmitters: EventDeclaration[],
    links: DetectedLink[],
  ): void {
    for (const emitter of allEmitters) {
      if (emitter.file === listener.file) continue  // skip self-links
      if (!emitter.eventNames.includes(eventName)) continue
      links.push({
        from: emitter.file,
        to: listener.file,
        type: 'event',
        label: eventName,
        resolved: true,
        line: emitter.line,
        meta: {
          emitLine: emitter.line,
          listenLine: listener.line,
          pattern: listenPattern !== eventName ? listenPattern : undefined,
        },
      })
    }
  }

  private parseStringArray(arrayContent: string): string[] {
    const results: string[] = []
    const stringPattern = /['"]([^'"]+)['"]/g
    let match: RegExpExecArray | null
    while ((match = stringPattern.exec(arrayContent)) !== null) {
      results.push(match[1])
    }
    return results
  }

  private expandGlob(pattern: string, knownEvents: Set<string>): string[] {
    if (!pattern.includes('*')) {
      return knownEvents.has(pattern) ? [pattern] : [pattern] // return even if no emitter found
    }

    const matches: string[] = []
    for (const event of knownEvents) {
      if (minimatch(event, pattern)) {
        matches.push(event)
      }
    }
    return matches
  }

  private getLineNumber(content: string, offset: number): number {
    return content.substring(0, offset).split('\n').length
  }

  private deduplicateLinks(links: DetectedLink[]): DetectedLink[] {
    const seen = new Set<string>()
    return links.filter(link => {
      const key = `${link.from}--${link.type}--${link.to}--${link.label}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
}

/** Collect tous les event names émis (across all emitters) — pour glob expansion. */
function collectEmittedEventNames(emitters: EventDeclaration[]): Set<string> {
  const out = new Set<string>()
  for (const e of emitters) {
    for (const name of e.eventNames) out.add(name)
  }
  return out
}
