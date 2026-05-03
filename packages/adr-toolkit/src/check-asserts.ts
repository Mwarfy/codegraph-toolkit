// ADR-002
/**
 * Asserts ts-morph sur les ADRs : les claims sémantiques (« la fonction `foo`
 * existe », « `bar` est de type `Set<string>` ») deviennent EXÉCUTABLES.
 *
 * Format dans l'ADR (frontmatter YAML en tête de fichier) :
 *
 *   ---
 *   asserts:
 *     - symbol: "kernel/scheduler#inFlightBlocks"
 *       type: "Set<string>"
 *     - symbol: "kernel/llm-router#fanOut"
 *       exists: true
 *   ---
 *
 *   # ADR-NNN: Titre
 *
 * Si quelqu'un renomme `inFlightBlocks` → `_inFlight`, le check pète et l'ADR
 * doit être mise à jour. Le drift ADR↔code devient impossible.
 *
 * Résolution module#symbol : essaie chaque entrée de `srcDirs` × {.ts, .tsx, /index.ts}.
 */

import { readFile, readdir } from 'node:fs/promises'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Project, Node, ts as tsApi } from 'ts-morph'
import type { AdrToolkitConfig } from './config.js'

interface Assert {
  symbol: string                // "module#symbol"
  exists?: boolean
  type?: string
}

interface ADRWithAsserts {
  num: string
  filePath: string
  asserts: Assert[]
}

export interface CheckResult {
  adr: string
  symbol: string
  ok: boolean
  reason?: string
}

export interface CheckAssertsResult {
  total: number
  passed: number
  failed: number
  results: CheckResult[]
}

function parseFrontmatter(content: string): Assert[] {
  const fm = content.match(/^---\n([\s\S]+?)\n---/)
  if (!fm) return []
  const body = fm[1]
  const asserts: Assert[] = []
  const lines = body.split('\n')
  let inAsserts = false
  let current: Partial<Assert> | null = null
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (/^asserts:\s*$/.test(line)) { inAsserts = true; continue }
    if (!inAsserts) continue
    if (/^[a-z]/.test(line)) { inAsserts = false; continue }
    const dashMatch = line.match(/^\s*-\s*symbol:\s*["']?([^"']+)["']?\s*$/)
    if (dashMatch) {
      if (current && current.symbol) asserts.push(current as Assert)
      current = { symbol: dashMatch[1] }
      continue
    }
    if (current) {
      const existsMatch = line.match(/^\s+exists:\s*(true|false)\s*$/)
      if (existsMatch) { current.exists = existsMatch[1] === 'true'; continue }
      const typeMatch = line.match(/^\s+type:\s*["']?([^"']+)["']?\s*$/)
      if (typeMatch) { current.type = typeMatch[1]; continue }
    }
  }
  if (current && current.symbol) asserts.push(current as Assert)
  return asserts
}

async function loadAdrsWithAsserts(config: AdrToolkitConfig): Promise<ADRWithAsserts[]> {
  const adrDir = path.join(config.rootDir, config.adrDir)
  let files: string[]
  try {
    files = await readdir(adrDir)
  } catch {
    return []
  }
  const out: ADRWithAsserts[] = []
  for (const f of files.sort()) {
    if (!/^\d{3}-/.test(f)) continue
    const filePath = path.join(adrDir, f)
    const content = await readFile(filePath, 'utf-8')
    const asserts = parseFrontmatter(content)
    if (asserts.length === 0) continue
    out.push({ num: f.slice(0, 3), filePath, asserts })
  }
  return out
}

function resolveSymbol(
  project: Project,
  ref: string,
  config: AdrToolkitConfig,
): { ok: boolean; reason?: string; typeText?: string } {
  const [modulePart, symbolName] = ref.split('#')
  if (!modulePart || !symbolName) {
    return { ok: false, reason: `format invalide '${ref}' (attendu: 'module#symbol')` }
  }

  // Essaie chaque entrée de srcDirs × {.ts, .tsx, /index.ts}
  let sourceFile = null
  let triedPaths: string[] = []
  for (const srcDir of config.srcDirs) {
    const candidates = [
      path.join(config.rootDir, srcDir, modulePart + '.ts'),
      path.join(config.rootDir, srcDir, modulePart + '.tsx'),
      path.join(config.rootDir, srcDir, modulePart, 'index.ts'),
    ]
    for (const c of candidates) {
      triedPaths.push(c)
      sourceFile = project.getSourceFile(c)
      if (sourceFile) break
      // Fallback : si le fichier existe sur disque mais pas dans le project,
      // l'ajouter (utile quand srcDirs n'est pas couvert par tsconfig include).
      if (fs.existsSync(c)) {
        sourceFile = project.addSourceFileAtPath(c)
        break
      }
    }
    if (sourceFile) break
  }

  if (!sourceFile) {
    return { ok: false, reason: `module '${modulePart}' introuvable (cherché dans ${config.srcDirs.join(', ')})` }
  }

  const decls: Node[] = [
    sourceFile.getVariableDeclaration(symbolName),
    sourceFile.getFunction(symbolName),
    sourceFile.getClass(symbolName),
    sourceFile.getInterface(symbolName),
    sourceFile.getTypeAlias(symbolName),
    sourceFile.getEnum(symbolName),
  ].filter((d) => d != null) as Node[]

  if (decls.length === 0) {
    return { ok: false, reason: `symbole '${symbolName}' non trouvé dans ${modulePart}` }
  }

  const decl = decls[0]!
  let typeText: string | undefined
  try {
    typeText = decl.getType().getText(decl, tsApi.TypeFormatFlags.NoTruncation)
  } catch {
    typeText = undefined
  }
  return { ok: true, typeText }
}

function typesEquivalent(actual: string, expected: string): boolean {
  const norm = (s: string) =>
    s.replace(/import\(["'][^"']+["']\)\./g, '').replace(/\s+/g, '')
  return norm(actual) === norm(expected)
}

export interface CheckAssertsOptions {
  config: AdrToolkitConfig
}

export async function checkAsserts(opts: CheckAssertsOptions): Promise<CheckAssertsResult> {
  const { config } = opts
  const adrs = await loadAdrsWithAsserts(config)
  if (adrs.length === 0) {
    return { total: 0, passed: 0, failed: 0, results: [] }
  }

  const tsconfigPath = path.join(config.rootDir, config.tsconfigPath)
  const project = new Project({
    tsConfigFilePath: tsconfigPath,
    skipAddingFilesFromTsConfig: false,
  })

  const results: CheckResult[] = []
  for (const adr of adrs) {
    for (const a of adr.asserts) {
      const r = resolveSymbol(project, a.symbol, config)
      if (!r.ok) {
        results.push({ adr: adr.num, symbol: a.symbol, ok: false, reason: r.reason })
        continue
      }
      if (a.exists === false) {
        results.push({ adr: adr.num, symbol: a.symbol, ok: false, reason: `attendu absent, mais le symbole existe` })
        continue
      }
      if (a.type !== undefined) {
        if (!r.typeText) {
          results.push({ adr: adr.num, symbol: a.symbol, ok: false, reason: `type non résolu` })
          continue
        }
        if (!typesEquivalent(r.typeText, a.type)) {
          results.push({
            adr: adr.num,
            symbol: a.symbol,
            ok: false,
            reason: `type drift — attendu '${a.type}', actuel '${r.typeText}'`,
          })
          continue
        }
      }
      results.push({ adr: adr.num, symbol: a.symbol, ok: true })
    }
  }

  const failed = results.filter(r => !r.ok).length
  return {
    total: results.length,
    passed: results.length - failed,
    failed,
    results,
  }
}
