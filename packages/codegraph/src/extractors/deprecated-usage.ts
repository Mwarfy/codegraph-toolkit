/**
 * Deprecated usage — détecteur déterministe AST + JSDoc (Phase 4 Tier 4).
 *
 * Capture les call-sites de symboles marqués `@deprecated` dans leur
 * JSDoc, ainsi que les imports de tels symboles.
 *
 * Pourquoi : un symbole tagué `@deprecated` annonce un retrait futur.
 * Sans détection automatique, le tag pourrit dans le JSDoc et personne
 * ne sait quel call site doit être migré. Inspiration : Go SA1019,
 * Pascal H2061, Java @Deprecated warning.
 *
 * Stratégie déterministe :
 *   1. Pass 1 : scanner toutes les déclarations exportées (function,
 *      method, class, const) pour tagger celles qui ont `@deprecated`
 *      dans leur JSDoc. Build un set des noms.
 *   2. Pass 2 : scanner les CallExpression / NewExpression. Pour chaque
 *      callee, si le nom matche un symbole deprecated → flagger.
 *
 * Best-effort sur le matching par nom seul (collisions possibles si
 * plusieurs symboles partagent le nom — trade-off acceptable V1).
 *
 * Convention exempt : `// deprecated-ok: <reason>` ligne précédente
 * (typique pour le code de migration qui consomme intentionnellement
 * l'ancien symbole pour piloter la transition).
 *
 * Skip fichiers test (call-sites souvent intentionnels en regression
 * tests).
 */

import { type Project, type SourceFile, Node, SyntaxKind } from 'ts-morph'
import { findContainingSymbol, makeIsExemptForMarker } from './_shared/ast-helpers.js'

export interface DeprecatedUsageSite {
  file: string
  line: number
  /** Nom du symbole deprecated appelé. */
  callee: string
  /** Le symbole englobant (function/method/arrow). */
  containingSymbol: string
}

export interface DeprecatedDeclaration {
  /** Nom exporté du symbole deprecated. */
  name: string
  /** File où le symbole est déclaré. */
  file: string
  line: number
  /** Le `@deprecated` reason (texte après le tag, premier ligne). */
  reason: string
}

export interface DeprecatedUsageFileBundle {
  declarations: DeprecatedDeclaration[]
  sites: DeprecatedUsageSite[]
}

const TEST_FILE_RE = /(\.test\.tsx?|\.spec\.tsx?|(^|\/)tests?\/|(^|\/)fixtures?\/)/

/**
 * Scanne un fichier en deux passes :
 *   - declarations[] : tous les exports avec `@deprecated`
 *   - sites[] : tous les call-sites qui matchent un symbole deprecated
 *     (provenant du SET global passé en argument, pas seulement de ce
 *     fichier — la deprecation est cross-fichier)
 */
