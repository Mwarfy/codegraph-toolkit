// ADR-004: 3 rôles séparés (codegraph détecte / LLM rédige / humain valide)
/**
 * Détecteur de FSMs implicites — type unions de string literals avec suffixe
 * `Status` / `State` / `Phase` / `Stage`, cross-référencé avec les sites
 * où une de ces valeurs est écrite (object literal, direct assignment).
 *
 * Cas typique : `type BlockStatus = 'pending' | 'running' | 'completed' | 'failed'`
 * écrit via `block.status = 'running'` ou `{ status: 'pending' }` à plusieurs
 * endroits. Les transitions valides sont nulle part formalisées — un ADR
 * verrouille la liste des états + (en V2) les transitions.
 *
 * Heuristique en 4 étapes :
 *   1. Walk types/enums → filter sur suffix + literal-union check
 *   2. Extract values littérales
 *   3. Scan writes : object literals (`{ status: 'X' }`) + assignments (`obj.status = 'X'`)
 *   4. (V1) On capture le contexte fonction du write site, pas les transitions
 *
 * Les SQL UPDATE writes sont une extension future (réutiliser
 * `extractors/state-machines.ts` du codegraph).
 */

import * as path from 'node:path'
import {
  Project,
  SyntaxKind,
  Node,
  type TypeAliasDeclaration,
  type EnumDeclaration,
} from 'ts-morph'
import type { AdrToolkitConfig } from './config.js'
import type { PatternCandidate } from './bootstrap-types.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FsmWriteSite {
  /** Path relatif au rootDir */
  file: string
  /** Line number (1-indexed) */
  line: number
  /** Valeur littérale écrite */
  value: string
  /** Nom de la fonction englobante, si trouvable */
  trigger?: string
}

export interface FsmCandidate extends PatternCandidate {
  kind: 'fsm'
  /** Nom du type FSM (ex: BlockStatus) */
  fsmName: string
  /** Valeurs littérales détectées (ex: ['pending', 'running', 'completed', 'failed']) */
  values: string[]
  /** Sites où une valeur de la FSM est ÉCRITE */
  writeSites: FsmWriteSite[]
}

// ─── Heuristique ────────────────────────────────────────────────────────────

const DEFAULT_SUFFIXES = ['Status', 'State', 'Phase', 'Stage']

/** Property names typiques pour un write FSM (`status`, `state`, ...) */
const FSM_PROPERTY_NAMES = new Set(['status', 'state', 'phase', 'stage'])

interface DiscoveredFsm {
  /** Source file path (relatif au rootDir) */
  relativePath: string
  /** Source file path (absolu) */
  filePath: string
  /** Nom du type FSM */
  fsmName: string
  /** Valeurs littérales */
  values: string[]
  /** Line number de la déclaration */
  declLine: number
}

function hasSuffix(name: string, suffixes: string[]): boolean {
  return suffixes.some(s => name.endsWith(s))
}

/**
 * Vérifie si un TypeAliasDeclaration est une FSM-like : union de string
 * literals.
 *
 * Note : on lit le type RESOLU via `getType()` plutôt que la node syntactique
 * pour gérer les aliases (`type X = Y` où Y est lui-même une union).
 */
function extractFsmFromTypeAlias(node: TypeAliasDeclaration): { name: string; values: string[] } | null {
  const name = node.getName()
  if (!name) return null

  const type = node.getType()
  if (!type.isUnion()) return null

  const unionTypes = type.getUnionTypes()
  if (unionTypes.length === 0) return null

  // Toutes les variantes doivent être des string literals
  if (!unionTypes.every(t => t.isStringLiteral())) return null

  const values = unionTypes
    .map(t => t.getLiteralValue())
    .filter((v): v is string => typeof v === 'string')

  if (values.length === 0) return null
  return { name, values }
}

/**
 * Vérifie si un EnumDeclaration est une string-enum : tous les members ont
 * un initializer string literal.
 *
 * Skip volontaire : numeric enums (sans initializer ou avec number init).
 */
function extractFsmFromEnum(node: EnumDeclaration): { name: string; values: string[] } | null {
  const name = node.getName()
  if (!name) return null

  const members = node.getMembers()
  if (members.length === 0) return null

  const values: string[] = []
  for (const m of members) {
    const init = m.getInitializer()
    if (!init) return null  // numeric enum sans init → skip
    if (init.getKind() !== SyntaxKind.StringLiteral) return null
    values.push(init.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue())
  }
  return { name, values }
}

/**
 * Walk la node tree pour trouver les writes observables d'une FSM.
 *
 * Deux passes :
 *  - PropertyAssignment : `{ status: 'X' }` (object literals)
 *  - BinaryExpression =  : `obj.status = 'X'` (direct assignments)
 *
 * Le cross-référencement avec les valeurs FSM connues élimine les faux
 * positifs (ex: `{ status: 'ok' }` quand `'ok'` n'est pas dans la FSM).
 */
