/**
 * Maps `file → ADRs[]` à partir des sections `## Anchored in` des ADRs.
 *
 * Avant de modifier un fichier, on demande "quels ADRs le couvrent ?". Le
 * regex d'extraction est strict (suffix-match exige un `/` — sinon `index.ts`
 * matcherait 50 fichiers).
 */

import { readFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import type { AdrToolkitConfig } from './config.js'

export interface ADRRef {
  num: string
  title: string
  file: string
  rule: string
  anchors: string[]
}

// Le contenu de `title` et `rule` est lu depuis des .md commitables —
// donc potentiellement contrôlés par un contributeur tiers — et injecté tel
// quel dans le contexte LLM via le hook PreToolUse. On neutralise les balises
// de rôle modèle qui pourraient être interprétées comme une frame système,
// et on cappe la longueur (un title/rule légitime tient largement dessous).
const INJECTION_PATTERNS = [
  /<\/?(?:system|user|assistant|system-reminder)>/gi,
  /\[\/?(?:INST|SYS)\]/gi,
  /<\|[a-z0-9_-]+\|>/gi,
]
const INJECTION_REPLACEMENT = '⟨stripped⟩'
const TITLE_MAX_LEN = 200
const RULE_MAX_LEN = 500

export function sanitize(s: string, maxLen: number): string {
  let cleaned = s
  for (const re of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(re, INJECTION_REPLACEMENT)
  }
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen) + '…'
  }
  return cleaned
}

export async function loadADRs(config: AdrToolkitConfig): Promise<ADRRef[]> {
  const adrDir = path.join(config.rootDir, config.adrDir)
  let files: string[]
  try {
    files = await readdir(adrDir)
  } catch {
    return []
  }
  // Lit les ADR files en parallèle (≤30 typique, indépendants).
  const adrFiles = files.sort().filter((f) => /^\d{3}-/.test(f))
  const adrContents = await Promise.all(
    adrFiles.map(async (f) => ({
      f, content: await readFile(path.join(adrDir, f), 'utf-8'),
    })),
  )
  const adrs: ADRRef[] = []
  for (const { f, content } of adrContents) {
    const titleMatch = content.match(/^# ADR-(\d+):\s*(.+)$/m)
    if (!titleMatch) continue
    const ruleMatch = content.match(/## Rule\s+>\s*(.+?)(?:\n\n|\n##)/s)
    const anchorsMatch = content.match(/## Anchored in\s+([\s\S]+?)(?:\n## |\n\n## |$)/)
    const anchors: string[] = []
    if (anchorsMatch) {
      // Lines like "- `path/to/file.ts` (...)" — extract path entre backticks.
      // Accepter .ts/.tsx/.sh/.sql/.md (les ADRs peuvent ancrer scripts shell
      // ou migrations SQL).
      for (const m of anchorsMatch[1].matchAll(/`([^`]+\.(?:tsx|ts|sh|sql|md)[^`]*)`/g)) {
        // Strip line numbers (e.g. "file.ts:42")
        const cleanPath = m[1].split(':')[0]
        anchors.push(cleanPath)
      }
    }
    adrs.push({
      num: titleMatch[1],
      title: sanitize(titleMatch[2].trim(), TITLE_MAX_LEN),
      file: path.relative(config.rootDir, path.join(adrDir, f)),
      rule: sanitize(ruleMatch ? ruleMatch[1].replace(/\s+/g, ' ').trim() : '', RULE_MAX_LEN),
      anchors,
    })
  }
  return adrs
}

/**
 * Match strict pour éviter les faux positifs (`index.ts` ne doit PAS matcher
 * 50+ fichiers index.ts). Suffix-match exige un `/` — match identique sinon.
 * Glob simple via `*`.
 */
export function matches(filePath: string, anchor: string): boolean {
  const norm = (s: string) => s.replace(/^\.\//, '')
  const a = norm(anchor)
  const f = norm(filePath)
  if (a === f) return true
  if (a.includes('/') && f.endsWith('/' + a)) return true
  if (f.includes('/') && a.endsWith('/' + f)) return true
  if (a.includes('*')) {
    const re = new RegExp('(^|/)' + a.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$')
    return re.test(f)
  }
  return false
}

/** Trouve les ADRs qui couvrent un fichier donné. */
export function findAdrsForFile(filePath: string, adrs: ADRRef[]): ADRRef[] {
  const hits: ADRRef[] = []
  for (const adr of adrs) {
    for (const anchor of adr.anchors) {
      if (matches(filePath, anchor)) {
        if (!hits.includes(adr)) hits.push(adr)
        break
      }
    }
  }
  return hits
}
