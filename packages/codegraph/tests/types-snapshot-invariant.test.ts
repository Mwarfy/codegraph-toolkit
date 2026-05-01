/**
 * Invariant : GraphSnapshot field set is monotonically additive.
 *
 * ADR-006 protège core/types.ts comme canonical contract — pas de
 * breaking change sans deprecation cycle. Ce test vérifie qu'un set
 * de champs documentés (la baseline figée à v0.2.0) reste TOUJOURS
 * présent dans le type GraphSnapshot. Si quelqu'un retire un champ,
 * le test pète et l'ADR-006 doit être revisitée (ou un cycle de
 * deprecation explicite engagé).
 *
 * On ajoute des champs (optionnels) au fur et à mesure — c'est OK et
 * pas testé ici. On ne RETIRE rien — c'est ce qui est testé.
 *
 * Si un consumer externe (Sentinel, codegraph-mcp, hooks bash) lit
 * `snapshot.X` et que X disparaît, ça retourne undefined silencieusement
 * → bug de prod difficile à attraper. C'est précisément le drift que
 * cet invariant verrouille.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
// Type-only import for test-coverage detector ('import' matching method).
// Le test lit aussi le file en texte (regex baseline check) mais cet
// import explicite signale au coverage extractor que ce file teste types.ts.
import type { GraphSnapshot } from '../src/core/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TYPES_FILE = path.resolve(__dirname, '../src/core/types.ts')

// Used only to anchor the type import (prevents tree-shake / unused warning).
type _Anchor = GraphSnapshot

/**
 * Baseline des champs publics de GraphSnapshot à v0.2.0 (post npm publish).
 * Aucun de ces champs ne peut être retiré sans deprecation cycle (cf.
 * ADR-006).
 *
 * Pour ajouter un nouveau champ : éditer types.ts seulement, ce test ne
 * doit PAS être modifié.
 *
 * Pour retirer/renommer un champ : éditer cette baseline aussi (avec
 * justification dans le commit message + cycle deprecation suivi).
 */
const REQUIRED_GRAPHSNAPSHOT_FIELDS = [
  // Core identity
  'version',
  'generatedAt',
  'rootDir',
  'nodes',
  'edges',
  'stats',
  // Optional fields documentés (chacun nullable mais doit exister dans l'interface)
  'commitHash',
  'commitMessage',
  'symbolRefs',
  'typedCalls',
  'cycles',
  'truthPoints',
  'dataFlows',
  'stateMachines',
  'envUsage',
  'moduleMetrics',
  'componentMetrics',
  'taintViolations',
  'dsm',
  'packageDeps',
  'barrels',
  'eventEmitSites',
  'oauthScopeLiterals',
  'todos',
  'longFunctions',
  'magicNumbers',
  'testCoverage',
] as const

describe('GraphSnapshot canonical contract (ADR-006)', () => {
  const source = readFileSync(TYPES_FILE, 'utf-8')

  // Extract the GraphSnapshot interface body (everything between
  // "export interface GraphSnapshot {" and the matching closing brace).
  const ifaceStart = source.indexOf('export interface GraphSnapshot {')
  expect(ifaceStart, 'GraphSnapshot interface declaration must exist').toBeGreaterThan(-1)

  // Naive brace matcher : find the closing brace that balances.
  let depth = 0
  let pos = ifaceStart + 'export interface GraphSnapshot {'.length - 1
  while (pos < source.length) {
    const c = source[pos]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) break
    }
    pos++
  }
  expect(pos, 'GraphSnapshot closing brace must be found').toBeGreaterThan(ifaceStart)

  const ifaceBody = source.slice(ifaceStart, pos + 1)

  it.each(REQUIRED_GRAPHSNAPSHOT_FIELDS)(
    'field %s exists in GraphSnapshot interface',
    (field) => {
      // Match `<field>?:` or `<field>:` at start of line (whitespace-tolerant)
      const re = new RegExp(`^\\s+${field}\\??\\s*:`, 'm')
      const found = re.test(ifaceBody)
      if (!found) {
        throw new Error(
          `Field "${field}" is missing from GraphSnapshot.\n` +
          `Per ADR-006, removing or renaming a documented field requires a deprecation cycle.\n` +
          `If this removal is intentional, update REQUIRED_GRAPHSNAPSHOT_FIELDS in this test\n` +
          `with justification in the commit message.`,
        )
      }
      expect(found).toBe(true)
    },
  )

  it('ADR-006 marker is present at top of types.ts', () => {
    const head = source.split('\n').slice(0, 5).join('\n')
    expect(head).toMatch(/\/\/\s*ADR-006/)
  })
})
