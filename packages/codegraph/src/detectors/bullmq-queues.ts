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
    const usages: QueueUsage[] = []
    const links: DetectedLink[] = []

    const queuePattern = /new\s+Queue\s*\(\s*['"]([^'"]+)['"]/g
    const workerPattern = /new\s+Worker\s*\(\s*['"]([^'"]+)['"]/g
    const addJobPattern = /(?:queue|schedulerQueue)\s*\.?\s*add\s*\(\s*['"]([^'"]+)['"]/g

    // Lit en parallèle les .ts files (I/O fs indépendantes), match séquentiel.
    const tsFiles = ctx.files.filter((f) => f.endsWith('.ts'))
    const fileContents = await Promise.all(
      tsFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
    )
    for (const { file, content } of fileContents) {
      let match: RegExpExecArray | null

      // Local regexes pour éviter race lastIndex partagé entre fichiers
      // (sinon parallélisation casserait le state global de la regex).
      const queueRe = new RegExp(queuePattern.source, queuePattern.flags)
      const workerRe = new RegExp(workerPattern.source, workerPattern.flags)
      const addJobRe = new RegExp(addJobPattern.source, addJobPattern.flags)

      // Queue instantiation (producer side)
      while ((match = queueRe.exec(content)) !== null) {
        usages.push({
          file,
          queueName: match[1],
          role: 'producer',
          line: this.getLineNumber(content, match.index),
        })
      }

      // Worker instantiation (consumer side)
      while ((match = workerRe.exec(content)) !== null) {
        usages.push({
          file,
          queueName: match[1],
          role: 'consumer',
          line: this.getLineNumber(content, match.index),
        })
      }

      // Job additions — track which file adds which jobs
      const jobNames: string[] = []
      while ((match = addJobRe.exec(content)) !== null) {
        jobNames.push(match[1])
      }

      if (jobNames.length > 0) {
        // Find which queue this file uses
        const existingUsage = usages.find(u => u.file === file && u.role === 'producer')
        if (existingUsage) {
          existingUsage.jobNames = jobNames
        }
      }
    }

    // Link producers to consumers on the same queue
    const producers = usages.filter(u => u.role === 'producer')
    const consumers = usages.filter(u => u.role === 'consumer')

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

    // Also detect setInterval/setTimeout fallback patterns
    // (Sentinel falls back to setInterval when Redis is down).
    // Réutilise tsFiles + lecture parallèle.
    const intervalPattern = /setInterval\s*\(\s*(\w+)/g
    const fileContents2 = await Promise.all(
      tsFiles.map(async (file) => ({ file, content: await ctx.readFile(file) })),
    )
    for (const { file, content } of fileContents2) {
      const intervalRe = new RegExp(intervalPattern.source, intervalPattern.flags)
      let match: RegExpExecArray | null
      while ((match = intervalRe.exec(content)) !== null) {
        // Skip mentions in comments / docstrings (audit codegraph-on-codegraph
        // a révélé le faux positif sur core/types.ts qui décrit les
        // patterns détectés dans des JSDoc).
        if (isInComment(content, match.index)) continue

        // Check if this is near a BullMQ fallback comment or pattern
        const surrounding = content.substring(
          Math.max(0, match.index - 200),
          match.index + 200
        )
        if (surrounding.includes('fallback') || surrounding.includes('Redis') || surrounding.includes('bull')) {
          // This is a fallback interval — link it to the same consumers
          for (const consumer of consumers) {
            if (consumer.file === file) continue
            links.push({
              from: file,
              to: consumer.file,
              type: 'queue',
              label: 'fallback-interval',
              resolved: true,
              line: this.getLineNumber(content, match.index),
              meta: { fallback: true },
            })
          }
        }
      }
    }

    return links
  }

  private getLineNumber(content: string, offset: number): number {
    return content.substring(0, offset).split('\n').length
  }
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
