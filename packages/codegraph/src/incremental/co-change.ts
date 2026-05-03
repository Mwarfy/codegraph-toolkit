// ADR-007
/**
 * Incremental co-change — Salsa wrapper autour de `analyzeCoChangeSync`.
 *
 * Self-optim discovery : co-change sortait #1 hot warm (mean=282ms,
 * λ_lyap=1.00). Cas particulier : la source N'EST PAS le filesystem
 * source, c'est `git log` sur les 90 derniers jours. Donc le keying
 * Salsa diffère du pattern per-file standard.
 *
 * Inputs Salsa :
 *   - `coChangeGitHeadInput('all')` : SHA du HEAD courant. Set par
 *     `analyze()` au boot. Tant que HEAD ne bouge pas, le résultat est
 *     valide. Bump par commit suivant.
 *   - `coChangeKnownFilesInput('all')` : array trié des file ids du
 *     snapshot. Set via setInputIfChanged → si les fichiers connus
 *     n'ont pas changé entre runs, pas de bump.
 *
 * Sémantique cache :
 *   - Cold (1er run) : full work (~282ms).
 *   - Warm (HEAD identique, knownFiles identique) : skip total.
 *   - HEAD bump : invalide → recompute (rare en dev workflow).
 */

import { derived, input } from '@liby-tools/salsa'
import {
  analyzeCoChangeSync,
  type CoChangePair,
} from '../extractors/co-change.js'
import { sharedDb as db } from './database.js'
import { getIncrementalRootDir } from './queries.js'

/** Git HEAD courant (SHA). Set par analyze() avant le get du derived. */
export const coChangeGitHeadInput = input<'all', string>(db, 'coChangeGitHead')

/**
 * Liste triée des fichiers connus du snapshot. Permet de filtrer les
 * paires hors-projet sans re-invalider la cache si la liste est stable.
 */
export const coChangeKnownFilesInput = input<'all', readonly string[]>(db, 'coChangeKnownFiles')

/**
 * Aggregator co-change — résultat unique pour le projet, keyed sur
 * (gitHead, knownFiles). Salsa skip recompute si les deux inputs sont
 * stables entre runs (dep tracking via setInputIfChanged côté
 * analyzer.ts).
 */
export const allCoChangePairs = derived<string, CoChangePair[]>(
  db,
  'allCoChangePairs',
  (_label) => {
    coChangeGitHeadInput.get('all')                                        // dep tracking
    const knownFilesArr = coChangeKnownFilesInput.get('all')
    const rootDir = getIncrementalRootDir()
    const knownFiles = new Set(knownFilesArr)
    return analyzeCoChangeSync(rootDir, { knownFiles })
  },
)
