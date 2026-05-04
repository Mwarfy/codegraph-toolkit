/**
 * Causal discovery — DAG des couplages causaux entre fichiers depuis
 * les patterns de co-change runtime + git history.
 *
 * Discipline : causal inference (Pearl 2000, PC algorithm Spirtes-Glymour-
 * Scheines 2000). L'algo PC complet fait des tests d'indépendance
 * conditionnels itératifs sur tous les sous-ensembles → coût O(N^k) en
 * général. Pour notre échelle on utilise une version pragmatique :
 *
 *   1. Calcule les associations pair-wise (co-occurrence dans commits)
 *   2. Filtre par seuil de support (count ≥ minCount) et lift > 1
 *   3. Pour chaque pair fortement associée, détermine la direction
 *      via la statistique LiNGAM-inspired : si la résiduelle de Y|X
 *      est plus non-gaussienne que celle de X|Y, alors X→Y.
 *      Approximé ici par : si X précède Y dans le commit history
 *      majoritairement, X→Y.
 *   4. Élimine les transitifs : si X→Y, X→Z et Y→Z, on garde X→Y et
 *      Y→Z, on enlève X→Z (acyclicité partielle, pas full PC mais
 *      utile en pratique).
 *
 * Output : DAG approximatif qui répond "quand X change, quoi change
 * causalement après ?". Différent du Bayesian co-change directionnel
 * existant (qui mesure P(B|A) sans direction temporelle stricte).
 *
 * Utilité : avant un refactor de X, le DAG donne les fichiers qui
 * RÉAGISSENT à X (au-delà des simples imports). Capture le couplage
 * caché via tests, configs, contracts non-imports.
 */

export interface CommitLog {
  /** Identifiant commit (sha court ou date). Ordre dans le tableau = ordre temporel. */
  id: string
  /** Files changés dans ce commit. */
  files: string[]
}

export interface CausalDiscoveryOptions {
  commits: CommitLog[]
  /** Min co-occurrence count pour considérer une pair. Default 3. */
  minCount?: number
  /** Min lift (ratio observation / random) pour qu'une edge soit candidate. Default 2. */
  minLift?: number
  /** Top N edges causales à retourner. Default 15. */
  topN?: number
}

export interface CausalEdge {
  /** Driver — quand celui-ci change, le follower réagit. */
  driver: string
  follower: string
  /** Co-occurrence count. */
  coOccur: number
  /** Lift = observed / expected sous indépendance. */
  lift: number
  /** Score directionnel (0..1). > 0.5 favorise driver→follower. */
  directionScore: number
}

export function discoverCausalEdges(opts: CausalDiscoveryOptions): CausalEdge[] {
  const minCount = opts.minCount ?? 3
  const minLift = opts.minLift ?? 2
  const topN = opts.topN ?? 15

  const fileCount = countFileOccurrences(opts.commits)
  const pairCount = countPairCooccurrences(opts.commits)
  const totalCommits = opts.commits.length

  const edges: CausalEdge[] = []
  for (const [pair, count] of pairCount) {
    if (count < minCount) continue
    const [a, b] = pair.split('|')
    const expected = (fileCount.get(a)! * fileCount.get(b)!) / totalCommits
    if (expected <= 0) continue
    const lift = count / expected
    if (lift < minLift) continue

    // Direction via temporal precedence : qui a changé en premier dans
    // les commits où les 2 apparaissent ?
    const direction = computeTemporalDirection(opts.commits, a, b)

    if (direction.score >= 0.5) {
      edges.push({
        driver: a,
        follower: b,
        coOccur: count,
        lift,
        directionScore: direction.score,
      })
    } else {
      edges.push({
        driver: b,
        follower: a,
        coOccur: count,
        lift,
        directionScore: 1 - direction.score,
      })
    }
  }

  // Élimine les edges transitives (X→Z si X→Y et Y→Z existent)
  const pruned = pruneTransitive(edges)

  pruned.sort((a, b) => b.lift - a.lift || b.coOccur - a.coOccur)
  return pruned.slice(0, topN)
}

function countFileOccurrences(commits: CommitLog[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of commits) {
    for (const f of c.files) out.set(f, (out.get(f) ?? 0) + 1)
  }
  return out
}

