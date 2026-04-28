/**
 * Detector Registry
 *
 * Central point for all available detectors.
 * The CLI loads detectors from here by name.
 *
 * Détecteurs marqués `projectSpecific: true` ne sont PAS inclus dans la
 * liste par défaut — il faut les nommer explicitement dans la config.
 * Utile pour des conventions très spécifiques à un projet (ex: Sentinel
 * `BLOCK_CONSTRUCTORS` pour le block-loader).
 */

import type { Detector } from '../core/types.js'
import { TsImportDetector } from './ts-imports.js'
import { EventBusDetector } from './event-bus.js'
import { HttpRouteDetector } from './http-routes.js'
import { BullmqQueueDetector } from './bullmq-queues.js'
import { BlockLoaderDetector } from './block-loader.js'
import { DbTableDetector } from './db-tables.js'

interface DetectorEntry {
  factory: () => Detector
  /** Si true, exclu du défaut "tous les détecteurs". Doit être nommé explicitement. */
  projectSpecific?: boolean
}

/** All available detectors, keyed by name */
const ALL_DETECTORS: Record<string, DetectorEntry> = {
  'ts-imports': { factory: () => new TsImportDetector() },
  'event-bus': { factory: () => new EventBusDetector() },
  'http-routes': { factory: () => new HttpRouteDetector() },
  'bullmq-queues': { factory: () => new BullmqQueueDetector() },
  'db-tables': { factory: () => new DbTableDetector() },
  // Sentinel-spécifique : cherche `const BLOCK_CONSTRUCTORS: Record<string, ...>`
  // qui est une convention Sentinel pour le dynamic block loading.
  // Opt-in uniquement.
  'block-loader': { factory: () => new BlockLoaderDetector(), projectSpecific: true },
}

/**
 * Default detector set : tous SAUF les projet-spécifiques.
 * Utilisé quand le config.detectors est absent ou vide.
 */
const DEFAULT_DETECTOR_NAMES = Object.entries(ALL_DETECTORS)
  .filter(([_, entry]) => !entry.projectSpecific)
  .map(([name]) => name)

/**
 * Instantiate detectors by name.
 * If names is empty/undefined, returns the DEFAULT set (project-specific exclus).
 */
export function createDetectors(names?: string[]): Detector[] {
  const effectiveNames = (!names || names.length === 0) ? DEFAULT_DETECTOR_NAMES : names

  return effectiveNames.map(name => {
    const entry = ALL_DETECTORS[name]
    if (!entry) {
      throw new Error(
        `Unknown detector: "${name}". Available: ${Object.keys(ALL_DETECTORS).join(', ')}`
      )
    }
    return entry.factory()
  })
}

export function listDetectorNames(): string[] {
  return Object.keys(ALL_DETECTORS)
}

export function defaultDetectorNames(): string[] {
  return [...DEFAULT_DETECTOR_NAMES]
}
