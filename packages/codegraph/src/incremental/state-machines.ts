/**
 * Incremental state-machines — wrap Salsa autour du bundle per-file
 * + agrégation cross-file.
 *
 * Architecture :
 *   - `stateMachineBundleOfFile(path)` : derived → tout ce qu'on
 *     extrait d'UN SourceFile (concepts, fn ranges, triggers locaux,
 *     writes). Cache via fileContent.
 *   - `sqlDefaultsInput(label)` : input → WriteSignal[] pour les
 *     DEFAULT de colonnes SQL. Set par analyze() après async file
 *     read (hors-Salsa, contraint sync only).
 *   - `allStateMachines(label)` : croise les bundles + sql defaults,
 *     dédup les concepts, build les machines via le helper pure.
 *
 * Cache hit : modif d'1 fichier .ts → seul ce fichier ré-extrait son
 * bundle. Modif d'1 fichier .sql → réinjecte sqlDefaultsInput,
 * agrégat re-tourne mais bundles per-file restent en cache.
 */

import { derived, input } from '@liby-tools/salsa'
import {
  extractStateMachineFileBundle,
  buildStateMachinesFromBundles,
  DEFAULT_STATE_MACHINE_SUFFIXES,
  type StateMachineFileBundle,
  type StateConcept,
  type WriteSignal,
  type TriggerContext,
} from '../extractors/state-machines.js'
import type { StateMachine } from '../core/types.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

const DEFAULT_LISTEN_FNS = new Set(['listen', 'on'])

export const sqlDefaultsInput = input<string, readonly WriteSignal[]>(db, 'sqlDefaults')

export const stateMachineBundleOfFile = derived<string, StateMachineFileBundle>(
  db, 'stateMachineBundleOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) {
      return { concepts: [], fnRanges: [], listenerTriggers: [], routeTriggers: [], writes: [] }
    }
    return extractStateMachineFileBundle(sf, filePath, DEFAULT_LISTEN_FNS, DEFAULT_STATE_MACHINE_SUFFIXES)
  },
)

export const allStateMachines = derived<string, StateMachine[]>(
  db, 'allStateMachines',
  (label) => {
    const files = projectFiles.get(label)
    const sqlDefaults = sqlDefaultsInput.has(label) ? sqlDefaultsInput.get(label) : []

    const concepts: StateConcept[] = []
    const conceptNames = new Set<string>()
    const triggerCtx: TriggerContext = {
      listenerTrigger: new Map(),
      routeTriggers: new Map(),
    }
    const writes: WriteSignal[] = []

    for (const f of files) {
      const bundle = stateMachineBundleOfFile.get(f)
      for (const c of bundle.concepts) {
        if (conceptNames.has(c.name)) continue
        conceptNames.add(c.name)
        concepts.push(c)
      }
      for (const lt of bundle.listenerTriggers) {
        triggerCtx.listenerTrigger.set(lt.container, lt.eventName)
      }
      for (const rt of bundle.routeTriggers) {
        if (!triggerCtx.routeTriggers.has(rt.container)) {
          triggerCtx.routeTriggers.set(rt.container, [])
        }
        triggerCtx.routeTriggers.get(rt.container)!.push(...rt.routes)
      }
      writes.push(...bundle.writes)
    }

    if (concepts.length === 0) return []

    // SQL defaults (lus hors-Salsa et passés en input)
    writes.push(...sqlDefaults)

    const valueToConcept = new Map<string, string>()
    for (const c of concepts) {
      for (const s of c.states) {
        if (!valueToConcept.has(s)) valueToConcept.set(s, c.name)
      }
    }

    return buildStateMachinesFromBundles(concepts, writes, triggerCtx, valueToConcept)
  },
)
