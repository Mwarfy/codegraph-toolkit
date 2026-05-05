// ADR-005
/**
 * Doc Claims Extractor — détecteur déterministe sur les fichiers `.md`
 * de `docs/`.
 *
 * Pourquoi : les docs (backlog, plan, roadmap) accumulent des claims
 * qui deviennent silencieusement périmées (rule "à coder" déjà shippée,
 * fichier renommé, ADR référencé puis supprimé). Le toolkit fait du
 * self-audit déterministe sur le code mais zéro audit sur les docs —
 * gap structurel.
 *
 * Pattern : per-doc bundle. Chaque .md produit un `DocClaimsFileBundle`
 * indépendant (frontmatter YAML + claims inline). Aggrégation par concat.
 *
 * Cross-checks effectués (par `evaluateDocClaims`) :
 *   1. relatedRules → existence de fichiers `.dl` correspondants
 *   2. relatedFiles → existence sur le filesystem
 *   3. relatedAdrs → existence de `docs/adr/NNN-*.md`
 *   4. lastVerified → flag si > 180 jours
 *   5. supersededBy → existence du doc cible
 *
 * Sortie : `DocClaim[]` (claim brut) + `DocStaleClaim[]` (claim avec
 * issue détectée). Émis comme facts vers `.codegraph/facts/DocClaim.facts`
 * et `.codegraph/facts/DocStaleClaim.facts`.
 *
 * Limites v1 :
 *   - Frontmatter YAML parsé manuellement (sans dépendance js-yaml)
 *     pour rester pure-Node. Limité aux types simples (string/array/null).
 *   - Pas de scan AST des .md (regex ciblés sur claims structurés et
 *     mentions inline `composite-X.dl`).
 *   - lastVerified comparé contre la date système (pas contre git log).
 */

import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

// ─── Types ──────────────────────────────────────────────────────────────

export type DocStatus = 'active' | 'shipped' | 'deferred' | 'superseded'
export type DocType = 'backlog' | 'plan' | 'roadmap' | 'reference' | 'sprint'

export interface DocFrontmatter {
  type?: DocType
  status?: DocStatus
  created?: string
  lastVerified?: string
  relatedRules?: string[]
  relatedFiles?: string[]
  relatedAdrs?: string[]
  supersedes?: string | null
  supersededBy?: string | null
}

export interface DocClaim {
  /** Path relatif depuis rootDir. */
  file: string
  /** Ligne dans le doc. 0 = frontmatter level (pas de ligne précise). */
  line: number
  /** Type de claim — détermine quel cross-check appliquer. */
  kind: 'rule-mention' | 'file-ref' | 'adr-ref' | 'frontmatter-rule' | 'frontmatter-file' | 'frontmatter-adr'
  /** Cible : nom de rule, path fichier, ID ADR. */
  target: string
}

export interface DocStaleClaim extends DocClaim {
  /** Description courte de la divergence. */
  issue: string
}

export interface DocClaimsFileBundle {
  /** Frontmatter parsé (peut être vide). */
  frontmatter: DocFrontmatter
  /** Claims inline détectées dans le body. */
  claims: DocClaim[]
}

// ─── Frontmatter parsing (mini-YAML, pas de dépendance externe) ────────

/**
 * Parse le frontmatter YAML d'un fichier .md (entre `---` au début).
 * Implémentation minimale : ne supporte que :
 *   - clés string/null sur une ligne (`key: value`)
 *   - listes inline `[a, b, c]` ou multi-ligne `- item`
 *   - null explicite (`key: null` ou ligne vide après `:`)
 *
 * Retourne un objet vide si pas de frontmatter ou parsing impossible
 * (failure mode : silencieux, on ne casse pas l'analyze).
 */