export function extractDeprecatedUsageFileBundle(
  sf: SourceFile,
  relPath: string,
  globalDeprecatedNames: Set<string>,
): DeprecatedUsageFileBundle {
  const declarations: DeprecatedDeclaration[] = []
  const sites: DeprecatedUsageSite[] = []

  // ─── Pass 1 : detect declarations with @deprecated ────────────────
  const collectDecl = (
    name: string,
    line: number,
    jsDocs: ReadonlyArray<{ getTags(): ReadonlyArray<{ getTagName(): string; getCommentText(): string | undefined }> }>,
  ): void => {
    for (const doc of jsDocs) {
      for (const tag of doc.getTags()) {
        if (tag.getTagName() === 'deprecated') {
          const reason = (tag.getCommentText() ?? '').trim().split('\n')[0].slice(0, 120)
          declarations.push({ name, file: relPath, line, reason })
          return
        }
      }
    }
  }

  for (const fn of sf.getFunctions()) {
    const name = fn.getName()
    if (!name) continue
    collectDecl(name, fn.getStartLineNumber(), fn.getJsDocs())
  }
  for (const cls of sf.getClasses()) {
    const className = cls.getName() ?? '(anonymous)'
    collectDecl(className, cls.getStartLineNumber(), cls.getJsDocs())
    for (const method of cls.getMethods()) {
      collectDecl(`${className}.${method.getName()}`, method.getStartLineNumber(), method.getJsDocs())
    }
  }
  for (const v of sf.getVariableDeclarations()) {
    const name = v.getName()
    // Pour const/let/var : JSDoc est sur le VariableStatement parent.
    const stmt = v.getFirstAncestorByKind(SyntaxKind.VariableStatement)
    if (!stmt) continue
    collectDecl(name, v.getStartLineNumber(), (stmt as any).getJsDocs?.() ?? [])
  }

  // ─── Pass 2 : detect call-sites matching globalDeprecatedNames ────
  if (TEST_FILE_RE.test(relPath)) return { declarations, sites }

  const isExempt = makeIsExemptForMarker(sf, 'deprecated-ok')

  const checkCall = (calleeText: string | null, line: number, containingSymbol: string): void => {
    if (!calleeText) return
    if (!globalDeprecatedNames.has(calleeText)) return
    if (isExempt(line)) return
    sites.push({ file: relPath, line, callee: calleeText, containingSymbol })
  }

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression()
    let name: string | null = null
    if (Node.isIdentifier(callee)) name = callee.getText()
    else if (Node.isPropertyAccessExpression(callee)) name = callee.getName()
    checkCall(name, call.getStartLineNumber(), findContainingSymbol(call))
  }
  for (const newExpr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const callee = newExpr.getExpression()
    let name: string | null = null
    if (Node.isIdentifier(callee)) name = callee.getText()
    else if (Node.isPropertyAccessExpression(callee)) name = callee.getName()
    checkCall(name, newExpr.getStartLineNumber(), findContainingSymbol(newExpr))
  }

  return { declarations, sites }
}

/**
 * Aggregator : 2 passes globales.
 *   Pass 1 : collect toutes les declarations marquees deprecated par JSDoc.
 *   Pass 2 : avec le SET de noms deprecated, scanner les call-sites.
 */
export async function analyzeDeprecatedUsage(
  rootDir: string,
  files: string[],
  project: Project,
): Promise<{ declarations: DeprecatedDeclaration[]; sites: DeprecatedUsageSite[] }> {
  const fileSet = new Set(files)

  // Pass 1 : collect declarations.
  const allDeclarations: DeprecatedDeclaration[] = []
  for (const sf of project.getSourceFiles()) {
    const rel = relativize(sf.getFilePath(), rootDir)
    if (!rel || !fileSet.has(rel)) continue
    const bundle = extractDeprecatedUsageFileBundle(sf, rel, new Set())
    allDeclarations.push(...bundle.declarations)
  }

  // Build set des noms deprecated (best-effort par exportName seul ;
  // pour les méthodes Class.method, on indexe ALSO par juste method name
  // car les call-sites apparaissent comme `obj.method` → name = 'method').
  const deprecatedNames = new Set<string>()
  for (const d of allDeclarations) {
    deprecatedNames.add(d.name)
    const methodMatch = d.name.match(/\.([A-Za-z_][\w$]*)$/)
    if (methodMatch) deprecatedNames.add(methodMatch[1])
  }

  // Pass 2 : collect call-sites.
  const allSites: DeprecatedUsageSite[] = []
  if (deprecatedNames.size > 0) {
    for (const sf of project.getSourceFiles()) {
      const rel = relativize(sf.getFilePath(), rootDir)
      if (!rel || !fileSet.has(rel)) continue
      const bundle = extractDeprecatedUsageFileBundle(sf, rel, deprecatedNames)
      allSites.push(...bundle.sites)
    }
  }

  allDeclarations.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })
  allSites.sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1
    return a.line - b.line
  })

  return { declarations: allDeclarations, sites: allSites }
}

function relativize(absPath: string, rootDir: string): string | null {
  const normalized = absPath.replace(/\\/g, '/')
  const rootNormalized = rootDir.replace(/\\/g, '/')
  if (!normalized.startsWith(rootNormalized)) return null
  return normalized.slice(rootNormalized.length + 1)
}