function findWriteSites(
  project: Project,
  fsmValues: Set<string>,
  rootDir: string,
): FsmWriteSite[] {
  const sites: FsmWriteSite[] = []

  for (const sf of project.getSourceFiles()) {
    const sfRelativePath = path.relative(rootDir, sf.getFilePath())

    // Pass A — object literal writes : { status: 'X' }
    for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      const rawName = pa.getName()
      // PropertyAssignment#getName() peut retourner avec quotes si key string
      const name = rawName.replace(/^['"]|['"]$/g, '')
      if (!FSM_PROPERTY_NAMES.has(name)) continue

      const init = pa.getInitializer()
      if (!init) continue
      if (init.getKind() !== SyntaxKind.StringLiteral) continue

      const value = init.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()
      if (!fsmValues.has(value)) continue

      sites.push({
        file: sfRelativePath,
        line: pa.getStartLineNumber(),
        value,
        trigger: enclosingFunctionName(pa) ?? undefined,
      })
    }

    // Pass B — direct assignments : obj.status = 'X'
    for (const ba of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (ba.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue
      const left = ba.getLeft()
      if (!Node.isPropertyAccessExpression(left)) continue
      if (!FSM_PROPERTY_NAMES.has(left.getName())) continue

      const right = ba.getRight()
      if (right.getKind() !== SyntaxKind.StringLiteral) continue
      const value = right.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue()
      if (!fsmValues.has(value)) continue

      sites.push({
        file: sfRelativePath,
        line: ba.getStartLineNumber(),
        value,
        trigger: enclosingFunctionName(ba) ?? undefined,
      })
    }
  }

  return sites
}

/**
 * Trouve le nom de la fonction englobante (FunctionDeclaration,
 * MethodDeclaration, ou ArrowFunction si bound to variable).
 *
 * Best-effort : si on ne trouve pas un nom, on retourne null. Pas critique
 * pour le détecteur — c'est juste un signal pour le LLM.
 */
function enclosingFunctionName(node: Node): string | null {
  const fn = node.getFirstAncestor(a =>
    Node.isFunctionDeclaration(a) ||
    Node.isMethodDeclaration(a) ||
    Node.isArrowFunction(a) ||
    Node.isFunctionExpression(a),
  )
  if (!fn) return null

  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName() ?? null
  }
  // Arrow / function expression assignée : remonter au VariableDeclaration parent
  const varDecl = fn.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)
  if (varDecl) return varDecl.getName()
  return null
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Détecte les FSMs implicites dans le code source.
 *
 * Sync (pas async) — ts-morph Project est synchrone. Charge files dans un
 * Project éphémère (pas partagé avec d'autres détecteurs en v1).
 *
 * @param config — toolkit config (rootDir + tsconfigPath)
 * @param files — paths relatifs au rootDir (filtré ts/tsx)
 * @param options.suffixes — surcharge la liste des suffixes (default: anglais)
 */
export function detectFsmCandidates(
  config: AdrToolkitConfig,
  files: string[],
  options: { suffixes?: string[] } = {},
): FsmCandidate[] {
  const suffixes = options.suffixes ?? DEFAULT_SUFFIXES

  // Étape 0 — charger les fichiers dans un Project ts-morph
  const project = new Project({
    tsConfigFilePath: config.tsconfigPath
      ? path.join(config.rootDir, config.tsconfigPath)
      : undefined,
    skipAddingFilesFromTsConfig: true,  // on ajoute manuellement
    skipFileDependencyResolution: true,
  })
  for (const f of files) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue
    const full = path.join(config.rootDir, f)
    try {
      project.addSourceFileAtPath(full)
    } catch {
      // Fichier inexistant ou non-parsable, skip
    }
  }

  // Étape 1 — découvrir les types FSM-like
  const discovered: DiscoveredFsm[] = []
  for (const sf of project.getSourceFiles()) {
    const sfRel = path.relative(config.rootDir, sf.getFilePath())

    for (const ta of sf.getTypeAliases()) {
      if (!hasSuffix(ta.getName(), suffixes)) continue
      const fsm = extractFsmFromTypeAlias(ta)
      if (!fsm) continue
      discovered.push({
        relativePath: sfRel,
        filePath: sf.getFilePath(),
        fsmName: fsm.name,
        values: fsm.values,
        declLine: ta.getStartLineNumber(),
      })
    }

    for (const en of sf.getEnums()) {
      if (!hasSuffix(en.getName(), suffixes)) continue
      const fsm = extractFsmFromEnum(en)
      if (!fsm) continue
      discovered.push({
        relativePath: sfRel,
        filePath: sf.getFilePath(),
        fsmName: fsm.name,
        values: fsm.values,
        declLine: en.getStartLineNumber(),
      })
    }
  }

  if (discovered.length === 0) return []

  // Étape 2 — union de toutes les valeurs pour le scan writes
  const allValues = new Set<string>()
  for (const d of discovered) {
    for (const v of d.values) allValues.add(v)
  }

  // Étape 3 — scan writes (une seule passe, dispatch par valeur)
  const allSites = findWriteSites(project, allValues, config.rootDir)

  // Étape 4 — assigner chaque write à sa FSM par valeur
  // Note : si 2 FSMs ont des valeurs qui se chevauchent (ex: 'pending'),
  // on attribue le write aux DEUX. C'est volontaire — le LLM tranchera.
  const candidates: FsmCandidate[] = []
  for (const d of discovered) {
    const valueSet = new Set(d.values)
    const writeSites = allSites.filter(s => valueSet.has(s.value))

    candidates.push({
      kind: 'fsm',
      filePath: d.filePath,
      relativePath: d.relativePath,
      evidence:
        `type ${d.fsmName} (line ${d.declLine}): [${d.values.join(' | ')}], ` +
        `${writeSites.length} write site(s)`,
      fsmName: d.fsmName,
      values: d.values,
      writeSites,
    })
  }

  return candidates
}
