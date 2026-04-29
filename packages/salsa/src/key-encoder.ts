/**
 * Key encoding — transforme un `QueryKey` en `EncodedKey` (string) stable.
 *
 * Cible : deux appels avec des keys "structurellement égales" produisent la
 * même string et donc trouvent la même Cell.
 *
 * Stratégie :
 *   - string  → "s\x00<value>"
 *   - number  → "n\x00<value>"
 *   - tuple   → "t\x00<encode(item0)>\x01<encode(item1)>..."
 *
 * Le préfixe par type empêche les collisions (`"42"` ≠ 42 ≠ ["42"]).
 * \x00 et \x01 sont safe : interdits dans les keys (validés au call site
 * via le type system).
 *
 * Décision explicite : pas de JSON.stringify. Des keys différentes peuvent
 * sérialiser pareil en JSON (objets avec ordre de propriétés différent),
 * et la perf de JSON.stringify > 100ns/call s'accumule.
 */

import type { EncodedKey, QueryKey } from './types.js'
import { SalsaError } from './types.js'

export function encodeKey(key: QueryKey): EncodedKey {
  if (typeof key === 'string') return 's\x00' + key
  if (typeof key === 'number') {
    if (!Number.isFinite(key)) {
      throw new SalsaError('key.notFinite',
        `query key cannot be NaN or Infinity (got ${key})`)
    }
    return 'n\x00' + key.toString(10)
  }
  if (Array.isArray(key)) {
    const parts: string[] = ['t']
    for (const item of key) {
      parts.push(encodeKey(item))
    }
    return parts.join('\x01')
  }
  throw new SalsaError('key.invalidType',
    `query key must be string, number, or tuple of those (got ${typeof key})`)
}
