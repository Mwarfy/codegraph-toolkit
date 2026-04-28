/**
 * Truth points diff — phase 3 du PLAN.md.
 *
 * Matching par `concept`. Pour chaque concept présent dans les deux
 * snapshots, on compare :
 *   - `canonical` (before/after — none→table, table→none, ou table différente)
 *   - `mirrors` par clé (kind + key + file + line)
 *   - `writers` / `readers` par (file + symbol + line)
 *   - `exposed` par (kind + id + file + line)
 *
 * Un concept dont rien ne bouge n'apparaît pas dans `changed`.
 */

import type {
  GraphSnapshot,
  TruthExposure,
  TruthMirror,
  TruthPoint,
  TruthRef,
} from '../core/types.js'
import type { TruthPointChange, TruthPointsDiff } from './types.js'

// Matching par identité logique (phase 3.5) — la ligne reste dans la donnée
// affichée mais ne participe pas à la clé. Sinon un simple shift de code
// dans un fichier (ajout/retrait de ligne plus haut) fait apparaître les
// writers/readers/mirrors comme simultanément supprimés et ajoutés.
function mirrorKey(m: TruthMirror): string {
  return [m.kind, m.key, m.file].join('\u0000')
}
function refKey(r: TruthRef): string {
  return [r.file, r.symbol].join('\u0000')
}
function exposureKey(e: TruthExposure): string {
  return [e.kind, e.id, e.file ?? ''].join('\u0000')
}

function diffByKey<T>(
  before: T[],
  after: T[],
  keyOf: (item: T) => string,
): { added: T[]; removed: T[] } {
  const beforeMap = new Map(before.map((x) => [keyOf(x), x]))
  const afterMap = new Map(after.map((x) => [keyOf(x), x]))
  const added: T[] = []
  const removed: T[] = []
  for (const [k, v] of afterMap) if (!beforeMap.has(k)) added.push(v)
  for (const [k, v] of beforeMap) if (!afterMap.has(k)) removed.push(v)
  added.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
  removed.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
  return { added, removed }
}

function diffConcept(before: TruthPoint, after: TruthPoint): TruthPointChange | null {
  const canonicalBefore = before.canonical?.name ?? null
  const canonicalAfter = after.canonical?.name ?? null
  const canonicalChanged = canonicalBefore !== canonicalAfter

  const mirrors = diffByKey(before.mirrors, after.mirrors, mirrorKey)
  const writers = diffByKey(before.writers, after.writers, refKey)
  const readers = diffByKey(before.readers, after.readers, refKey)
  const exposed = diffByKey(before.exposed, after.exposed, exposureKey)

  const unchanged =
    !canonicalChanged &&
    mirrors.added.length === 0 && mirrors.removed.length === 0 &&
    writers.added.length === 0 && writers.removed.length === 0 &&
    readers.added.length === 0 && readers.removed.length === 0 &&
    exposed.added.length === 0 && exposed.removed.length === 0
  if (unchanged) return null

  return {
    concept: after.concept,
    canonicalBefore,
    canonicalAfter,
    mirrorsAdded: mirrors.added,
    mirrorsRemoved: mirrors.removed,
    writersAdded: writers.added,
    writersRemoved: writers.removed,
    readersAdded: readers.added,
    readersRemoved: readers.removed,
    exposedAdded: exposed.added,
    exposedRemoved: exposed.removed,
  }
}

export function diffTruthPoints(before: GraphSnapshot, after: GraphSnapshot): TruthPointsDiff {
  const beforeMap = new Map((before.truthPoints ?? []).map((t) => [t.concept, t]))
  const afterMap = new Map((after.truthPoints ?? []).map((t) => [t.concept, t]))

  const added: TruthPoint[] = []
  const changed: TruthPointChange[] = []
  for (const [concept, afterTp] of afterMap) {
    const prev = beforeMap.get(concept)
    if (prev === undefined) {
      added.push(afterTp)
      continue
    }
    const delta = diffConcept(prev, afterTp)
    if (delta) changed.push(delta)
  }

  const removed: TruthPoint[] = []
  for (const [concept, beforeTp] of beforeMap) {
    if (!afterMap.has(concept)) removed.push(beforeTp)
  }

  const byConcept = <T extends { concept: string }>(a: T, b: T): number =>
    a.concept < b.concept ? -1 : a.concept > b.concept ? 1 : 0
  added.sort(byConcept)
  removed.sort(byConcept)
  changed.sort(byConcept)

  return { added, removed, changed }
}
