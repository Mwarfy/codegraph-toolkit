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

    for (const file of ctx.files) {
      if (!file.endsWith('.ts')) continue

      const content = await ctx.readFile(file)
      let match: RegExpExecArray | null

      // Queue instantiation (producer side)
      queuePattern.lastIndex = 0
      while ((match = queuePattern.exec(content)) !== null) {
        usages.push({
          file,
          queueName: match[1],
          role: 'producer',
          line: this.getLineNumber(content, match.index),
        })
      }

      // Worker instantiation (consumer side)
      workerPattern.lastIndex = 0
      while ((match = workerPattern.exec(content)) !== null) {
        usages.push({
          file,
          queueName: match[1],
          role: 'consumer',
          line: this.getLineNumber(content, match.index),
        })
      }

      // Job additions — track which file adds which jobs
      const jobNames: string[] = []
      addJobPattern.lastIndex = 0
      while ((match = addJobPattern.exec(content)) !== null) {
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
    // (Sentinel falls back to setInterval when Redis is down)
    const intervalPattern = /setInterval\s*\(\s*(\w+)/g
    for (const file of ctx.files) {
      if (!file.endsWith('.ts')) continue
      const content = await ctx.readFile(file)

      intervalPattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = intervalPattern.exec(content)) !== null) {
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
