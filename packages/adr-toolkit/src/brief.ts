/**
 * Brief generator — produit `<rootDir>/<briefPath>` (default `CLAUDE-CONTEXT.md`).
 *
 * Boot brief que l'agent lit en début de session avant toute action :
 *   - ADRs actifs (numéro + Rule + lien vers le doc)
 *   - Fichiers gouvernés (lookup file → ADRs[] pré-calculé)
 *   - Tests d'invariant actifs (extraits des paths de la config OU du
 *     pre-commit hook si présent)
 *   - Top hubs (depuis codegraph synopsis.json) + ADR anchor suggestions
 *   - Activité récente (git log 14d)
 *
 * Sources déterministes uniquement, zéro LLM. Si synopsis.json absent, on
 * tourne en mode dégradé sans top hubs.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import * as path from 'node:path'
import type { AdrToolkitConfig } from './config.js'

interface ADRSummary {
  num: string
  title: string
  rule: string
  file: string
  anchors: string[]
}

async function collectADRs(config: AdrToolkitConfig): Promise<ADRSummary[]> {
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
  const adrs: ADRSummary[] = []
  for (const { f, content } of adrContents) {
    const titleMatch = content.match(/^# ADR-(\d+):\s*(.+)$/m)
    if (!titleMatch) continue
    let rule: string | null = null
    const ruleMatch = content.match(/## Rule\s+>\s*(.+?)(?:\n\n|\n##)/s)
    if (ruleMatch) {
      rule = ruleMatch[1].replace(/\s+/g, ' ').trim()
    } else {
      const decMatch = content.match(/## Decision\s+(.+?)(?:\n##|$)/s)
      if (decMatch) {
        const firstPara = decMatch[1].trim().split(/\n\n/)[0].replace(/\s+/g, ' ').trim()
        rule = firstPara.length > 200 ? firstPara.slice(0, 197) + '…' : firstPara
      }
    }
    const anchors: string[] = []
    const anchorsMatch = content.match(/## Anchored in\s+([\s\S]+?)(?:\n## |\n\n## |$)/)
    if (anchorsMatch) {
      for (const m of anchorsMatch[1].matchAll(/`([^`]+\.(?:tsx|ts|sh|sql|md))[^`]*`/g)) {
        anchors.push(m[1].split(':')[0])
      }
    }
    if (rule) {
      adrs.push({
        num: titleMatch[1],
        title: titleMatch[2].trim(),
        rule,
        file: path.relative(config.rootDir, path.join(adrDir, f)),
        anchors,
      })
    }
  }
  return adrs
}

function buildAnchorIndex(adrs: ADRSummary[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const adr of adrs) {
    for (const anchor of adr.anchors) {
      const list = index.get(anchor) || []
      if (!list.includes(adr.num)) list.push(adr.num)
      index.set(anchor, list)
    }
  }
  return index
}

/**
 * Liste les tests d'invariant. 2 sources possibles :
 *   1. config.invariantTestPaths (globs explicites)
 *   2. fallback : extraire du pre-commit hook si présent (`scripts/git-hooks/pre-commit`)
 */
