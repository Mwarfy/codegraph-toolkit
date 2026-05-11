/**
 * Invariant : GraphSnapshot field set is monotonically additive.
 *
 * ADR-006 (superseded par ADR-030) protégeait core/types.ts comme
 * canonical contract — pas de breaking change sans deprecation cycle.
 * ADR-030 reformule : le contrat externe est le JSON sérialisé, pas
 * la shape TS. Mais le set de champs documentés (la baseline figée
 * à v0.2.0) reste un invariant : un consumer externe qui lit
 * `snapshot.X` doit toujours trouver X.
 *
 * Depuis ADR-033 (split GraphCore + DetectorOutputs + SnapshotMetrics),
 * les champs sont répartis entre les 3 sous-interfaces. `GraphSnapshot`
 * = intersection. Ce test concatène les 3 bodies pour valider la
 * présence de chaque champ baseline.
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

/**
 * Extrait le body d'une interface depuis le source (entre `{` et le `}`
 * équilibré). Retourne `''` si l'interface est absente.
 */
function extractInterfaceBody(source: string, interfaceName: string): string {
  const marker = `export interface ${interfaceName} {`
  const start = source.indexOf(marker)
  if (start === -1) return ''
  let depth = 0
  let pos = start + marker.length - 1
  while (pos < source.length) {
    const c = source[pos]
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) break
    }
    pos++
  }
  return source.slice(start, pos + 1)
}

describe('GraphSnapshot canonical contract (ADR-030, supersedes ADR-006)', () => {
  const source = readFileSync(TYPES_FILE, 'utf-8')

  // Depuis ADR-033, les champs sont répartis entre 3 sous-interfaces.
  // GraphSnapshot lui-même est `extends GraphCore, DetectorOutputs,
  // SnapshotMetrics {}` (body vide). On concatène les 3 bodies pour
  // valider la présence de chaque champ baseline.
  const coreBody = extractInterfaceBody(source, 'GraphCore')
  const detectorBody = extractInterfaceBody(source, 'DetectorOutputs')
  const metricsBody = extractInterfaceBody(source, 'SnapshotMetrics')
  expect(coreBody.length, 'GraphCore interface must exist').toBeGreaterThan(0)
  expect(detectorBody.length, 'DetectorOutputs interface must exist').toBeGreaterThan(0)
  expect(metricsBody.length, 'SnapshotMetrics interface must exist').toBeGreaterThan(0)

  // Verifie aussi que GraphSnapshot existe comme intersection des trois.
  // Match tolerant : `extends GraphCore, DetectorOutputs, SnapshotMetrics`
  // (ordre libre, espaces libres).
  const graphSnapshotDecl = /export interface GraphSnapshot\s+extends\s+([\w\s,]+)\s*\{/.exec(source)
  expect(graphSnapshotDecl, 'GraphSnapshot must extend the three sub-interfaces').not.toBeNull()
  const extendedNames = (graphSnapshotDecl?.[1] ?? '').split(',').map((s) => s.trim()).sort()
  expect(extendedNames).toEqual(['DetectorOutputs', 'GraphCore', 'SnapshotMetrics'])

  const concatenatedBody = coreBody + '\n' + detectorBody + '\n' + metricsBody

  it.each(REQUIRED_GRAPHSNAPSHOT_FIELDS)(
    'field %s exists in one of GraphCore | DetectorOutputs | SnapshotMetrics',
    (field) => {
      // Match `<field>?:` or `<field>:` at start of line (whitespace-tolerant)
      const re = new RegExp(`^\\s+${field}\\??\\s*:`, 'm')
      const found = re.test(concatenatedBody)
      if (!found) {
        throw new Error(
          `Field "${field}" is missing from GraphCore | DetectorOutputs | SnapshotMetrics.\n` +
          `Per ADR-030 (supersedes ADR-006), removing or renaming a documented field\n` +
          `requires a deprecation cycle. If this removal is intentional, update\n` +
          `REQUIRED_GRAPHSNAPSHOT_FIELDS in this test with justification in the commit message.`,
        )
      }
      expect(found).toBe(true)
    },
  )

  it('ADR-030 marker is present at top of types.ts (supersedes ADR-006)', () => {
    const head = source.split('\n').slice(0, 5).join('\n')
    // ADR-006 reste accepté pour back-compat avec les anciens snapshots ;
    // ADR-030 est la valeur attendue post-refactor.
    expect(head).toMatch(/\/\/\s*ADR-(006|030)/)
  })
})
