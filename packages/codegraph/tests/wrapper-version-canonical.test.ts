/**
 * Garde-fou anti-hardcode de la version du wrapper `snapshot.json`.
 *
 * Audit dette architecturale 2026-05-12 §T1.1 a montré que le hook
 * `codegraph-feedback-impl.mjs` checkait `parsed.version === 2` strict —
 * le bump à v3 (ADR-033 Phase 1) l'a cassé silencieusement. Même cascade
 * qu'ADR-027 P2 / ADR-032 §Why.
 *
 * Règle : seul `packages/codegraph/src/incremental/snapshot-loader.ts`
 * a le droit de comparer `.version === N` (= définit `WRAPPER_VERSIONS`
 * + `isWrappedSnapshot` + `unwrapSnapshot`). Tout autre consumer délègue.
 *
 * Bumper le wrapper (v3 → v4 ADR-033 Phase 4) demande de toucher UN
 * fichier (snapshot-loader.ts) tant que cet invariant tient.
 *
 * Si ce test pète :
 *   1. Soit le nouveau site veut détecter une version spécifique pour une
 *      raison légitime — exposer via le helper canonique
 *      (ex: `isWrapperV3Plus()`) et appeler depuis le call-site.
 *   2. Soit c'est un versioning intra-fichier non-wrapper (cf. fact-store
 *      compaction) — ajouter à l'allowlist avec justification.
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')

const ALLOWLIST = new Set<string>([
  // Helper canonique — définit WRAPPER_VERSIONS, isWrappedSnapshot,
  // unwrapSnapshot. Tout le hardcode (docstring + impl) vit ici.
  'packages/codegraph/src/incremental/snapshot-loader.ts',
  // Versioning intra-fichier du fact-store content-addressed (ADR-027 P3 /
  // ADR-028). Pattern différent du wrapper : 1 producer, 1 consumer, pas
  // de cascade cross-package. À unifier dans un Tier 2 séparé si on veut
  // standardiser TOUS les versionings .codegraph/*.
  'packages/codegraph/src/incremental/fact-store-compaction.ts',
])

const PATTERN = String.raw`\.version[[:space:]]*===[[:space:]]*[0-9]`

describe('Wrapper version : pas de hardcode hors helper canonique', () => {
  it('aucun fichier hors allowlist ne compare `.version === N` (T1.1 audit dette 2026-05-12)', () => {
    let raw = ''
    try {
      // `git grep -lE` retourne les FICHIERS qui matchent — plus rapide
      // qu'un walk JS, déterministe (= ne traverse pas dist/node_modules).
      raw = execSync(
        `git grep -lE '${PATTERN}' -- 'packages/**/*.ts' 'packages/**/*.mjs' 'packages/**/*.js' 'scripts/**/*.ts' 'scripts/**/*.mjs' 'scripts/**/*.js'`,
        { cwd: REPO_ROOT, encoding: 'utf-8' },
      )
    } catch (err) {
      // git grep retourne exit 1 si AUCUN match — c'est l'état souhaité.
      const e = err as { status?: number; stdout?: string }
      if (e.status === 1) return
      throw err
    }

    const offenders = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((f) => !f.includes('/dist/'))
      .filter((f) => !f.includes('/node_modules/'))
      .filter((f) => !f.endsWith('.test.ts'))
      .filter((f) => !f.endsWith('.test.mjs'))
      .filter((f) => !ALLOWLIST.has(f))

    if (offenders.length > 0) {
      throw new Error(
        `Trouvé ${offenders.length} fichier(s) qui hardcodent \`.version === N\` ` +
          `hors du helper canonique:\n` +
          offenders.map((f) => `  - ${f}`).join('\n') +
          `\n\nDéléguer à \`unwrapSnapshot()\` ou \`isWrappedSnapshot()\` ` +
          `(packages/codegraph/src/incremental/snapshot-loader.ts), ou ` +
          `ajouter à l'allowlist avec justification.`,
      )
    }
    expect(offenders).toEqual([])
  })
})
