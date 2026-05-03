/**
 * BullMQ Queue Detector
 *
 * Discovers connections between queue producers and workers (BullMQ lib).
 *
 * Patterns :
 *   new Queue('queue-name', ...)
 *   new Worker('queue-name', handler, ...)
 *   queue.add('job-name', data, ...)
 *
 * Détecteur généraliste — utilisable par tout projet qui consomme BullMQ.
 */

import type { Detector, DetectorContext, DetectedLink } from '../core/types.js'

interface QueueUsage {
  file: string
  queueName: string
  role: 'producer' | 'consumer'
  line: number
  jobNames?: string[]
}

export class BullmqQueueDetector implements Detector {
  name = 'bullmq-queues'
  edgeType = 'queue' as const
  description = 'BullMQ queue producer → consumer relationships'

  async detect(ctx: DetectorContext): Promise<DetectedLink[]> {
    const tsFiles = ctx.files.filter((f) => f.endsWith('.ts'))
    const fileContents = await Promise.all(
      tsFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
    )

    const usages: QueueUsage[] = []
    for (const { file, content } of fileContents) {
      this.scanFileQueueUsages(file, content, usages)
    }

    const consumers = usages.filter((u) => u.role === 'consumer')
    const links: DetectedLink[] = []
    this.linkProducersToConsumers(usages, links)
    this.linkFallbackIntervals(fileContents, consumers, links)
    return links
  }

  /** Scan 1 file pour Queue / Worker / queue.add → usages + jobNames. */
  private scanFileQueueUsages(
    file: string,
    content: string,
    usages: QueueUsage[],
  ): void {
    // Local regexes pour éviter race lastIndex partagé entre fichiers
    // (sinon parallélisation casserait le state global de la regex).
    const queueRe = /new\s+Queue\s*\(\s*['"]([^'"]+)['"]/g
    const workerRe = /new\s+Worker\s*\(\s*['"]([^'"]+)['"]/g
    const addJobRe = /(?:queue|schedulerQueue)\s*\.?\s*add\s*\(\s*['"]([^'"]+)['"]/g

    this.collectRoleUsages(file, content, queueRe, 'producer', usages)
    this.collectRoleUsages(file, content, workerRe, 'consumer', usages)
    this.attachJobNames(file, content, addJobRe, usages)
  }

  private collectRoleUsages(
    file: string,
    content: string,
    re: RegExp,
    role: QueueUsage['role'],
    usages: QueueUsage[],
  ): void {
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      usages.push({
        file,
        queueName: match[1],
        role,
        line: this.getLineNumber(content, match.index),
      })
    }
  }

  private attachJobNames(
    file: string,
    content: string,
    addJobRe: RegExp,
    usages: QueueUsage[],
  ): void {
    const jobNames: string[] = []
    let match: RegExpExecArray | null
    while ((match = addJobRe.exec(content)) !== null) jobNames.push(match[1])
    if (jobNames.length === 0) return
    const existingUsage = usages.find((u) => u.file === file && u.role === 'producer')
    if (existingUsage) existingUsage.jobNames = jobNames
  }

  /** Link producers → consumers sur la même queue (skip self-links). */
  private linkProducersToConsumers(
    usages: QueueUsage[],
    links: DetectedLink[],
  ): void {
    const producers = usages.filter((u) => u.role === 'producer')
    const consumers = usages.filter((u) => u.role === 'consumer')
    for (const producer of producers) {
      for (const consumer of consumers) {
        if (producer.queueName !== consumer.queueName) continue
        if (producer.file === consumer.file) continue
        links.push({
          from: producer.file,
          to: consumer.file,
          type: 'queue',
          label: `queue:${producer.queueName}`,
          resolved: true,
          line: producer.line,
          meta: {
            queueName: producer.queueName,
            jobNames: producer.jobNames,
            producerLine: producer.line,
            consumerLine: consumer.line,
          },
        })
      }
    }
  }

  /**
   * Detect setInterval/setTimeout fallback patterns (Sentinel falls back to
   * setInterval when Redis is down). Skip mentions in comments / docstrings
   * (faux positif sur core/types.ts qui décrit les patterns dans des JSDoc).
   */
  private linkFallbackIntervals(
    fileContents: ReadonlyArray<{ file: string; content: string }>,
    consumers: QueueUsage[],
    links: DetectedLink[],
  ): void {
    for (const { file, content } of fileContents) {
      const intervalRe = /setInterval\s*\(\s*(\w+)/g
      let match: RegExpExecArray | null
      while ((match = intervalRe.exec(content)) !== null) {
        if (isInComment(content, match.index)) continue
        if (!hasFallbackContext(content, match.index)) continue
        this.appendFallbackLinks(file, content, match.index, consumers, links)
      }
    }
  }

  private appendFallbackLinks(
    file: string,
    content: string,
    matchIndex: number,
    consumers: QueueUsage[],
    links: DetectedLink[],
  ): void {
    for (const consumer of consumers) {
      if (consumer.file === file) continue
      links.push({
        from: file,
        to: consumer.file,
        type: 'queue',
        label: 'fallback-interval',
        resolved: true,
        line: this.getLineNumber(content, matchIndex),
        meta: { fallback: true },
      })
    }
  }

  private getLineNumber(content: string, offset: number): number {
    return content.substring(0, offset).split('\n').length
  }
}

/** Cherche des indices BullMQ-fallback (Redis down) autour du setInterval match. */
function hasFallbackContext(content: string, matchIndex: number): boolean {
  const surrounding = content.substring(Math.max(0, matchIndex - 200), matchIndex + 200)
  return surrounding.includes('fallback')
    || surrounding.includes('Redis')
    || surrounding.includes('bull')
}

/**
 * Heuristique simple : le match est-il dans un commentaire (line ou block) ?
 *
 * - Line comment : remonte au début de ligne ; si on trouve `//` avant le
 *   match sur la même ligne, skip.
 * - Block comment : compte les `/*` et `*\/` avant le match. Si plus de
 *   `/*` ouvrants que de `*\/` fermants, on est dans un block.
 * - Docblock heuristique : si la ligne commence par `*` (après whitespace),
 *   c'est un docblock JSDoc.
 *
 * Pas exhaustif (ne gère pas les cas tordus type string contenant `//`),
 * mais couvre 95% des cas réels et évite la dépendance AST.
 */
function isInComment(content: string, offset: number): boolean {
  // Line comment check
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1
  const lineBefore = content.substring(lineStart, offset)
  if (lineBefore.includes('//')) return true
  // Docblock heuristique
  if (/^\s*\*/.test(lineBefore)) return true
  // Block comment : count /* and */ before offset
  const before = content.substring(0, offset)
  const opens = (before.match(/\/\*/g) ?? []).length
  const closes = (before.match(/\*\//g) ?? []).length
  return opens > closes
}
