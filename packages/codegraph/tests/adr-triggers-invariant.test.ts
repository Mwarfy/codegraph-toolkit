/**
 * Garde-fou anti-phase-dormante.
 *
 * Audit dette architecturale 2026-05-12 §T3.2. ADR-031 et ADR-033 avaient
 * des phases marquées "(planned)" / "différé à N releases" sans trigger
 * observable. Pattern : "Phase X sera deprecated en v0.6 et retiré en v1.0"
 * → on est en v0.6.2 et rien n'a bougé.
 *
 * Sans trigger explicite (version, durée, métrique, événement), une phase
 * devient du backlog dormant — chaque release ajoute de l'inertie. Cet
 * invariant force chaque ADR avec phases planned à expliciter le
 * déclencheur, transformant le "à voir plus tard" en condition vérifiable.
 *
 * Règle :
 *   Tout ADR-NNN.md qui mentionne `(planned)`, `(différé)`, `(optionnel)`
 *   ou `Phase X planned` doit contenir un heading `## Triggers` ou
 *   `### Triggers` ailleurs dans le fichier.
 *
 * Si ce test pète :
 *   1. Soit ajouter une section `### Triggers` à l'ADR avec au moins UN
 *      trigger observable parmi version / durée / métrique / événement
 *      (cf. _TEMPLATE.md `## Triggers`).
 *   2. Soit retirer la phrase "planned" si la phase est en fait done
 *      (= updater le Status de l'ADR).
 *   3. Soit ajouter à ALLOWLIST avec justification.
 *
 * Hors scope :
 *   - Le CONTENU sémantique du trigger n'est pas validé (= un trigger
 *     vague type "à voir plus tard" passerait le test). La discipline
 *     reste humaine à la review.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const ADR_DIR = path.join(REPO_ROOT, 'docs/adr')

const ALLOWLIST: ReadonlySet<string> = new Set([
  // ADR-027 — Phases 2-4 du plan original ont été reprises par
  // ADR-030/031/032/033 qui les couvrent avec leurs propres triggers.
  // Note de supersession à formaliser dans une PR de suivi cleanup ADRs.
  '027-derived-views-out-of-git.md',
])

const PLANNED_PATTERNS = [
  /\(planned\b/i,
  /\(diff[ée]r[ée]\b/i,
  /\(optionnel\b/i,
  /\bPhase\s+\d+\s+planned\b/i,
]

const TRIGGER_HEADING = /^#{2,3}\s+Triggers\b/m

function listAdrFiles(): string[] {
  return fs
    .readdirSync(ADR_DIR)
    .filter((f) => /^\d{3}-.+\.md$/.test(f))
    .sort()
}

function hasPlannedPhase(content: string): boolean {
  return PLANNED_PATTERNS.some((re) => re.test(content))
}

function hasTriggersSection(content: string): boolean {
  return TRIGGER_HEADING.test(content)
}

describe('ADR Triggers : phases planned doivent expliciter leur déclencheur', () => {
  it('chaque ADR avec phases planned a une section `### Triggers`', () => {
    const violations: Array<{ file: string; first_match: string }> = []
    for (const file of listAdrFiles()) {
      if (ALLOWLIST.has(file)) continue
      const content = fs.readFileSync(path.join(ADR_DIR, file), 'utf-8')
      if (!hasPlannedPhase(content)) continue
      if (hasTriggersSection(content)) continue
      // Trouve la première phrase planned pour pointer le reviewer.
      const firstMatch = content
        .split('\n')
        .find((line) => PLANNED_PATTERNS.some((re) => re.test(line)))
      violations.push({ file, first_match: (firstMatch ?? '').trim().slice(0, 100) })
    }

    if (violations.length > 0) {
      throw new Error(
        `Trouvé ${violations.length} ADR(s) avec phases planned mais sans ` +
          `section \`### Triggers\`:\n` +
          violations
            .map((v) => `  - docs/adr/${v.file}\n      ↳ ${v.first_match}`)
            .join('\n') +
          `\n\nAjouter \`### Triggers\` avec au moins UN déclencheur observable ` +
          `(version, durée, métrique, événement) — cf. _TEMPLATE.md.`,
      )
    }
    expect(violations).toEqual([])
  })

  it('sanity : au moins 2 ADRs ont des Triggers (= test actif, pas tautologique)', () => {
    let count = 0
    for (const file of listAdrFiles()) {
      const content = fs.readFileSync(path.join(ADR_DIR, file), 'utf-8')
      if (hasTriggersSection(content)) count++
    }
    expect(count, 'au moins 2 ADRs avec Triggers (ADR-031 + ADR-033 post-Phase-1.5)').toBeGreaterThanOrEqual(2)
  })

  it('reporte l\'état actuel (informational)', () => {
    let planned = 0
    let withTriggers = 0
    for (const file of listAdrFiles()) {
      if (ALLOWLIST.has(file)) continue
      const content = fs.readFileSync(path.join(ADR_DIR, file), 'utf-8')
      if (hasPlannedPhase(content)) planned++
      if (hasTriggersSection(content)) withTriggers++
    }
    console.log(
      `\n[adr-triggers] ${withTriggers} ADR(s) ont une section Triggers, ` +
        `${planned} ADR(s) avec phases planned hors allowlist (${ALLOWLIST.size} allowlistés).`,
    )
    // spawnSync ici juste pour calmer ts/eslint sur l'import unused si on
    // ne l'utilise pas. On l'utilisera dans le futur pour git log mesures.
    void spawnSync
  })
})
