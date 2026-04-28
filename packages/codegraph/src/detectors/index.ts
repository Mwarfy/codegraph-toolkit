/**
 * Detector Registry
 *
 * Central point for all available detectors.
 * The CLI loads detectors from here by name.
 */

import type { Detector } from '../core/types.js'
import { TsImportDetector } from './ts-imports.js'
import { EventBusDetector } from './event-bus.js'
import { HttpRouteDetector } from './http-routes.js'
import { BullmqQueueDetector } from './bullmq-queues.js'
import { BlockLoaderDetector } from './block-loader.js'
import { DbTableDetector } from './db-tables.js'

/** All available detectors, keyed by name */
const ALL_DETECTORS: Record<string, () => Detector> = {
  'ts-imports': () => new TsImportDetector(),
  'event-bus': () => new EventBusDetector(),
  'http-routes': () => new HttpRouteDetector(),
  'bullmq-queues': () => new BullmqQueueDetector(),
  'block-loader': () => new BlockLoaderDetector(),
  'db-tables': () => new DbTableDetector(),
}

/**
 * Instantiate detectors by name.
 * If names is empty, returns all detectors.
 */
export function createDetectors(names?: string[]): Detector[] {
  if (!names || names.length === 0) {
    return Object.values(ALL_DETECTORS).map(factory => factory())
  }

  return names.map(name => {
    const factory = ALL_DETECTORS[name]
    if (!factory) {
      throw new Error(
        `Unknown detector: "${name}". Available: ${Object.keys(ALL_DETECTORS).join(', ')}`
      )
    }
    return factory()
  })
}

export function listDetectorNames(): string[] {
  return Object.keys(ALL_DETECTORS)
}
