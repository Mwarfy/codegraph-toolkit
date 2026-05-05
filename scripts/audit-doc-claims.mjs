#!/usr/bin/env node
// @ts-check

/**
 * audit-doc-claims — cross-check docs/*.md claims contre la réalité du repo.
 *
 * Détecte 4 types de claims périmés :
 *   1. `composite-X.dl` mentionnés mais fichier absent (rule à coder)
 *   2. `composite-X.dl` flaggés "à faire" mais déjà shipped
 *   3. `[path/file.ts:line]` mentionnés mais fichier absent
 *   4. "Niveau N — ✓ shipped" / "✅ shipped" / "✓ Livré vX.Y.Z" sans
 *      vérification contre git tags ou fichiers attendus
 *
 * Usage :
 *   node scripts/audit-doc-claims.mjs              # rapport complet
 *   node scripts/audit-doc-claims.mjs --strict     # exit 1 si claims périmées
 *   node scripts/audit-doc-claims.mjs --json       # output JSON pour intégration
 *
 * Output : rapport markdown sur stdout. Pour persister :
 *   node scripts/audit-doc-claims.mjs > docs/.doc-claims-audit.md
 *
 * Limites volontaires :
 *   - Pas de parsing AST des .md (regex ciblés)
 *   - Pas de cross-check contre git history (les claims "shipped vX.Y.Z"
 *     sont notées comme "à vérifier manuellement")
 *   - Pas de modification de fichier (lecture seule)
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DOCS_DIR = join(ROOT, 'docs')

// ─── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const STRICT = args.includes('--strict')
const JSON_OUT = args.includes('--json')

// ─── Index des artefacts existants ────────────────────────────────────

/**
 * Walk filesystem pour construire les sets de "ce qui existe" — utilisé
 * pour cross-check les claims des docs.
 */
async function buildArtifactIndex() {
  /** @type {Set<string>} fichiers `.dl` (sans extension, basename) */
  const dlRules = new Set()
  /** @type {Set<string>} chemins relatifs depuis ROOT */
  const tsFiles = new Set()
  /** @type {Set<string>} */
  const adrIds = new Set()

  await walk(ROOT, (path) => {
    const rel = relative(ROOT, path)
    if (rel.includes('node_modules/') || rel.includes('dist/')) return
    if (path.endsWith('.dl')) {
      // composite-X.dl → "composite-X"
      const base = path.split('/').pop().replace(/\.dl$/, '')
      dlRules.add(base)
    }
    if (path.endsWith('.ts') || path.endsWith('.mjs') || path.endsWith('.js')) {
      tsFiles.add(rel)
    }
    if (rel.startsWith('docs/adr/') && /\/(\d{3})-/.test(rel)) {
      const m = rel.match(/\/(\d{3})-/)
      if (m) adrIds.add(`ADR-${m[1]}`)
    }
  })

  return { dlRules, tsFiles, adrIds }
}

/**
 * @param {string} dir
 * @param {(path: string) => void} visit
 */
async function walk(dir, visit) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, visit)
    } else {
      visit(full)
    }
  }
}

// ─── Doc claims extraction ────────────────────────────────────────────

/**
 * @typedef {Object} Claim
 * @property {string} file        relative path from ROOT
 * @property {number} line
 * @property {string} kind        'rule-shipped' | 'rule-todo' | 'file-ref' | 'shipped-version' | 'rule-name'
 * @property {string} target      ce qui est claimé (rule name, file path, version)
 * @property {string} raw         ligne brute pour contexte
 */

/**
 * @param {string} mdContent
 * @param {string} relPath
 * @returns {Claim[]}
 */
function extractClaims(mdContent, relPath) {
  /** @type {Claim[]} */
  const claims = []
  const lines = mdContent.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Pattern 1: noms de rules `composite-X` ou backtickés
    // Match `composite-cross-fn-sql-injection` ou `composite-cross-fn-sql-injection.dl`
    const ruleMatches = [...line.matchAll(/[`\s](composite-[a-z][a-z0-9-]+)(?:\.dl)?[`\s.,)]/g)]
    for (const m of ruleMatches) {
      claims.push({
        file: relPath,
        line: lineNum,
        kind: 'rule-name',
        target: m[1],
        raw: line.trim().slice(0, 120),
      })
    }

    // Pattern 2: claims explicites "✅ shipped" / "✓ Livré" / "✓ shipped"
    if (/(?:✅|✓)\s*(?:shipped|Livré|livré|done)/.test(line)) {
      // chercher version sur la même ligne
      const ver = line.match(/v?(\d+\.\d+\.\d+)/)
      claims.push({
        file: relPath,
        line: lineNum,
        kind: 'shipped-version',
        target: ver ? ver[1] : 'unspecified',
        raw: line.trim().slice(0, 120),
      })
    }

    // Pattern 3: refs fichiers TS `path/to/file.ts`
    const fileMatches = [...line.matchAll(/`(packages\/[a-zA-Z0-9_\-/]+\.(?:ts|mjs|js))(?::\d+)?`/g)]
    for (const m of fileMatches) {
      claims.push({
        file: relPath,
        line: lineNum,
        kind: 'file-ref',
        target: m[1],
        raw: line.trim().slice(0, 120),
      })
    }

    // Pattern 4: refs ADR explicites
    const adrMatches = [...line.matchAll(/\bADR-(\d{3})\b/g)]
    for (const m of adrMatches) {
      claims.push({
        file: relPath,
        line: lineNum,
        kind: 'adr-ref',
        target: `ADR-${m[1]}`,
        raw: line.trim().slice(0, 120),
      })
    }
  }

  return claims
}