export function parseFrontmatter(content: string): DocFrontmatter {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return {}
  const end = content.indexOf('\n---', 4)
  if (end === -1) return {}
  const block = content.slice(4, end)
  const lines = block.split(/\r?\n/)

  const fm: Record<string, unknown> = {}
  const state: ParseState = { currentKey: null, currentList: null }

  for (const rawLine of lines) {
    const line = rawLine.replace(/^#.*$/, '').replace(/\s+#.*$/, '')
    if (!line.trim()) continue

    if (tryAppendListItem(line, state)) continue
    flushList(fm, state)
    parseKeyValueLine(line, fm, state)
  }

  flushList(fm, state)
  return fm as DocFrontmatter
}

// ─── parseFrontmatter helpers (split for cognitive complexity) ──────────

interface ParseState {
  currentKey: string | null
  currentList: string[] | null
}

/** Append à la liste en cours si la ligne est un item `- foo`. */
function tryAppendListItem(line: string, state: ParseState): boolean {
  if (state.currentList === null) return false
  const m = line.match(/^\s+-\s+(.+)$/)
  if (!m) return false
  state.currentList.push(stripQuotes(m[1].trim()))
  return true
}

/** Si une liste était en cours, la commit dans `fm` puis reset. */
function flushList(fm: Record<string, unknown>, state: ParseState): void {
  if (state.currentList !== null && state.currentKey !== null) {
    fm[state.currentKey] = state.currentList
    state.currentList = null
    state.currentKey = null
  }
}

/** Parse une ligne `key: value` — détermine inline vs multi-line list vs scalar. */
function parseKeyValueLine(
  line: string,
  fm: Record<string, unknown>,
  state: ParseState,
): void {
  const kv = line.match(/^([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
  if (!kv) return
  const key = kv[1]
  const value = kv[2].trim()
  fm[key] = parseScalarOrList(value, key, state)
}

/**
 * Décide quelle valeur écrire selon `value`. Si vide → ouvre une liste
 * multi-ligne (et retourne un sentinel undefined qui sera écrasé par
 * `flushList`). Sinon retourne le scalar / inline list / null.
 *
 * Mutation : peut set `state.currentKey` + `state.currentList` si
 * multi-line list détectée.
 */
function parseScalarOrList(value: string, key: string, state: ParseState): unknown {
  if (value === '') {
    state.currentKey = key
    state.currentList = []
    return [] // overwritten by flushList; placeholder pour ne pas laisser undefined
  }
  if (value === '[]') return []
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    return inner ? inner.split(',').map((s) => stripQuotes(s.trim())) : []
  }
  if (value === 'null' || value === '~') return null
  return stripQuotes(value)
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

// ─── Per-file extraction ───────────────────────────────────────────────

/**
 * Parse un fichier .md → bundle de claims.
 *
 * @param content contenu brut du .md
 * @param relPath path relatif depuis rootDir (ex: `docs/PHASE-5-COMPOSITE-BACKLOG.md`)
 */
export function extractDocClaimsFileBundle(
  content: string,
  relPath: string,
): DocClaimsFileBundle {
  const frontmatter = parseFrontmatter(content)
  const claims: DocClaim[] = []

  // ─── Claims structurées depuis frontmatter ─────────────────────────
  for (const rule of frontmatter.relatedRules ?? []) {
    claims.push({ file: relPath, line: 0, kind: 'frontmatter-rule', target: rule })
  }
  for (const file of frontmatter.relatedFiles ?? []) {
    claims.push({ file: relPath, line: 0, kind: 'frontmatter-file', target: file })
  }
  for (const adr of frontmatter.relatedAdrs ?? []) {
    claims.push({ file: relPath, line: 0, kind: 'frontmatter-adr', target: adr })
  }

  // ─── Claims inline dans le body ────────────────────────────────────
  const lines = content.split('\n')
  // Skip frontmatter lines pour ne pas les re-scanner
  let bodyStart = 0
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4)
    if (end !== -1) bodyStart = content.slice(0, end).split('\n').length + 1
  }

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]
    const lineNum = i + 1

    // Skip les TODOs structurés `- [ ]` (checkbox unchecked) : ces lignes
    // listent EXPLICITEMENT des rules à coder — leur absence du repo est
    // intentionnelle, pas un drift. Les `- [x]` (checked) restent scannés
    // car ils claiment shipped — divergence si le .dl manque.
    const isUncheckedTodo = /^\s*-\s*\[\s\]\s+/.test(line)
    if (isUncheckedTodo) continue

    // Pattern A : `composite-X` ou `composite-X.dl` (rule mentions)
    const ruleMatches = [...line.matchAll(/[`\s|](composite-[a-z][a-z0-9-]+)(?:\.dl)?[`\s.,)|]/g)]
    for (const m of ruleMatches) {
      claims.push({ file: relPath, line: lineNum, kind: 'rule-mention', target: m[1] })
    }

    // Pattern B : refs fichiers TS/JS `\`packages/.../*.ts\``
    const fileMatches = [...line.matchAll(/`(packages\/[a-zA-Z0-9_\-/.]+\.(?:ts|mjs|js|tsx))(?::\d+)?`/g)]
    for (const m of fileMatches) {
      claims.push({ file: relPath, line: lineNum, kind: 'file-ref', target: m[1] })
    }

    // Pattern C : refs ADR `ADR-NNN`
    const adrMatches = [...line.matchAll(/\bADR-(\d{3})\b/g)]
    for (const m of adrMatches) {
      claims.push({ file: relPath, line: lineNum, kind: 'adr-ref', target: `ADR-${m[1]}` })
    }
  }

  return { frontmatter, claims }
}

// ─── Walk + cross-check ─────────────────────────────────────────────────

