// ADR-007
/**
 * Incremental deprecated-usage — 2-pass Salsa wrapper.
 *
 * Le détecteur deprecated-usage opère en 2 passes cross-fichier :
 *   - Pass 1 : collecter toutes les declarations `@deprecated`
 *   - Pass 2 : pour chaque fichier, scanner les call-sites qui matchent
 *              un symbole deprecated (depend de Pass 1 globale).
 *
 * Self-optim discovery : ce détecteur sortait #1 par p95 (882ms warm)
 * avec λ_lyap = 1.00 → preuve mathématique d'absence de cache. Le
 * pattern 2-pass + state global le rendait non-trivial à Salsa-iser.
 *
 * Décomposition Salsa (3 derived layers) :
 *   1. `declarationsOfFile(path)` — Pass 1 per-file, cached on fileContent.
 *   2. `globalDeprecatedNames(label)` — agrège all (1) en Set<string>.
 *   3. `sitesOfFile(path)` — Pass 2 per-file, dep sur fileContent(path)
 *      ET globalDeprecatedNames(label).
 *   4. `allDeprecatedUsage(label)` — agrégateur final tri lex.
 *
 * Cache behavior :
 *   - File X content change → declarationsOfFile[X] re-run, peut changer
 *     le global Set → invalide tous les sitesOfFile. declarationsOfFile[Y]
 *     pour Y≠X reste cached.
 *   - No content change → 100% cache hit (le cas warm).
 *
 * Gain attendu : ~870ms → ~5ms warm (cache hit), soit ~865ms par run.
 */

import { derived } from '@liby-tools/salsa'
import {
  extractDeprecatedUsageFileBundle,
  type DeprecatedDeclaration,
  type DeprecatedUsageSite,
} from '../extractors/deprecated-usage.js'
import { sharedDb as db } from './database.js'
import {
  fileContent,
  projectFiles,
  getIncrementalProject,
  getIncrementalRootDir,
} from './queries.js'
import * as path from 'node:path'

/** Pass 1 — per-file declarations. Cached on fileContent. */
export const declarationsOfFile = derived<string, DeprecatedDeclaration[]>(
  db,
  'declarationsOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    // Pass 1 mode : empty Set → skip Pass 2 work, only declarations returned.
    return extractDeprecatedUsageFileBundle(sf, filePath, new Set()).declarations
  },
)

/**
 * Global Set des deprecated names. Agrège toutes les declarations.
 * Re-run si N'IMPORTE QUEL declarationsOfFile change.
 */
export const globalDeprecatedNames = derived<string, Set<string>>(
  db,
  'globalDeprecatedNames',
  (label) => {
    const files = projectFiles.get(label)
    const names = new Set<string>()
    for (const f of files) {
      for (const d of declarationsOfFile.get(f)) {
        names.add(d.name)
        // Methods : indexer aussi par méthod name seul (call-sites = `obj.method`).
        const methodMatch = d.name.match(/\.([A-Za-z_][\w$]*)$/)
        if (methodMatch) names.add(methodMatch[1])
      }
    }
    return names
  },
)

/**
 * Pass 2 — per-file usage sites. Cache invalidé si fileContent change OU
 * si le global names change (ie. une declaration cross-fichier change).
 */
export const sitesOfFile = derived<string, DeprecatedUsageSite[]>(
  db,
  'sitesOfFile',
  (filePath) => {
    fileContent.get(filePath)
    const names = globalDeprecatedNames.get('all')                          // dep tracking
    if (names.size === 0) return []
    const project = getIncrementalProject()
    const rootDir = getIncrementalRootDir()
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)
    const sf = project.getSourceFile(absPath)
    if (!sf) return []
    return extractDeprecatedUsageFileBundle(sf, filePath, names).sites
  },
)

/** Final aggregator avec tri lex déterministe.
 *
 * Layered pour minimiser le coût de validation Salsa : si on dépend
 * directement de N×declarationsOfFile + N×sitesOfFile depuis le top,
 * chaque get('all') doit revérifier 1200 cells.
 *
 * Au lieu de ça, on group via 2 derived layers :
 *   - allDeprecatedDeclarations(label) : 1 cell, deps = projectFiles +
 *     N×declarationsOfFile. Validée 1 fois par run.
 *   - allDeprecatedSites(label) : 1 cell, deps = projectFiles +
 *     N×sitesOfFile. Validée 1 fois par run.
 *
 * Le top allDeprecatedUsage dépend SEULEMENT des 2 layers ci-dessus :
 * 2 cells à valider, pas 1200. Si les layers sont stables (cache hit),
 * top retourne en O(1).
 */
const allDeprecatedDeclarations = derived<string, DeprecatedDeclaration[]>(
  db,
  'allDeprecatedDeclarations',
  (label) => {
    const files = projectFiles.get(label)
    const out: DeprecatedDeclaration[] = []
    for (const f of files) out.push(...declarationsOfFile.get(f))
    return out
  },
)

const allDeprecatedSites = derived<string, DeprecatedUsageSite[]>(
  db,
  'allDeprecatedSites',
  (label) => {
    const files = projectFiles.get(label)
    const out: DeprecatedUsageSite[] = []
    for (const f of files) out.push(...sitesOfFile.get(f))
    return out
  },
)

export const allDeprecatedUsage = derived<
  string,
  { declarations: DeprecatedDeclaration[]; sites: DeprecatedUsageSite[] }
>(
  db,
  'allDeprecatedUsage',
  (label) => {
    const declarations = [...allDeprecatedDeclarations.get(label)]
    const sites = [...allDeprecatedSites.get(label)]
    const sortFn = (
      a: { file: string; line: number },
      b: { file: string; line: number },
    ) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line)
    declarations.sort(sortFn)
    sites.sort(sortFn)
    return { declarations, sites }
  },
)