// ─── Audit logic ──────────────────────────────────────────────────────

/**
 * @param {Claim[]} claims
 * @param {{ dlRules: Set<string>, tsFiles: Set<string>, adrIds: Set<string> }} index
 */
function auditClaims(claims, index) {
  /** @type {{claim: Claim, issue: string}[]} */
  const issues = []
  /** @type {Map<string, number>} */
  const ruleMentions = new Map()

  for (const claim of claims) {
    if (claim.kind === 'rule-name') {
      const count = ruleMentions.get(claim.target) ?? 0
      ruleMentions.set(claim.target, count + 1)
      if (!index.dlRules.has(claim.target)) {
        issues.push({
          claim,
          issue: `Rule "${claim.target}" mentionnée mais aucun fichier .dl correspondant`,
        })
      }
    }

    if (claim.kind === 'file-ref') {
      if (!index.tsFiles.has(claim.target)) {
        issues.push({
          claim,
          issue: `Fichier "${claim.target}" référencé mais inexistant`,
        })
      }
    }

    if (claim.kind === 'adr-ref') {
      if (!index.adrIds.has(claim.target)) {
        issues.push({
          claim,
          issue: `ADR "${claim.target}" référencé mais aucun fichier docs/adr/${claim.target.slice(4)}-*.md`,
        })
      }
    }
  }

  return { issues, ruleMentions }
}

/**
 * Détecte les rules listées comme "à faire" dans des sections backlog mais
 * dont le `.dl` existe déjà.
 *
 * Heuristique multi-signaux (OR) :
 *   1. Sigil de section header (`##|###`) qui contient un mot-clé backlog
 *   2. Ligne **bold** d'introduction de table avec "Top N" / "à ouvrir"
 *   3. Le fichier est nommé `*BACKLOG*.md` ou `*PLAN*.md` ou `*ROADMAP*.md`
 *      → tout son contenu est traité comme TODO par défaut (sauf si la
 *      ligne contient explicitement ✓ / ✅ / Livré / shipped / SKIPPED / ABSORBÉ)
 *
 * @param {string} mdContent
 * @param {string} relPath
 * @param {Set<string>} dlRules
 */
function detectStaleTodos(mdContent, relPath, dlRules) {
  /** @type {{file: string, line: number, rule: string, raw: string}[]} */
  const stale = []
  const lines = mdContent.split('\n')

  const isBacklogFile = /BACKLOG|PLAN|ROADMAP|TODO/i.test(relPath)
  const TODO_HEADER_RE =
    /top \d+ roi|à ouvrir|à faire|pr.{0,3}à ouvrir|cette semaine|todo|backlog|à attaquer|reprise|tier \d+|priorit|niveau \d+/i
  const SHIPPED_INLINE_RE = /✓|✅|Livré|livré|shipped|SKIPPED|ABSORBÉ|absorb|déféré|skipped/

  let inTodoSection = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Track section headings (h2/h3) + bold standalone lines
    const isHeader = /^#+\s/.test(line) || /^\*\*[^*]+\*\*\s*[:(]/.test(line)
    if (isHeader) {
      inTodoSection = TODO_HEADER_RE.test(line)
      // Pour les fichiers backlog : ne pas skip, on scanne aussi le header
      // (ex: `### 1. composite-cross-fn-sql-injection` doit être détecté).
      if (!isBacklogFile) continue
    }

    // Pour les fichiers backlog, scanner toutes les lignes par défaut
    const scanThisLine = inTodoSection || isBacklogFile
    if (!scanThisLine) continue

    // Skip si la ligne elle-même indique shipped/skipped/déféré
    if (SHIPPED_INLINE_RE.test(line)) continue

    // Skip aussi si la ligne précédente OU suivante (within 2) marque ✓ explicitement
    const ctxRange = [lines[i - 1], lines[i + 1], lines[i + 2]].filter(Boolean).join(' ')
    if (SHIPPED_INLINE_RE.test(ctxRange) && /Status|Statut|État/i.test(ctxRange)) continue

    const ruleMatches = [...line.matchAll(/[`\s|](composite-[a-z][a-z0-9-]+)(?:\.dl)?[`\s.,)|]/g)]
    for (const m of ruleMatches) {
      if (dlRules.has(m[1])) {
        stale.push({
          file: relPath,
          line: i + 1,
          rule: m[1],
          raw: line.trim().slice(0, 120),
        })
      }
    }
  }

  return stale
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const index = await buildArtifactIndex()
  const docsEntries = await readdir(DOCS_DIR, { withFileTypes: true })

  /** @type {Claim[]} */
  const allClaims = []
  /** @type {{file: string, line: number, rule: string, raw: string}[]} */
  const allStaleTodos = []

  for (const entry of docsEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const fullPath = join(DOCS_DIR, entry.name)
    const relPath = relative(ROOT, fullPath)
    const content = await readFile(fullPath, 'utf-8')
    const claims = extractClaims(content, relPath)
    allClaims.push(...claims)
    const stale = detectStaleTodos(content, relPath, index.dlRules)
    allStaleTodos.push(...stale)
  }

  const { issues, ruleMentions } = auditClaims(allClaims, index)

  // Output
  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          totals: {
            docs_scanned: docsEntries.filter((e) => e.isFile() && e.name.endsWith('.md')).length,
            claims_total: allClaims.length,
            issues: issues.length,
            stale_todos: allStaleTodos.length,
            dl_rules_in_repo: index.dlRules.size,
            adr_files: index.adrIds.size,
          },
          stale_todos: allStaleTodos,
          issues,
        },
        null,
        2,
      ),
    )
  } else {
    printMarkdown({ allClaims, allStaleTodos, issues, ruleMentions, index })
  }

  if (STRICT && (issues.length > 0 || allStaleTodos.length > 0)) {
    process.exit(1)
  }
}