async function collectInvariantTests(config: AdrToolkitConfig): Promise<string[]> {
  // Source 1 : config explicite. Pour chaque pattern (sans glob avancé),
  // on liste les fichiers correspondants si le pattern pointe vers un
  // dir, sinon on garde le pattern littéral.
  if (config.invariantTestPaths.length > 0) {
    const out = new Set<string>()
    for (const pattern of config.invariantTestPaths) {
      // Support très simple : le pattern peut être un path direct, ou un
      // path se terminant par /*-invariant.test.ts (etc.). On liste le dir
      // parent et matche par nom.
      const fullPattern = path.join(config.rootDir, pattern)
      const lastSlash = fullPattern.lastIndexOf('/')
      const dir = fullPattern.slice(0, lastSlash)
      const namePattern = fullPattern.slice(lastSlash + 1)
      if (!namePattern.includes('*')) {
        out.add(pattern)
        continue
      }
      try {
        // await-ok: glob expansion 1-shot, séquentiel acceptable
        const entries = await readdir(dir)
        const re = new RegExp('^' + namePattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
        for (const e of entries) {
          if (re.test(e)) {
            out.add(path.relative(config.rootDir, path.join(dir, e)))
          }
        }
      } catch {
        // dir absent — on garde le pattern littéral pour signaler à l'humain
        out.add(pattern)
      }
    }
    return [...out].sort()
  }

  // Source 2 : fallback pre-commit hook
  const hookPath = path.join(config.rootDir, 'scripts/git-hooks/pre-commit')
  try {
    const hook = await readFile(hookPath, 'utf-8')
    const matches = [...hook.matchAll(/tests\/unit\/([a-z0-9-]+\.test\.ts)/g)]
    const names = [...new Set(matches.map(m => `tests/unit/${m[1]}`))]
    return names.sort()
  } catch {
    return []
  }
}

interface SynopsisTension {
  kind: string
  coordinates: string
  note?: string
  testHint?: string
}

interface SynopsisData {
  topHubs?: Array<{ id: string; inDegree: number; adrs?: string[] }>
  adrSuggestions?: Array<{ file: string; inDegree: number; reason: string }>
  tensions?: SynopsisTension[]
}

async function loadSynopsis(config: AdrToolkitConfig): Promise<SynopsisData | null> {
  // Essaie 2 chemins standards : <rootDir>/.codegraph/synopsis.json et
  // <rootDir>/codegraph/.codegraph/synopsis.json (Sentinel layout).
  const candidates = [
    path.join(config.rootDir, '.codegraph/synopsis.json'),
    path.join(config.rootDir, 'codegraph/.codegraph/synopsis.json'),
  ]
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8'))
    } catch {
      // try next
    }
  }
  return null
}

async function topHubsFromSynopsis(synopsis: SynopsisData | null): Promise<string[]> {
  if (!synopsis?.topHubs || synopsis.topHubs.length === 0) return []
  return synopsis.topHubs.slice(0, 8).map(h => {
    const adrSuffix = h.adrs && h.adrs.length > 0
      ? ` · gov by ${h.adrs.map(n => `ADR-${n}`).join(', ')}`
      : ''
    return `\`${h.id}\` (in: ${h.inDegree})${adrSuffix}`
  })
}

/**
 * Format markdown des tensions pour le brief — convocations courtes.
 * Une ligne par tension. Format : **LABEL** `coords` — note · _→ test_
 */
function renderTensionsForBrief(tensions: SynopsisTension[]): string {
  const labels: Record<string, string> = {
    'cycle': 'CYCLE',
    'orphan': 'ORPHELIN',
    'fsm-dead': 'FSM-DEAD',
    'fsm-orphan': 'FSM-ORPHAN',
    'dep-unused': 'DEP-UNUSED',
    'barrel-low': 'BARREL-LOW',
    'back-edge': 'BACK-EDGE',
  }
  return tensions.slice(0, 15).map(t => {
    const label = labels[t.kind] ?? t.kind.toUpperCase()
    const note = t.note ? ` — ${t.note}` : ''
    const hint = t.testHint ? `  \n  _→ ${t.testHint}_` : ''
    return `- **${label}** \`${t.coordinates}\`${note}${hint}`
  }).join('\n')
}

function recentCommits(rootDir: string): string[] {
  try {
    const out = execSync(
      `git -C "${rootDir}" log --since="14 days ago" --oneline`,
      { encoding: 'utf-8' },
    )
    return out.trim().split('\n').filter(Boolean).slice(0, 12)
  } catch {
    return []
  }
}

export interface GenerateBriefOptions {
  config: AdrToolkitConfig
  /** Nom du projet pour le titre. Default : basename de rootDir. */
  projectName?: string
  /**
   * Sections markdown à injecter dans le brief. Chaque section est ajoutée
   * dans l'ordre fourni, à l'emplacement indiqué par `placement`.
   * - `after-anchored-files` : après "Fichiers gouvernés par un ADR"
   * - `after-invariant-tests` : après "Tests d'invariant"
   * - `after-recent-activity` : à la toute fin (avant "Comment contribuer")
   */
  customSections?: Array<{
    placement: 'after-anchored-files' | 'after-invariant-tests' | 'after-recent-activity'
    markdown: string
  }>
}

export interface GenerateBriefResult {
  outputPath: string
  lineCount: number
  adrCount: number
  anchoredFileCount: number
  invariantTestCount: number
}