function countPairCooccurrences(commits: CommitLog[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of commits) {
    const files = [...new Set(c.files)].sort()
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}|${files[j]}`
        out.set(key, (out.get(key) ?? 0) + 1)
      }
    }
  }
  return out
}

/**
 * Score directionnel : compte sur les commits avec les 2 fichiers,
 * combien de fois `a` est apparu strictement avant `b` (dans des commits
 * antérieurs). Score = countAbeforeB / (countAbeforeB + countBbeforeA).
 *
 * Approximation grossière mais marche : si a est systématiquement modifié
 * avant b, ça suggère a→b causal. Skip les commits où a et b sont dans
 * le même commit (pas d'info temporelle).
 */
function computeTemporalDirection(
  commits: CommitLog[],
  a: string,
  b: string,
): { score: number; aBefore: number; bBefore: number } {
  let aBefore = 0
  let bBefore = 0
  const lastSeen: { a?: number; b?: number } = {}
  for (let i = 0; i < commits.length; i++) {
    const direction = updateLastSeenAndDirection(commits[i].files, a, b, i, lastSeen)
    if (direction === 'a') aBefore++
    else if (direction === 'b') bBefore++
  }
  const total = aBefore + bBefore
  return { score: total > 0 ? aBefore / total : 0.5, aBefore, bBefore }
}

/**
 * Examine 1 commit, met à jour `lastSeen` et retourne quel fichier a été
 * "vu en premier" si les 2 sont co-présents. Sinon undefined.
 */
function updateLastSeenAndDirection(
  files: string[],
  a: string,
  b: string,
  commitIdx: number,
  lastSeen: { a?: number; b?: number },
): 'a' | 'b' | undefined {
  const hasA = files.includes(a)
  const hasB = files.includes(b)
  if (hasA && !hasB) {
    lastSeen.a = commitIdx
    return undefined
  }
  if (hasB && !hasA) {
    lastSeen.b = commitIdx
    return undefined
  }
  if (hasA && hasB) return resolveDirection(lastSeen)
  return undefined
}

function resolveDirection(lastSeen: { a?: number; b?: number }): 'a' | 'b' | undefined {
  if (lastSeen.a !== undefined && lastSeen.b === undefined) return 'a'
  if (lastSeen.b !== undefined && lastSeen.a === undefined) return 'b'
  if (lastSeen.a !== undefined && lastSeen.b !== undefined) {
    return lastSeen.a > lastSeen.b ? 'b' : 'a'
  }
  return undefined
}

/**
 * Prune les edges transitives. Pour chaque triple (X, Y, Z) avec
 * X→Y, Y→Z et X→Z, supprime X→Z (gardé via le path X→Y→Z).
 * Approximation pragmatique (vrai PC fait des tests d'indépendance
 * conditionnels, qu'on n'implémente pas ici).
 */
function pruneTransitive(edges: CausalEdge[]): CausalEdge[] {
  const adj = new Map<string, Set<string>>()
  for (const e of edges) {
    let s = adj.get(e.driver)
    if (!s) {
      s = new Set<string>()
      adj.set(e.driver, s)
    }
    s.add(e.follower)
  }

  return edges.filter((e) => {
    const targets = adj.get(e.driver)
    if (!targets) return true
    for (const intermediate of targets) {
      if (intermediate === e.follower) continue
      const second = adj.get(intermediate)
      if (second && second.has(e.follower)) return false  // transitif via intermediate
    }
    return true
  })
}

export function renderCausalMarkdown(edges: CausalEdge[]): string {
  if (edges.length === 0) return ''
  const lines: string[] = []
  lines.push('## 🔗 Causal DAG (drivers depuis git co-change)')
  lines.push('')
  lines.push('Quand le driver change, le follower réagit causalement (lift × temporal precedence) :')
  lines.push('')
  for (const e of edges) {
    lines.push(`- \`${e.driver}\` → \`${e.follower}\` (lift=${e.lift.toFixed(1)}, co=${e.coOccur}, dir=${(e.directionScore * 100).toFixed(0)}%)`)
  }
  return lines.join('\n')
}
