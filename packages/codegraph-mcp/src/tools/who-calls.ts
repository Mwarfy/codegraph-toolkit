/**
 * codegraph_who_calls(symbol) — call sites d'un symbole avec types
 * contractuels au site d'appel.
 *
 * Source : `snapshot.typedCalls.callEdges`. Complémentaire à
 * `lsp_find_references` (qui donne le compile-time syntax-level), ici
 * on a les types observés au site d'appel — utile pour comprendre le
 * contrat de fait vs le contrat déclaré.
 *
 * Cf. axe 1 du plan d'enrichissement (docs/ENRICHMENT-5-AXES-PLAN.md).
 */

import { loadSnapshot } from '../snapshot-loader.js'

export interface WhoCallsArgs {
  /**
   * Identifiant du symbole. Deux formats acceptés :
   *   - `file:symbolName` (ex `sentinel-core/src/foo.ts:bar`) — match exact
   *   - `symbolName` seul (ex `bar`) — match sur tout `*:bar` (peut renvoyer
   *     des résultats de plusieurs fichiers, utile pour les noms uniques)
   */
  symbol: string
  repo_root?: string
  /** Top-N call sites. Default 20. */
  limit?: number
}

export function codegraphWhoCalls(args: WhoCallsArgs): { content: string } {
  const repoRoot = args.repo_root ?? process.cwd()
  const limit = args.limit ?? 20
  const snapshot = loadSnapshot(repoRoot)

  type CallEdge = {
    from: string
    to: string
    argTypes: string[]
    returnType: string
    line: number
  }
  const callEdges: CallEdge[] = snapshot.typedCalls?.callEdges ?? []
  if (callEdges.length === 0) {
    return {
      content:
        'No typedCalls in snapshot. Run `npx codegraph analyze` (typed-calls ' +
        'detector enabled by default).',
    }
  }

  const symbol = args.symbol
  const isFullId = symbol.includes(':')

  const allMatches = callEdges
    .filter((e) => isFullId ? e.to === symbol : e.to.endsWith(':' + symbol))
  const matches = allMatches.slice(0, limit)

  if (matches.length === 0) {
    const hint = isFullId
      ? `No callers found for '${symbol}'. Try without the file prefix or check it's exported.`
      : `No callers found for '${symbol}'. Try the full 'file:symbol' form, or use lsp_find_references.`
    return { content: hint }
  }

  const lines: string[] = []
  lines.push(`📞 Callers of ${symbol} (top ${limit}, source: typedCalls.callEdges):`)
  lines.push('')
  for (const e of matches) {
    lines.push(`  ${e.from}:${e.line}`)
    if (e.argTypes.length > 0) {
      const argsShort = e.argTypes.map((t) => shortenType(t)).join(', ')
      lines.push(`    args: (${argsShort})`)
    }
    if (e.returnType) {
      lines.push(`    → returns: ${shortenType(e.returnType)}`)
    }
  }
  if (allMatches.length > limit) {
    lines.push('')
    lines.push(`  ... +${allMatches.length - limit} more (raise limit?)`)
  }
  lines.push('')
  lines.push(
    'Note: argTypes are observed at the call site (the actual type passed), ' +
    'not the declared signature. Compare with lsp_hover for the contract.',
  )

  return { content: lines.join('\n') }
}

/**
 * Raccourcit un type long pour l'affichage. Les types ts-morph résolvent
 * souvent en chemins absolus `import("/abs/path/node_modules/foo").BarType`
 * — on garde la fin lisible.
 */
function shortenType(t: string): string {
  // Replace `import("...")` with `import(...)` (just the basename of the module)
  const cleaned = t.replace(/import\("([^"]+)"\)/g, (_, p) => {
    const parts = p.split('/')
    const idx = parts.indexOf('node_modules')
    if (idx >= 0 && idx + 1 < parts.length) return `import(${parts[idx + 1]})`
    return `import(${parts[parts.length - 1]})`
  })
  if (cleaned.length > 200) return cleaned.slice(0, 197) + '...'
  return cleaned
}