export async function generateBrief(opts: GenerateBriefOptions): Promise<GenerateBriefResult> {
  const { config } = opts
  const projectName = opts.projectName ?? path.basename(config.rootDir)
  const customSections = opts.customSections ?? []
  const sectionsAt = (placement: string) =>
    customSections
      .filter(s => s.placement === placement)
      .map(s => '\n' + s.markdown.trim() + '\n')
      .join('\n')
  const adrs = await collectADRs(config)
  const tests = await collectInvariantTests(config)
  const commits = recentCommits(config.rootDir)
  const synopsis = await loadSynopsis(config)
  const hubs = await topHubsFromSynopsis(synopsis)
  const adrSuggestions = synopsis?.adrSuggestions ?? []
  const tensions = synopsis?.tensions ?? []
  const anchorIndex = buildAnchorIndex(adrs)
  const fileAdrLines = [...anchorIndex.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, adrNums]) => `- \`${file}\` → ${adrNums.sort().map(n => `ADR-${n}`).join(', ')}`)

  const md = `<!-- AUTO-GÉNÉRÉ par @liby-tools/adr-toolkit — NE PAS éditer à la main -->

# Boot Brief — ${projectName}

> **À lire AVANT toute action.** Ce fichier est le state-of-the-architecture.
> Si tu modifies un fichier listé dans "Fichiers gouvernés par un ADR" ci-dessous,
> lis l'ADR correspondant AVANT d'éditer.

## Règles architecturales actives (ADRs)

${adrs.length > 0 ? adrs.map(a => `- **ADR-${a.num}** — ${a.rule}\n  → [\`${a.title}\`](${a.file})`).join('\n') : '- (aucun ADR trouvé dans `' + config.adrDir + '`)'}

## Fichiers gouvernés par un ADR (lookup pré-calculé)

${fileAdrLines.length > 0 ? fileAdrLines.join('\n') : '- (aucun ADR n\'a de section `## Anchored in` extractable)'}
${sectionsAt('after-anchored-files')}
## Tests d'invariant qui gardent ces règles

${tests.length > 0 ? tests.map(t => `- \`${t}\``).join('\n') : '- (aucun invariant configuré — voir `invariantTestPaths` dans .codegraph-toolkit.json)'}
${sectionsAt('after-invariant-tests')}
## Top hubs (fichiers les plus importés — gros risque de régression si touchés)

${hubs.length > 0 ? hubs.map(h => `- ${h}`).join('\n') : '- (snapshot codegraph absent — `npx @liby-tools/codegraph analyze`)'}
${adrSuggestions.length > 0 ? `\n## ⚠ ADR anchor suggestions\n\nFichiers load-bearing (in-degree élevé ou truth-point) **sans aucun marqueur \`// ADR-NNN\`** dans le code. Intentionnel ? Sinon poser un marqueur ou créer un ADR :\n\n${adrSuggestions.slice(0, 8).map((s) => `- **${s.inDegree}** \`${s.file}\` _(${s.reason})_`).join('\n')}\n` : ''}
## Tensions actives — invitations à explorer

> Convocations courtes pointant vers des frictions détectées dans le code.
> Chaque tension a un **test rapide** pour trancher : hypothèse à vérifier,
> pas verdict. Une tension non explorée n'est pas un bug — c'est un saut
> latéral possible que le sol stable rend testable.

${tensions.length > 0 ? renderTensionsForBrief(tensions) : '_(aucune tension détectée par les détecteurs codegraph — code sain ou détecteurs silencieux)_'}

## Activité récente (14 derniers jours)

\`\`\`
${commits.join('\n') || '(no commits in last 14 days)'}
\`\`\`
${sectionsAt('after-recent-activity')}
## Comment contribuer à ce brief

- Une nouvelle décision architecturale ? Crée un ADR via le template :
  \`@liby-tools/adr-toolkit/templates/_TEMPLATE.md\`
- Le brief sera régénéré au prochain commit.
- Pour forcer une régen : \`npx @liby-tools/adr-toolkit brief\`
`

  const outputPath = path.join(config.rootDir, config.briefPath)
  await writeFile(outputPath, md, 'utf-8')
  return {
    outputPath,
    lineCount: md.split('\n').length,
    adrCount: adrs.length,
    anchoredFileCount: anchorIndex.size,
    invariantTestCount: tests.length,
  }
}
