/**
 * Capture diagnostique pour les tests de déterminisme E2E
 * (`analyze-determinism-e2e`, `facts-determinism-e2e`).
 *
 * Contexte : une flakiness intermittente a été observée sur ces tests
 * (`factSetHash` / snapshot byte-equivalence divergent ~1 run sur 3 dans la
 * suite complète), mais elle s'est révélée NON reproductible en local malgré
 * une investigation poussée (isolation, parallèle, charge CPU saturante, 9
 * suites complètes). Cause probable : pression mémoire/GC sous la suite
 * complète (104 forks vitest) affectant un cache interne (piste ts-morph) —
 * non confirmée faute de repro.
 *
 * Plutôt que deviner un fix, ces helpers capturent la root cause À LA PROCHAINE
 * OCCURRENCE (en CI notamment) : sur divergence, ils écrivent les champs/tuples
 * exacts qui diffèrent (stderr + artefact JSON) AVANT que l'assertion n'échoue.
 * Ils n'altèrent pas ce qui est testé — purement observationnels.
 *
 * Ce fichier n'est pas un `*.test.ts` : il n'est pas collecté par vitest.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Hash canonique : clés d'objets triées (les arrays gardent leur ordre). */
export function hashCanonical(value: unknown): string {
  const json = JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k]
      }
      return sorted
    }
    return v
  })
  return createHash('sha256').update(json).digest('hex')
}

function sample(v: unknown): unknown {
  if (Array.isArray(v)) return { __array: true, length: v.length, first3: v.slice(0, 3) }
  return v
}

function writeReport(label: string, report: unknown, summary: string): void {
  const dir = process.env.DETERMINISM_DUMP_DIR ?? path.join(process.cwd(), '.codegraph', 'determinism-failures')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${label}-${Date.now()}.json`)
    fs.writeFileSync(file, JSON.stringify(report, null, 2))
    console.error(`[determinism] DIVERGENCE (${label}) — ${summary} → ${file}`)
  } catch (e) {
    console.error(`[determinism] DIVERGENCE (${label}) — ${summary} (dump échoué: ${(e as Error).message})`)
  }
}

/**
 * Compare deux objets (typiquement deux snapshots strippés) champ par champ.
 * Si divergence, dumpe les champs concernés + un échantillon. No-op sinon.
 */
export function captureSnapshotDivergence(
  label: string,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): void {
  const detail: Record<string, { a: unknown; b: unknown }> = {}
  for (const k of Object.keys(a)) {
    if (hashCanonical(a[k]) !== hashCanonical(b[k])) {
      detail[k] = { a: sample(a[k]), b: sample(b[k]) }
    }
  }
  const fields = Object.keys(detail)
  if (fields.length === 0) return
  writeReport(label, { label, divergentFields: fields, detail, capturedAt: new Date().toISOString() }, `champs: ${fields.join(', ')}`)
}

/**
 * Compare deux ensembles de fact records (issus de `buildFactsHead().records`).
 * Si le set de fact_id diffère, dumpe les tuples présents d'un seul côté
 * (groupés par relation) pour pointer l'extracteur fautif. No-op sinon.
 */
export function captureFactsDivergence(
  label: string,
  records1: { id: string; r: string; v: unknown }[],
  records2: { id: string; r: string; v: unknown }[],
  // Contexte optionnel pour distinguer la SOURCE de divergence (cf. invest.
  // 2026-06-09) : ts-morph traversal RÉFUTÉ (stable), suspect = pipeline.
  // `files` permet de voir si la découverte diffère ; `counts` si l'extraction
  // par-relation diffère même à fichiers identiques.
  context?: {
    files1?: readonly string[]
    files2?: readonly string[]
    counts1?: Record<string, number>
    counts2?: Record<string, number>
  },
): void {
  const ids1 = new Set(records1.map((r) => r.id))
  const ids2 = new Set(records2.map((r) => r.id))
  const onlyIn1 = records1.filter((r) => !ids2.has(r.id)).map((r) => ({ r: r.r, v: r.v }))
  const onlyIn2 = records2.filter((r) => !ids1.has(r.id)).map((r) => ({ r: r.r, v: r.v }))
  if (onlyIn1.length === 0 && onlyIn2.length === 0) return
  const relations = [...new Set([...onlyIn1, ...onlyIn2].map((x) => x.r))]
  // Diagnostic clé : les fichiers découverts sont-ils identiques entre les 2 runs ?
  const sameFiles = context
    ? JSON.stringify([...(context.files1 ?? [])].sort()) === JSON.stringify([...(context.files2 ?? [])].sort())
    : undefined
  writeReport(
    label,
    {
      label,
      divergentRelations: relations,
      onlyIn1,
      onlyIn2,
      // sameFiles=true → divergence d'EXTRACTION (mêmes fichiers, facts ≠).
      // sameFiles=false → divergence de DÉCOUVERTE (un run voit moins de fichiers).
      sameFiles,
      files1: context?.files1,
      files2: context?.files2,
      counts1: context?.counts1,
      counts2: context?.counts2,
      capturedAt: new Date().toISOString(),
    },
    `relations: ${relations.join(', ')} (+${onlyIn1.length}/-${onlyIn2.length} tuples)${sameFiles === false ? ' [DÉCOUVERTE diffère]' : sameFiles === true ? ' [EXTRACTION diffère, mêmes fichiers]' : ''}`,
  )
}
