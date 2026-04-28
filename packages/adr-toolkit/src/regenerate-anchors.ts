/**
 * SSOT inversée : les marqueurs `// ADR-NNN` du code génèrent la section
 * `## Anchored in` de chaque ADR. Survit aux renames de fichiers (un grep,
 * pas une référence statique en doc).
 *
 * Mode `checkOnly: true` = ne réécrit rien, retourne `drift: true` si la
 * section est désynchronisée. Utilisé par le pre-commit hook + CI.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import type { AdrToolkitConfig } from './config.js'

interface Marker {
  adr: string
  role?: string
  file: string
  line: number
}

interface ADR {
  num: string
  filePath: string
  content: string
}

const ANCHOR_LINE = /^\s*(?:\/\/|#|\*)\s*(ADR-\d{3}(?:\s*[:,\-—]?\s*ADR-\d{3})*)\s*(?::\s*(.+))?$/
const ADR_NUM = /ADR-(\d{3})/g

// Pas de backticks dans le commentaire HTML — ils confondent le regex
// d'extraction des paths du linker (qui cherche path.ts entre backticks).
const AUTOGEN_MARKER = '<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby/adr-toolkit. NE PAS éditer à la main. -->'

async function collectMarkers(config: AdrToolkitConfig): Promise<Marker[]> {
  const markers: Marker[] = []
  const skipDirs = new Set(config.skipDirs)
  const exts = new Set(config.anchorMarkerExtensions)
  const extRe = new RegExp(`\\.(${[...exts].map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`)

  async function walk(dir: string): Promise<void> {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue
      if (skipDirs.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile() && extRe.test(e.name)) {
        const content = await readFile(full, 'utf-8')
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const m = line.match(ANCHOR_LINE)
          if (!m) continue
          const adrTokens = [...m[1].matchAll(ADR_NUM)].map(t => t[1])
          const role = m[2]?.trim().replace(/[\s*\/+]+$/, '') || undefined
          for (const adr of adrTokens) {
            markers.push({
              adr,
              role,
              file: path.relative(config.rootDir, full),
              line: i + 1,
            })
          }
        }
      }
    }
  }
  await walk(config.rootDir)
  return markers
}

async function loadADRs(config: AdrToolkitConfig): Promise<ADR[]> {
  const adrDir = path.join(config.rootDir, config.adrDir)
  let files: string[]
  try {
    files = await readdir(adrDir)
  } catch {
    return []
  }
  const adrs: ADR[] = []
  for (const f of files.sort()) {
    if (!/^\d{3}-/.test(f)) continue
    const num = f.slice(0, 3)
    const filePath = path.join(adrDir, f)
    const content = await readFile(filePath, 'utf-8')
    adrs.push({ num, filePath, content })
  }
  return adrs
}

function buildAnchoredInSection(markers: Marker[]): string {
  const byFile = new Map<string, { role?: string; lines: number[] }>()
  for (const m of markers) {
    const entry = byFile.get(m.file) || { role: undefined, lines: [] }
    entry.lines.push(m.line)
    if (!entry.role && m.role) entry.role = m.role
    byFile.set(m.file, entry)
  }

  const sortedFiles = [...byFile.keys()].sort()
  const lines = sortedFiles.map(f => {
    const entry = byFile.get(f)!
    return entry.role ? `- \`${f}\` — ${entry.role}` : `- \`${f}\``
  })

  return `## Anchored in\n\n${AUTOGEN_MARKER}\n\n${lines.join('\n')}\n`
}

function rewriteAdrAnchored(adrContent: string, newSection: string): string {
  const anchoredRe = /## Anchored in\s+([\s\S]*?)(?=\n## |\n\n## |$)/
  const newSectionTrimmed = newSection.replace(/\n+$/, '')

  if (anchoredRe.test(adrContent)) {
    return adrContent.replace(anchoredRe, newSectionTrimmed + '\n')
  }

  const ruleRe = /(## Rule\s+>\s*[^\n]+(?:\n>[^\n]*)*)/
  if (ruleRe.test(adrContent)) {
    return adrContent.replace(ruleRe, `$1\n\n${newSectionTrimmed}`)
  }

  return adrContent.replace(/\n*$/, '\n\n' + newSectionTrimmed + '\n')
}

export interface RegenOptions {
  config: AdrToolkitConfig
  checkOnly?: boolean
}

export interface RegenResult {
  drift: boolean
  modified: string[]
  totalMarkers: number
  adrsWithMarkers: number
  orphanAdrs: string[]
}

export async function regenerateAnchors(opts: RegenOptions): Promise<RegenResult> {
  const { config, checkOnly = false } = opts
  const markers = await collectMarkers(config)
  const adrs = await loadADRs(config)

  const byAdr = new Map<string, Marker[]>()
  for (const m of markers) {
    const list = byAdr.get(m.adr) || []
    list.push(m)
    byAdr.set(m.adr, list)
  }

  const orphanAdrs = [...byAdr.keys()].filter(n => !adrs.find(a => a.num === n))
  if (orphanAdrs.length > 0) {
    return {
      drift: true,
      modified: [],
      totalMarkers: markers.length,
      adrsWithMarkers: byAdr.size,
      orphanAdrs,
    }
  }

  let drift = false
  const modified: string[] = []
  for (const adr of adrs) {
    const adrMarkers = byAdr.get(adr.num) || []
    const newSection = buildAnchoredInSection(adrMarkers)
    const updated = rewriteAdrAnchored(adr.content, newSection)
    if (updated === adr.content) continue
    if (checkOnly) {
      drift = true
    } else {
      await writeFile(adr.filePath, updated, 'utf-8')
      modified.push(adr.filePath)
    }
  }

  return {
    drift,
    modified,
    totalMarkers: markers.length,
    adrsWithMarkers: byAdr.size,
    orphanAdrs: [],
  }
}
