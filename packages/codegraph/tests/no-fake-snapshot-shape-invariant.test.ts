/**
 * Garde-fou anti-fake-type pour les consumers de `GraphSnapshot`.
 *
 * Audit dette architecturale 2026-05-12 §T1.2 (diff.ts) + §T2.2 (runtime
 * types). 3 routes dashboard-server (node.ts, tensions.ts, diff.ts)
 * avaient déclaré localement une `interface SnapshotShape` divergente
 * du vrai `GraphSnapshot`, causant ~10 bugs latents en prod (fields
 * inexistants → routes renvoyaient majoritairement vide). PRs #65, #66
 * + Phase 1.3 ont fixé les 3 cas par le pattern type-level :
 *
 *   ```ts
 *   import type { GraphSnapshot } from '@liby-tools/codegraph'
 *   interface NodeShape { id: string; ... }
 *   type _AssignNode = GraphSnapshot['nodes'][number] extends NodeShape ? true : never
 *   const _checkNode: _AssignNode = true   // pète à compile si drift
 *   ```
 *
 * Cet invariant interdit la régression :
 *
 *   1. **Bannir le nom historique `SnapshotShape`** dans les sources hors
 *      du package codegraph. Pas d'allowlist — la confusion sémantique
 *      est trop forte (consumer en mésuse vs. canonique).
 *   2. **Exiger un guard structurel** : tout fichier qui importe
 *      `GraphSnapshot` ET déclare des `interface .*Shape` doit aussi
 *      avoir au moins un `_Assign*` (= preuve d'adoption du pattern).
 *
 * Si ce test pète :
 *   - Renommer le `interface SnapshotShape` (= ne pas l'utiliser tout
 *     court)
 *   - Soit utiliser `GraphSnapshot` directement, soit déclarer des
 *     sub-shapes typés + assertions `_Assign*` (cf. node.ts comme modèle)
 *
 * Ne couvre PAS encore :
 *   - Les types fake nommés différemment (cf. T2.2 — `Runtime*Input` dans
 *     codegraph/incremental/runtime-relations.ts dupliquent runtime-graph).
 *     Sera traité en Tier 2 par une approche structurelle dédiée
 *     (extraction `@liby-tools/runtime-contract` ou inversion de dep).
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')

/**
 * Run git grep en mode PCRE (`-P`) — supporte `\s`, `\w`, `\b` que POSIX ERE
 * ne reconnaît pas. Retourne la liste des fichiers matchés.
 */
function gitGrepFiles(pattern: string, paths: string[]): string[] {
  const result = spawnSync('git', ['grep', '-lP', pattern, '--', ...paths], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
  if (result.status === 1) return [] // no match
  if (result.status !== 0) throw new Error(`git grep failed: ${result.stderr}`)
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

describe('No fake SnapshotShape : consumers utilisent GraphSnapshot via guard structurel', () => {
  it('aucun fichier ne déclare `interface SnapshotShape` hors du package codegraph', () => {
    const matches = gitGrepFiles(
      String.raw`^\s*(export\s+)?interface\s+SnapshotShape\b`,
      ['packages/'],
    ).filter((f) => !f.startsWith('packages/codegraph/'))

    if (matches.length > 0) {
      throw new Error(
        `Trouvé ${matches.length} fichier(s) qui déclarent \`interface SnapshotShape\` ` +
          `(nom historique d'un fake type — cf. audit T1.2):\n` +
          matches.map((f) => `  - ${f}`).join('\n') +
          `\n\nRemplacer par \`import type { GraphSnapshot } from '@liby-tools/codegraph'\` ` +
          `+ sub-shapes typés avec \`_Assign*\` guards. Modèle : ` +
          `packages/dashboard-server/src/routes/node.ts:31-107.`,
      )
    }
    expect(matches).toEqual([])
  })

  it('tout fichier consumer de GraphSnapshot avec des `interface *Shape` a au moins un guard `_Assign*`', () => {
    // 1. Fichiers consumer = ceux qui importent depuis @liby-tools/codegraph
    //    (n'importe quel subpath).
    const consumers = gitGrepFiles(
      String.raw`from\s+["']@liby-tools/codegraph`,
      ['packages/'],
    ).filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        !f.startsWith('packages/codegraph/'),
    )

    // 2. Parmi eux, ceux qui déclarent des `interface .*Shape`.
    const shapeDeclarers = gitGrepFiles(
      String.raw`^\s*(export\s+)?interface\s+\w+Shape\b`,
      ['packages/'],
    )
    const consumersWithShapes = consumers.filter((f) => shapeDeclarers.includes(f))

    // 3. Pour chacun, exiger au moins un `_Assign*\s*=`.
    const guardHavers = gitGrepFiles(
      String.raw`^\s*type\s+_Assign\w+\s*=`,
      ['packages/'],
    )

    const violations = consumersWithShapes.filter((f) => !guardHavers.includes(f))

    // Sanity : on connaît au moins 3 fichiers qui utilisent le pattern guardé
    // correctement (node.ts, tensions.ts, diff.ts post-Phase 1.3). Si zéro
    // est trouvé, le grep est cassé.
    expect(guardHavers.length, 'sanity : guard pattern présent dans le repo').toBeGreaterThanOrEqual(
      3,
    )

    if (violations.length > 0) {
      throw new Error(
        `Trouvé ${violations.length} consumer(s) de GraphSnapshot qui déclarent ` +
          `\`interface *Shape\` sans guard structurel \`_Assign*\`:\n` +
          violations.map((f) => `  - ${f}`).join('\n') +
          `\n\nAjouter au moins un \`type _AssignX = GraphSnapshot[...] extends XShape ? true : never\` ` +
          `+ \`const _checkX: _AssignX = true\` pour prouver structural compat à la compile. ` +
          `Modèle : packages/dashboard-server/src/routes/node.ts:90-107.`,
      )
    }
    expect(violations).toEqual([])
  })
})
