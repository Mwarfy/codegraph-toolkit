// ADR-004: 3 rôles séparés (Status: Proposed only, jamais Accepted)
/**
 * Bootstrap writer — écrit les drafts validés sur disque.
 *
 * Crée :
 *   - <adrDir>/NNN-<slug>.md (avec Status: Proposed jusqu'à validation humaine)
 *   - Marqueurs `// ADR-NNN` au top des anchors (mode --apply uniquement)
 *
 * Numérotation : trouve le prochain NNN disponible en scannant adrDir.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { AdrToolkitConfig } from './config.js'
import type { AdrDraft } from './bootstrap.js'

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
}

async function nextAdrNumber(adrDir: string): Promise<number> {
  let max = 0
  try {
    const entries = await readdir(adrDir)
    for (const e of entries) {
      const m = e.match(/^(\d{3})-/)
      if (m && m[1]) {
        const n = parseInt(m[1], 10)
        if (n > max) max = n
      }
    }
  } catch {
    // dir absent, max = 0
  }
  return max + 1
}

export interface ApplyOptions {
  config: AdrToolkitConfig
  drafts: AdrDraft[]
  /** Si false, écrit uniquement les ADRs (pas les marqueurs). Mode dry-run. */
  applyMarkers?: boolean
}

export interface ApplyResult {
  written: string[]
  markersAdded: Array<{ file: string; adrNum: string }>
}

function formatAdrMarkdown(draft: AdrDraft, num: string): string {
  const assertsYaml = draft.asserts && draft.asserts.length > 0
    ? `---\nasserts:\n${draft.asserts.map(a => {
        const lines = [`  - symbol: "${a.symbol}"`]
        if (a.exists !== undefined) lines.push(`    exists: ${a.exists}`)
        if (a.type !== undefined) lines.push(`    type: "${a.type}"`)
        return lines.join('\n')
      }).join('\n')}\n---\n\n`
    : ''

  const anchorsList = (draft.anchors ?? [draft.primaryAnchor])
    .map(a => `- \`${a}\``)
    .join('\n')

  const confidenceNote = draft.confidence === 'low'
    ? '\n> ⚠ Confiance basse — relire et valider avant de passer à `Status: Accepted`.\n'
    : ''

  return `${assertsYaml}# ADR-${num}: ${draft.title ?? 'TODO'}

**Date:** ${new Date().toISOString().slice(0, 10)}
**Status:** Proposed
${confidenceNote}
## Rule

> ${draft.rule ?? 'TODO'}

## Why

${draft.why ?? 'TODO: pourquoi cette décision ?'}

## How to apply

- TODO : compléter (ex. "Constructeur privé + getInstance()", "Pas d'instanciation directe")

## Anchored in

<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. NE PAS éditer à la main. -->

${anchorsList}

## Tested by

- _(à ajouter — tests d'invariant qui pètent si la règle est violée)_
`
}

export async function applyDrafts(opts: ApplyOptions): Promise<ApplyResult> {
  const { config, drafts } = opts
  const adrDir = path.join(config.rootDir, config.adrDir)
  const result: ApplyResult = { written: [], markersAdded: [] }

  let nextNum = await nextAdrNumber(adrDir)

  for (const draft of drafts) {
    const num = String(nextNum).padStart(3, '0')
    nextNum++
    const slug = slugify(draft.title ?? draft.pattern)
    const fileName = `${num}-${slug}.md`
    const filePath = path.join(adrDir, fileName)
    const md = formatAdrMarkdown(draft, num)
    // await-ok: ADR scaffold writes — séquentiel par draft (numbering nextNum++)
    await writeFile(filePath, md, 'utf-8')
    result.written.push(path.relative(config.rootDir, filePath))

    // Ajout des marqueurs `// ADR-NNN` aux anchors — process en parallèle
    // (anchors de 1 draft sont des fichiers distincts, write idempotente
    // car content guard sur `marker` already present).
    if (opts.applyMarkers !== false) {
      // await-ok: outer drafts loop séquentielle (numbering nextNum++) ; le Promise.all interne paralllise les anchors d'1 draft
      const anchorResults = await Promise.all(
        (draft.anchors ?? [draft.primaryAnchor]).map(async (anchor) => {
          const fullAnchor = path.join(config.rootDir, anchor)
          try {
            const content = await readFile(fullAnchor, 'utf-8')
            const marker = `// ADR-${num}`
            if (content.includes(marker)) return null // déjà présent
            const newContent = `${marker}\n${content}`
            await writeFile(fullAnchor, newContent, 'utf-8')
            return { file: anchor, adrNum: num }
          } catch {
            return null /* Anchor introuvable — silent */
          }
        }),
      )
      for (const r of anchorResults) {
        if (r) result.markersAdded.push(r)
      }
    }
  }

  return result
}
