/**
 * Canonical encoding helpers — tout ce qui touche au déterminisme passe ici.
 *
 * Invariants :
 *   - Une même paire (rel, tuple) produit TOUJOURS la même `tupleKey`.
 *   - `compareTuples` est une relation totale, transitive, stable. Trie
 *     d'abord par taille (impossible si arity égal mais on garde en filet),
 *     puis colonne par colonne avec ordre `number < string` et lex JS
 *     standard sur les strings.
 *   - `tupleHash` = sha256 tronqué (16 hex). Identifiant content-addressable
 *     stable entre runs / machines.
 *
 * Aucune dépendance externe : `node:crypto` est natif.
 */

import { createHash } from 'node:crypto'
import type { DatalogValue, Tuple } from './types.js'

// ─── Encoding ───────────────────────────────────────────────────────────────

/**
 * Sérialisation canonique d'une valeur : `s:<string>` ou `n:<number>`.
 * Le préfixe distingue `"42"` (string) de `42` (number) — sinon on perdrait
 * l'identité au hashing. Pas de JSON.stringify : on veut une forme que des
 * humains peuvent lire dans les traces.
 *
 * NaN / Infinity / -0 ne peuvent pas survenir (interdits au load) mais on
 * normalise tout de même -0 → 0 par filet de sécurité.
 */
export function encodeValue(v: DatalogValue): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`encodeValue: non-finite number rejected (${v})`)
    }
    if (Object.is(v, -0)) return 'n:0'
    return 'n:' + v.toString(10)
  }
  return 's:' + v
}

/**
 * Clé canonique d'un tuple dans une relation. \x00 est un séparateur safe
 * — interdit dans les facts (le loader rejette les caractères de contrôle).
 */
export function tupleKey(rel: string, tuple: Tuple): string {
  return rel + '\x00' + tuple.map(encodeValue).join('\x00')
}

/** Hash stable d'un tuple. 16 hex chars = 64 bits, collision négligeable. */
export function tupleHash(rel: string, tuple: Tuple): string {
  return createHash('sha256').update(tupleKey(rel, tuple)).digest('hex').slice(0, 16)
}

// ─── Sorting ────────────────────────────────────────────────────────────────

/**
 * Comparateur total + stable pour tuples. number < string. Au sein d'un
 * type, ordre naturel (`<`/`>` pour number, lex JS pour string).
 *
 * Stabilité : si tous les éléments sont égaux ET la longueur est égale,
 * retourne 0 — Array.prototype.sort en ES2019+ est stable, donc l'ordre
 * d'origine est préservé.
 */
export function compareTuples(a: Tuple, b: Tuple): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const c = compareValues(a[i], b[i])
    if (c !== 0) return c
  }
  return a.length - b.length
}

export function compareValues(a: DatalogValue, b: DatalogValue): number {
  const ta = typeof a
  const tb = typeof b
  if (ta !== tb) {
    // number < string. Convention arbitraire mais stable.
    return ta === 'number' ? -1 : 1
  }
  if (ta === 'number') {
    return (a as number) - (b as number)
  }
  // string lex
  const sa = a as string
  const sb = b as string
  if (sa < sb) return -1
  if (sa > sb) return 1
  return 0
}

/**
 * Retourne une copie triée stable. Ne mute pas l'input.
 */
export function sortTuples(tuples: readonly Tuple[]): Tuple[] {
  return [...tuples].sort(compareTuples)
}