/**
 * @param {object} args
 * @param {Claim[]} args.allClaims
 * @param {{file: string, line: number, rule: string, raw: string}[]} args.allStaleTodos
 * @param {{claim: Claim, issue: string}[]} args.issues
 * @param {Map<string, number>} args.ruleMentions
 * @param {{ dlRules: Set<string>, tsFiles: Set<string>, adrIds: Set<string> }} args.index
 */
function printMarkdown({ allClaims, allStaleTodos, issues, ruleMentions, index }) {
  const out = []
  out.push(`# Doc claims audit — ${new Date().toISOString().slice(0, 10)}\n`)
  out.push(`## Totals\n`)
  out.push(`- Claims totales détectées : ${allClaims.length}`)
  out.push(`- Rules .dl dans le repo : ${index.dlRules.size}`)
  out.push(`- ADRs dans docs/adr/ : ${index.adrIds.size}`)
  out.push(`- **Issues détectées : ${issues.length}**`)
  out.push(`- **Stale TODOs (rules dans backlog mais déjà shipped) : ${allStaleTodos.length}**\n`)

  if (allStaleTodos.length > 0) {
    out.push(`## Stale TODOs — rules listées comme "à faire" mais déjà shipped\n`)
    out.push(`Ces lignes mentionnent des rules dans une section "Top ROI / Backlog / À ouvrir"`)
    out.push(`alors que le fichier \`.dl\` existe déjà. À déplacer en "✓ shipped".\n`)
    const byFile = new Map()
    for (const s of allStaleTodos) {
      if (!byFile.has(s.file)) byFile.set(s.file, [])
      byFile.get(s.file).push(s)
    }
    for (const [file, entries] of byFile) {
      out.push(`### ${file}`)
      out.push('')
      for (const e of entries) {
        out.push(`- L${e.line} \`${e.rule}\` — ${e.raw}`)
      }
      out.push('')
    }
  }

  if (issues.length > 0) {
    out.push(`## Issues\n`)
    const byKind = new Map()
    for (const it of issues) {
      const k = it.claim.kind
      if (!byKind.has(k)) byKind.set(k, [])
      byKind.get(k).push(it)
    }
    for (const [kind, entries] of byKind) {
      out.push(`### ${kind} (${entries.length})`)
      out.push('')
      for (const e of entries.slice(0, 50)) {
        out.push(`- \`${e.claim.file}:${e.claim.line}\` — ${e.issue}`)
      }
      if (entries.length > 50) out.push(`- ... et ${entries.length - 50} autres`)
      out.push('')
    }
  }

  out.push(`## Rules les plus mentionnées (top 20)\n`)
  const sorted = [...ruleMentions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  out.push(`| Rule | Mentions | .dl exists |`)
  out.push(`|---|---|---|`)
  for (const [rule, count] of sorted) {
    const exists = index.dlRules.has(rule) ? '✅' : '✗'
    out.push(`| \`${rule}\` | ${count} | ${exists} |`)
  }
  out.push('')

  console.log(out.join('\n'))
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
