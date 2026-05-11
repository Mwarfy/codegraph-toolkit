/**
 * Garde-fou générique cross-package coverage (ADR-032 généralisé).
 *
 * ADR-032 a posé le pattern : tout consumer cross-package du workspace
 * doit avoir un `tests/cross-package-<dep>.test.ts` qui smoke-test les
 * exports utilisés en prod. Sans ça, le upstream peut retirer/renommer
 * un export et casser le downstream en cascade silencieuse (cf. cascade
 * P2 ADR-027 — 8 fichiers cassés post-merge).
 *
 * Au 2026-05-11, 3 packages avaient ce test (adr-toolkit, codegraph-mcp,
 * dashboard-server, vers codegraph seulement). Audit dette 2026-05-12
 * §T1.3/§T1.4 a identifié les gaps : codegraph-mcp→datalog,
 * runtime-graph→codegraph, runtime-graph→datalog.
 *
 * Ce test invariant :
 *   1. Liste les imports `@liby-tools/<dep>` réels (non commentés) dans
 *      chaque `packages/<consumer>/src/`
 *   2. Pour chaque combo (consumer, dep) où consumer ≠ dep, exige
 *      l'existence de `packages/<consumer>/tests/cross-package-<dep>.test.ts`
 *   3. Allowlist explicite pour les combos non encore couverts (= TODO
 *      Tier 2). Vider l'allowlist au fur et à mesure.
 *
 * Si ce test pète à l'ajout d'un nouvel import :
 *   - Soit créer le test cross-package manquant (modèle :
 *     `packages/codegraph-mcp/tests/cross-package-codegraph.test.ts`)
 *   - Soit ajouter à l'allowlist avec justification + ticket de suivi
 *
 * Pattern reconnu dans `from '@liby-tools/X'` + `import('@liby-tools/X')`
 * + `require('@liby-tools/X')`. Sous-paths comme `@liby-tools/X/foo`
 * comptent comme `X`.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')

interface CrossPackageEdge {
  consumer: string
  dep: string
}

const ALLOWLIST: ReadonlySet<string> = new Set([
  // codegraph est le main producer + consume datalog/salsa de manière intensive
  // via les detectors internes. Tier 2 audit dette §T1.3 généralisé — à
  // couvrir dans une PR de suivi qui fait codegraph→datalog + codegraph→salsa.
  // Le risque actuel est modéré : codegraph est mergé via le même workspace
  // que ses deps, donc une rupture du contrat se voit au build TS.
  'codegraph→datalog',
  'codegraph→salsa',
])

function listConsumerPackages(): string[] {
  const pkgsDir = path.join(REPO_ROOT, 'packages')
  return fs
    .readdirSync(pkgsDir)
    .filter((name) => {
      const p = path.join(pkgsDir, name, 'src')
      return fs.existsSync(p)
    })
}

function extractCrossPackageImports(consumer: string): Set<string> {
  // Pattern : `from '@liby-tools/X'`, `import('@liby-tools/X')`,
  // `require('@liby-tools/X')`. Filtre comments (lignes qui commencent
  // par `//` ou ` *`).
  // spawnSync sans shell : évite les conflits de quoting pour le pattern
  // qui contient à la fois `"` et `'` (la regex matche les deux styles).
  const pattern = String.raw`(from|import\(|require\()[[:space:]]*["']@liby-tools/[a-z][a-z0-9-]*`
  const result = spawnSync(
    'git',
    ['grep', '-hE', pattern, `packages/${consumer}/src/`],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  )
  if (result.status === 1) return new Set() // git grep : pas de match
  if (result.status !== 0) {
    throw new Error(`git grep failed for ${consumer}: ${result.stderr}`)
  }
  const raw = result.stdout

  const deps = new Set<string>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    // Skip commented lines defensively (git grep -E ne filtre pas les
    // comments, et la regex matche aussi les JSDoc avec `* @liby-tools/X`).
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
    const match = trimmed.match(/@liby-tools\/([a-z][a-z0-9-]*)/)
    if (match && match[1] !== consumer) deps.add(match[1])
  }
  return deps
}

function buildCoverageMap(): { edges: CrossPackageEdge[]; missing: CrossPackageEdge[] } {
  const edges: CrossPackageEdge[] = []
  const missing: CrossPackageEdge[] = []
  for (const consumer of listConsumerPackages()) {
    const deps = extractCrossPackageImports(consumer)
    for (const dep of deps) {
      const edge: CrossPackageEdge = { consumer, dep }
      edges.push(edge)
      const testFile = path.join(
        REPO_ROOT,
        'packages',
        consumer,
        'tests',
        `cross-package-${dep}.test.ts`,
      )
      if (!fs.existsSync(testFile)) missing.push(edge)
    }
  }
  return { edges, missing }
}

describe('Cross-package coverage : ADR-032 généralisé (audit dette §T1.3/§T1.4)', () => {
  it('chaque consumer cross-package a un test cross-package-<dep>.test.ts', () => {
    const { edges, missing } = buildCoverageMap()

    // Sanity : au moins 5 edges détectés (= on a bien scanné, pas un faux 0).
    expect(edges.length).toBeGreaterThanOrEqual(5)

    const unallowed = missing.filter(
      (e) => !ALLOWLIST.has(`${e.consumer}→${e.dep}`),
    )

    if (unallowed.length > 0) {
      const list = unallowed
        .map((e) => `  - packages/${e.consumer}/tests/cross-package-${e.dep}.test.ts`)
        .join('\n')
      throw new Error(
        `Trouvé ${unallowed.length} consumer(s) cross-package sans test:\n${list}\n\n` +
          `Créer le smoke test (modèle : ` +
          `packages/codegraph-mcp/tests/cross-package-codegraph.test.ts), ` +
          `OU ajouter à ALLOWLIST avec justification.`,
      )
    }
    expect(unallowed).toEqual([])
  })

  it('reporte la coverage actuelle (informational)', () => {
    const { edges, missing } = buildCoverageMap()
    const covered = edges.length - missing.length
    const ratio = edges.length > 0 ? covered / edges.length : 1
    console.log(
      `\n[cross-package coverage] ${covered}/${edges.length} edges covered ` +
        `(${(ratio * 100).toFixed(0)}%) — ${ALLOWLIST.size} edge(s) allowlisted`,
    )
    // Sanity check seulement : au moins UN edge couvert (= on ne tombe pas
    // dans un état dégénéré où tout est allowlisted). La vraie validation
    // est faite par le 1er test ci-dessus.
    expect(covered).toBeGreaterThanOrEqual(1)
  })
})
