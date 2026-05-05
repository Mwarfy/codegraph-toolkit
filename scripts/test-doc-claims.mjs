#!/usr/bin/env node
// Quick smoke test pour l'extractor doc-claims.ts.
// Pas un test vitest — juste un script qui montre les sorties sur les
// docs réels du repo. Utile pour debug + vérifier le frontmatter parsing.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// Build le package d'abord pour avoir les .js compilés
const { extractAllDocClaims, evaluateDocClaims, flattenDocClaims, parseFrontmatter } = await import(
  join(ROOT, 'packages/codegraph/dist/extractors/doc-claims.js')
)

// Build l'index des artefacts
import { readdir } from 'node:fs/promises'
import { relative } from 'node:path'

async function buildIndex(rootDir) {
  const dlRules = new Set()
  const files = new Set()
  const adrs = new Set()

  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.git') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue
      }
      const full = join(dir, entry.name)
      const rel = relative(rootDir, full)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.dl')) {
          dlRules.add(entry.name.replace(/\.dl$/, ''))
        }
        if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) {
          files.add(rel)
        }
        if (rel.startsWith('docs/adr/')) {
          const m = entry.name.match(/^(\d{3})-/)
          if (m) adrs.add(`ADR-${m[1]}`)
        }
      }
    }
  }

  await walk(rootDir)
  return { dlRules, files, adrs }
}

const bundles = await extractAllDocClaims(ROOT)
const index = await buildIndex(ROOT)
const stale = evaluateDocClaims(bundles, index)
const allClaims = flattenDocClaims(bundles)

console.log(`# Doc claims extractor smoke test`)
console.log(``)
console.log(`Bundles extraits : ${bundles.size}`)
console.log(`Claims totales  : ${allClaims.length}`)
console.log(`Index : ${index.dlRules.size} rules .dl, ${index.files.size} fichiers TS, ${index.adrs.size} ADRs`)
console.log(`Stale claims    : ${stale.length}`)
console.log(``)

console.log(`## Frontmatter parsé par doc`)
console.log(``)
for (const [path, bundle] of bundles) {
  const fm = bundle.frontmatter
  if (!fm.type && !fm.status) continue
  console.log(`### ${path}`)
  console.log(`- type: ${fm.type ?? '(absent)'}`)
  console.log(`- status: ${fm.status ?? '(absent)'}`)
  console.log(`- relatedRules: ${(fm.relatedRules ?? []).length} entries`)
  console.log(`- relatedFiles: ${(fm.relatedFiles ?? []).length} entries`)
  console.log(`- relatedAdrs: ${(fm.relatedAdrs ?? []).length} entries`)
  console.log(``)
}

console.log(`## Stale par kind`)
const byKind = new Map()
for (const s of stale) {
  byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1)
}
for (const [k, n] of byKind) {
  console.log(`- ${k}: ${n}`)
}
console.log(``)

console.log(`## Top 20 stale claims`)
for (const s of stale.slice(0, 20)) {
  console.log(`- ${s.file}:${s.line} [${s.kind}] ${s.target} — ${s.issue}`)
}
