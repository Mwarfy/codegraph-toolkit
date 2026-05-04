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
const AUTOGEN_MARKER = '<!-- AUTO-GÉNÉRÉ depuis les marqueurs ADR-NNN du code source. Voir @liby-tools/adr-toolkit. NE PAS éditer à la main. -->'

async function collectMarkers(config: AdrToolkitConfig): Promise<Marker[]> {
  const markers: Marker[] = []
  const skipDirs = new Set(config.skipDirs)
  const exts = new Set(config.anchorMarkerExtensions)
  const extRe = new RegExp(`\\.(${[...exts].map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`)

  await walkDirForMarkers(config.rootDir, config.rootDir, skipDirs, extRe, markers)
  return markers
}

async function walkDirForMarkers(
  dir: string,
  rootDir: string,
  skipDirs: Set<string>,
  extRe: RegExp,
  markers: Marker[],
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue
    if (skipDirs.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      // await-ok: walk récursif — séquentiel délibéré (ordre stable + simple)
      await walkDirForMarkers(full, rootDir, skipDirs, extRe, markers)
    } else if (e.isFile() && extRe.test(e.name)) {
      // await-ok: scan one-shot regenerate-anchors, perf non-critique
      await scanFileForMarkers(full, rootDir, markers)
    }
  }
}

async function scanFileForMarkers(
  full: string,
  rootDir: string,
  markers: Marker[],
): Promise<void> {
  const content = await readFile(full, 'utf-8')
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    extractMarkersFromLine(lines[i], i + 1, full, rootDir, markers)
  }
}

function extractMarkersFromLine(
  line: string,
  lineNumber: number,
  full: string,
  rootDir: string,
  markers: Marker[],
): void {
  const m = line.match(ANCHOR_LINE)
  if (!m) return
  const adrTokens = [...m[1].matchAll(ADR_NUM)].map((t) => t[1])
  const role = m[2]?.trim().replace(/[\s*\/+]+$/, '') || undefined
  for (const adr of adrTokens) {
    markers.push({
      adr,
      role,
      file: path.relative(rootDir, full),
      line: lineNumber,
    })
  }
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
  // Lit les ADR files en parallèle (≤30 fichiers typique, indépendants).
  const adrEntries = await Promise.all(
    files
      .sort()
      .filter((f) => /^\d{3}-/.test(f))
      .map(async (f) => {
        const num = f.slice(0, 3)
        const filePath = path.join(adrDir, f)
        const content = await readFile(filePath, 'utf-8')
        return { num, filePath, content }
      }),
  )
  adrs.push(...adrEntries)
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
      // await-ok: ADR file write — séquentiel par ADR processé, perf non-critique
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
