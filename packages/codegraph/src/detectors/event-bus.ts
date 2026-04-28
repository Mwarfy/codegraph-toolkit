/**
 * Event Bus Detector
 *
 * Discovers event-based connections in the Sentinel codebase.
 *
 * Patterns detected:
 * 1. Block declarations: `get emits() { return ['event.name'] }`
 *                        `get listensTo() { return ['event.name', '*.found'] }`
 * 2. Direct emit calls: `emit({ type: 'event.name', ... })`
 *                        `emitEvent({ type: 'event.name', ... })`
 * 3. Direct listen calls: `listen('event.name', handler)`
 *
 * Glob patterns like '*.found' are expanded against all known emitted events.
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
    const emitters: EventDeclaration[] = []
    const listeners: EventDeclaration[] = []
    const directEmits: EventDeclaration[] = []
    const directListens: EventDeclaration[] = []

    // Regex for block-style declarations
    const emitsPattern = /get\s+emits\(\)\s*(?::\s*string\[\])?\s*\{\s*return\s*\[([^\]]*)\]/g
    const listensToPattern = /get\s+listensTo\(\)\s*(?::\s*string\[\])?\s*\{\s*return\s*\[([^\]]*)\]/g

    // Regex for direct emit calls
    const emitCallPattern = /(?:emit|emitEvent)\(\s*\{[^}]*type:\s*['"]([^'"]+)['"]/g

    // Regex for direct listen calls
    const listenCallPattern = /listen\(\s*['"]([^'"]+)['"]/g

    for (const file of ctx.files) {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue

      const content = await ctx.readFile(file)

      // Block emits declarations
      let match: RegExpExecArray | null
      emitsPattern.lastIndex = 0
      while ((match = emitsPattern.exec(content)) !== null) {
        const events = this.parseStringArray(match[1])
        if (events.length > 0) {
          const line = this.getLineNumber(content, match.index)
          emitters.push({ file, eventNames: events, line })
        }
      }

      // Block listensTo declarations
      listensToPattern.lastIndex = 0
      while ((match = listensToPattern.exec(content)) !== null) {
        const events = this.parseStringArray(match[1])
        if (events.length > 0) {
          const line = this.getLineNumber(content, match.index)
          listeners.push({ file, eventNames: events, line })
        }
      }

      // Direct emit() calls
      emitCallPattern.lastIndex = 0
      while ((match = emitCallPattern.exec(content)) !== null) {
        const line = this.getLineNumber(content, match.index)
        directEmits.push({ file, eventNames: [match[1]], line })
      }

      // Direct listen() calls
      listenCallPattern.lastIndex = 0
      while ((match = listenCallPattern.exec(content)) !== null) {
        const line = this.getLineNumber(content, match.index)
        directListens.push({ file, eventNames: [match[1]], line })
      }
    }

    // Merge all emitters and listeners
    const allEmitters = [...emitters, ...directEmits]
    const allListeners = [...listeners, ...directListens]

    // Collect all known emitted event names (for glob expansion)
    const allEmittedEvents = new Set<string>()
    for (const e of allEmitters) {
      for (const name of e.eventNames) {
        allEmittedEvents.add(name)
      }
    }

    // Build links: for each listener, find all emitters that match
    const links: DetectedLink[] = []

    for (const listener of allListeners) {
      for (const listenPattern of listener.eventNames) {
        // Expand glob patterns against known events
        const matchingEvents = this.expandGlob(listenPattern, allEmittedEvents)

        for (const eventName of matchingEvents) {
          // Find all emitters of this event
          for (const emitter of allEmitters) {
            if (emitter.file === listener.file) continue // skip self-links
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

        // If glob matched nothing — might be listening to external events
        if (matchingEvents.length === 0 && !listenPattern.includes('*')) {
          // This listener has no known emitter — could be an external source
          // Don't create a link, but the listener file won't be orphaned
          // because of other connections
        }
      }
    }

    return this.deduplicateLinks(links)
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
