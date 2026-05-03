// ADR-005
/**
 * Co-change extractor — paires de fichiers fréquemment modifiés ensemble.
 *
 * Source : `git log --name-only` sur les N derniers jours. Pour chaque
 * commit, prend la liste des fichiers modifiés et compte les paires
 * `(a, b)` (avec a < b lexicographiquement pour dedupe). Filtre sur un
 * seuil minimum de co-modifications.
 *
 * Pourquoi : quand je touche `reporter.ts`, savoir que les 5 dernières
 * fois j'ai aussi touché `alert-system.ts` est un signal énorme (l'un
 * lit ce que l'autre écrit, c'est un truth-point ou une coupling
 * attendue mais non-codifiée). Le hook PostToolUse peut afficher cette
 * info.
 *
 * Cf. axe 2 du plan d'enrichissement (docs/ENRICHMENT-5-AXES-PLAN.md).
 */

import { execSync } from 'node:child_process'

export interface CoChangePair {
  /** Premier fichier (a < b lexico, dedupe). */
  from: string
  /** Second fichier (b > a lexico). */
  to: string
  /** Nombre de commits où les deux ont été modifiés ensemble. */
  count: number
  /** Nombre total de commits où `from` a été modifié (sur la window). */
  totalCommitsFrom: number
  /** Nombre total de commits où `to` a été modifié (sur la window). */
  totalCommitsTo: number
  /**
   * Coefficient de Jaccard : intersection / union des commit-sets.
   * Permet de dédupliquer les paires "tout le monde change tout le
   * temps" (count élevé mais Jaccard faible) des paires "ces deux-là
   * vont vraiment ensemble" (count élevé ET Jaccard élevé).
   */
  jaccard: number
}

export interface CoChangeOptions {
  /** Window git en jours. Défaut: 90. */
  sinceDays?: number
  /** Seuil minimum de co-modifications pour qu'une paire soit incluse. Défaut: 3. */
  minCount?: number
  /** Seuil minimum de Jaccard pour inclusion. Défaut: 0 (pas de filtre). */
  minJaccard?: number
  /**
   * Filtre les fichiers qui ne sont pas dans la liste passée (ex:
   * snapshot.nodes.filter(file).map(id) — on ne veut pas de paires
   * impliquant un fichier supprimé ou hors-projet). Si undefined, pas
   * de filtre.
   */
  knownFiles?: Set<string>
  /**
   * Cap sur le nombre de commits parsés. Défaut: 1000. Au-delà,
   * troncature pour éviter les explosions sur gros repos.
   */
  maxCommits?: number
  /**
   * Cap sur le nombre de fichiers par commit. Si un commit modifie
   * plus de N fichiers (ex: rename massif, lint pass, formatter), il
   * est skip (les paires seraient majoritairement du bruit). Défaut: 50.
   */
  maxFilesPerCommit?: number
}

export async function analyzeCoChange(
  rootDir: string,
  options: CoChangeOptions = {},
): Promise<CoChangePair[]> {
  const sinceDays = options.sinceDays ?? 90
  const minCount = options.minCount ?? 3
  const minJaccard = options.minJaccard ?? 0
  const maxCommits = options.maxCommits ?? 1000
  const maxFilesPerCommit = options.maxFilesPerCommit ?? 50
  const knownFiles = options.knownFiles

  // git log --name-only --pretty=format:'COMMIT' --since=Nd
  // Output : alternance entre 'COMMIT' lines + filenames jusqu'au COMMIT suivant.
  let raw: string
  try {
    raw = execSync(
      `git log --name-only --pretty=format:COMMIT --since=${sinceDays}.days -n ${maxCommits}`,
      { cwd: rootDir, encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 },
    )
  } catch {
    return [] // pas de repo git, ou git pas installé → silence
  }

  // Parse en commits (chaque commit = liste de fichiers).
  const commits: string[][] = []
  let currentFiles: string[] = []
  for (const line of raw.split('\n')) {
    if (line === 'COMMIT') {
      if (currentFiles.length > 0) commits.push(currentFiles)
      currentFiles = []
    } else if (line.length > 0) {
      currentFiles.push(line)
    }
  }
  if (currentFiles.length > 0) commits.push(currentFiles)

  // Compte par fichier + par paire.
  const fileCommitCount = new Map<string, number>()
  const pairCount = new Map<string, number>()

  for (const files of commits) {
    if (files.length > maxFilesPerCommit) continue // skip lint/rename massifs
    // KNOWNFILES SEMANTICS (fix bug #1) :
    // Avant : filter Strict — un commit ne contribue que si CHAQUE fichier
    // appartient à knownFiles. Casse les projets où les tests vivent dans
    // une extension non-incluse dans le glob (Hono : src/foo/foo.test.tsx
    // co-changent avec src/foo/foo.ts mais .tsx sont exclus du `src/**/*.ts`).
    //
    // Après : on garde TOUS les fichiers du commit, mais on n'émet une PAIR
    // que si AU MOINS UN des 2 côtés est dans knownFiles. Permet de capturer
    // les paires test↔source légitimes sans flooder avec des paires
    // README↔CHANGELOG entièrement hors projet.
    const sorted = [...new Set(files)].sort()
    if (sorted.length < 2) {
      for (const f of sorted) {
        if (!knownFiles || knownFiles.has(f)) {
          fileCommitCount.set(f, (fileCommitCount.get(f) ?? 0) + 1)
        }
      }
      continue
    }
    // Compte le commit pour chaque fichier (utile au denominator Jaccard).
    for (const f of sorted) {
      if (!knownFiles || knownFiles.has(f)) {
        fileCommitCount.set(f, (fileCommitCount.get(f) ?? 0) + 1)
      }
    }
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        // Pair acceptée si knownFiles est absent OU si au moins UN côté est tracké.
        if (knownFiles && !knownFiles.has(sorted[i]) && !knownFiles.has(sorted[j])) continue
        const key = sorted[i] + '\x00' + sorted[j]
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1)
      }
    }
  }

  // Construit les paires + filtre par seuils.
  const pairs: CoChangePair[] = []
  for (const [key, count] of pairCount) {
    if (count < minCount) continue
    const [from, to] = key.split('\x00')
    const totalCommitsFrom = fileCommitCount.get(from) ?? 0
    const totalCommitsTo = fileCommitCount.get(to) ?? 0
    const union = totalCommitsFrom + totalCommitsTo - count
    const jaccard = union > 0 ? count / union : 0
    if (jaccard < minJaccard) continue
    pairs.push({ from, to, count, totalCommitsFrom, totalCommitsTo, jaccard })
  }

  // Tri stable : count desc, jaccard desc, from asc, to asc.
  pairs.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count
    if (a.jaccard !== b.jaccard) return b.jaccard - a.jaccard
    if (a.from !== b.from) return a.from < b.from ? -1 : 1
    return a.to < b.to ? -1 : 1
  })

  return pairs
}