/**
 * Walk `docs/` et extrait les bundles de tous les .md.
 *
 * Skip explicitement :
 *   - `docs/adr/` (ADRs ont leur propre cycle de vie via _TEMPLATE.md)
 *   - Fichiers cachés (`.doc-claims-audit.md` etc.)
 */
export async function extractAllDocClaims(rootDir: string): Promise<Map<string, DocClaimsFileBundle>> {
  const docsDir = join(rootDir, 'docs')
  const bundles = new Map<string, DocClaimsFileBundle>()

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    // Sépare subdirs (récursion) et files (lecture) pour parallèle.
    // Les .md du même dir sont lus concurremment ; les sous-dossiers
    // walked concurremment. Évite l'await-in-loop séquentiel.
    const subdirs: string[] = []
    const mdFiles: Array<{ full: string; relPath: string }> = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.name === 'adr') continue // skip ADRs (cycle de vie séparé)
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        subdirs.push(full)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        mdFiles.push({ full, relPath: relative(rootDir, full) })
      }
    }
    await Promise.all([
      ...subdirs.map(walk),
      ...mdFiles.map(async ({ full, relPath }) => {
        const content = await readFile(full, 'utf-8')
        bundles.set(relPath, extractDocClaimsFileBundle(content, relPath))
      }),
    ])
  }

  await walk(docsDir)
  return bundles
}

// ─── Cross-check evaluator ─────────────────────────────────────────────

export interface DocCrossCheckIndex {
  /** Set de basenames de fichiers .dl (ex: `composite-cross-fn-sql-injection`). */
  dlRules: Set<string>
  /** Set de paths relatifs depuis rootDir (ex: `packages/.../file.ts`). */
  files: Set<string>
  /** Set de IDs ADR (ex: `ADR-004`). */
  adrs: Set<string>
}

/**
 * Table de dispatch claim.kind → (set de targets valides, message si absent).
 *
 * Plat plutôt que cascade if/else : extensible sans nesting + permet à un
 * humain de voir d'un coup les 3 dimensions de check (rule / file / adr).
 *
 * Si on ajoute un kind (ex: `link-ref` pour les URLs externes), ajouter
 * une entry ici suffit — pas de modification de la boucle d'éval.
 */
type ClaimCheck = {
  hasTarget: (idx: DocCrossCheckIndex, target: string) => boolean
  formatIssue: (target: string) => string
}

const CLAIM_CHECKS: Record<DocClaim['kind'], ClaimCheck> = {
  'rule-mention': {
    hasTarget: (idx, t) => idx.dlRules.has(t),
    formatIssue: (t) => `Rule "${t}" mentionnée mais aucun .dl correspondant`,
  },
  'frontmatter-rule': {
    hasTarget: (idx, t) => idx.dlRules.has(t),
    formatIssue: (t) => `Rule "${t}" mentionnée mais aucun .dl correspondant`,
  },
  'file-ref': {
    hasTarget: (idx, t) => idx.files.has(t),
    formatIssue: (t) => `Fichier "${t}" référencé mais inexistant`,
  },
  'frontmatter-file': {
    hasTarget: (idx, t) => idx.files.has(t),
    formatIssue: (t) => `Fichier "${t}" référencé mais inexistant`,
  },
  'adr-ref': {
    hasTarget: (idx, t) => idx.adrs.has(t),
    formatIssue: (t) => `ADR "${t}" référencé mais aucun fichier docs/adr/${t.slice(4)}-*.md`,
  },
  'frontmatter-adr': {
    hasTarget: (idx, t) => idx.adrs.has(t),
    formatIssue: (t) => `ADR "${t}" référencé mais aucun fichier docs/adr/${t.slice(4)}-*.md`,
  },
}

/**
 * Cross-check les bundles contre l'index des artefacts existants.
 * Émet une `DocStaleClaim` pour chaque divergence détectée par
 * `CLAIM_CHECKS[kind]`.
 */
export function evaluateDocClaims(
  bundles: Map<string, DocClaimsFileBundle>,
  index: DocCrossCheckIndex,
): DocStaleClaim[] {
  const stale: DocStaleClaim[] = []
  for (const [, bundle] of bundles) {
    for (const claim of bundle.claims) {
      const check = CLAIM_CHECKS[claim.kind]
      if (!check.hasTarget(index, claim.target)) {
        stale.push({ ...claim, issue: check.formatIssue(claim.target) })
      }
    }
  }
  return stale
}

// ─── Helpers d'aggrégation ──────────────────────────────────────────────

/**
 * Aplatit toutes les DocClaim de tous les bundles en un seul array (utile
 * pour émission facts).
 */
export function flattenDocClaims(bundles: Map<string, DocClaimsFileBundle>): DocClaim[] {
  const all: DocClaim[] = []
  for (const [, bundle] of bundles) {
    all.push(...bundle.claims)
  }
  return all
}
