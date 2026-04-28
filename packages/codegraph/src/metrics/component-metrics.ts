/**
 * Component-level metrics — phase 3.7 #2.
 *
 * Calcule pour chaque composant (dossier) les métriques Martin :
 * Instability I = Ce/(Ca+Ce), Abstractness A = abstract/total, Distance
 * from Main Sequence D = |A+I−1|.
 *
 * Composant = préfixe path de profondeur configurable (default 3 segments,
 * i.e. `sentinel-core/src/kernel`).
 *
 * Abstract vs Concrete (heuristique déterministe sur les ExportSymbol kinds):
 *   - abstract: `interface`, `type`, `enum`
 *   - concrete: `class`, `function`, `const`, `variable`, `default`, `other`
 * Cette classification est plus permissive que la def originelle Java
 * (qui considère abstract = interface + abstract class). En TS `type` est
 * la forme canonique de contrat d'API — le traiter comme abstract est
 * plus aligné avec l'usage réel de la langue.
 */

import type { GraphEdge, GraphNode, ComponentMetrics, ExportSymbol } from '../core/types.js'

export interface ComponentMetricsOptions {
  /**
   * Nombre de segments de path formant un composant. Default 3 →
   * `sentinel-core/src/kernel`, `sentinel-web/src/hooks`, etc. Baisser à 2
   * élargit les groupes ; monter à 4 les resserre.
   */
  depth?: number
  /** Types d'edges comptés dans Ca/Ce. Default : `import` seulement. */
  edgeTypes?: Array<GraphEdge['type']>
  /**
   * Composants à exclure (match exact sur le nom). Utile pour sauter des
   * dossiers génériques (`tests`, `docs`, etc.). Default vide.
   */
  excludeComponents?: string[]
}

const ABSTRACT_KINDS = new Set<ExportSymbol['kind']>(['interface', 'type', 'enum'])

export function computeComponentMetrics(
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: ComponentMetricsOptions = {},
): ComponentMetrics[] {
  const depth = options.depth ?? 3
  const edgeTypes = new Set(options.edgeTypes ?? (['import'] as Array<GraphEdge['type']>))
  const exclude = new Set(options.excludeComponents ?? [])

  // ─── Assign each file to a component ───────────────────────────────

  const componentOf = (fileId: string): string | null => {
    const segs = fileId.split('/').filter(Boolean)
    if (segs.length === 0) return null
    // Si le fichier est à la racine d'un répertoire avec moins de `depth`
    // segments, on prend tout le path sauf le fichier (son dossier parent).
    const n = Math.min(depth, segs.length - 1)
    if (n <= 0) return segs[0]
    return segs.slice(0, n).join('/')
  }

  const fileToComponent = new Map<string, string>()
  const filesByComponent = new Map<string, GraphNode[]>()

  for (const n of nodes) {
    if (n.type !== 'file') continue
    const comp = componentOf(n.id)
    if (!comp || exclude.has(comp)) continue
    fileToComponent.set(n.id, comp)
    const list = filesByComponent.get(comp) ?? []
    list.push(n)
    filesByComponent.set(comp, list)
  }

  // ─── Count Ca / Ce per component ───────────────────────────────────

  const ca = new Map<string, number>()  // afferent coupling — external → internal
  const ce = new Map<string, number>()  // efferent coupling — internal → external

  // Dédup : la paire (file-from, file-to) ne compte qu'une fois par sens,
  // même si plusieurs edges existent entre les deux.
  const seenAfferent = new Set<string>()   // `compDst → fileSrc`
  const seenEfferent = new Set<string>()   // `compSrc → fileDst`

  for (const e of edges) {
    if (!edgeTypes.has(e.type)) continue
    if (e.from === e.to) continue
    const cFrom = fileToComponent.get(e.from)
    const cTo = fileToComponent.get(e.to)
    if (!cFrom || !cTo) continue
    if (cFrom === cTo) continue  // intra-component edge — ni Ca ni Ce

    const afferentKey = `${cTo}\u0000${e.from}`
    if (!seenAfferent.has(afferentKey)) {
      seenAfferent.add(afferentKey)
      ca.set(cTo, (ca.get(cTo) ?? 0) + 1)
    }
    const efferentKey = `${cFrom}\u0000${e.to}`
    if (!seenEfferent.has(efferentKey)) {
      seenEfferent.add(efferentKey)
      ce.set(cFrom, (ce.get(cFrom) ?? 0) + 1)
    }
  }

  // ─── Count abstract vs concrete exports per component ─────────────

  const totalExports = new Map<string, number>()
  const abstractExports = new Map<string, number>()

  for (const [comp, files] of filesByComponent) {
    let t = 0, a = 0
    for (const f of files) {
      if (!f.exports) continue
      for (const e of f.exports) {
        t++
        if (ABSTRACT_KINDS.has(e.kind)) a++
      }
    }
    totalExports.set(comp, t)
    abstractExports.set(comp, a)
  }

  // ─── Build output ──────────────────────────────────────────────────

  const out: ComponentMetrics[] = []
  for (const [comp, files] of filesByComponent) {
    const caVal = ca.get(comp) ?? 0
    const ceVal = ce.get(comp) ?? 0
    const totalE = totalExports.get(comp) ?? 0
    const abstractE = abstractExports.get(comp) ?? 0

    const I = caVal + ceVal === 0 ? 0 : ceVal / (caVal + ceVal)
    const A = totalE === 0 ? 0 : abstractE / totalE
    const D = Math.abs(A + I - 1)

    out.push({
      component: comp,
      fileCount: files.length,
      exportCount: totalE,
      ca: caVal,
      ce: ceVal,
      instability: Number(I.toFixed(4)),
      abstractness: Number(A.toFixed(4)),
      distance: Number(D.toFixed(4)),
    })
  }

  // Tri : distance desc (les plus problématiques en premier), puis nom asc.
  out.sort((a, b) => {
    if (a.distance !== b.distance) return b.distance - a.distance
    return a.component < b.component ? -1 : a.component > b.component ? 1 : 0
  })

  return out
}
