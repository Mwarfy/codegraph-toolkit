/**
 * State Machines Extractor — structural map phase 1.6
 *
 * Extrait les machines à états implicites : enums TS et type aliases
 * d'unions de littéraux dont le nom matche `*Status|*State|*Phase|*Stage`.
 * Pour chaque concept, collecte les writes (SQL + object literals) et les
 * relie à leur trigger (listener, route, init).
 *
 * Heuristique v1 :
 *   - Concept = nom du type/enum avec suffixe.
 *   - États = valeurs littérales de l'union/enum (string values).
 *   - Writes :
 *     - SQL : `SET status = 'X'` (literal value only ; $n ignoré).
 *     - Object literals : `{ status: 'X' }` dans un objet, `obj.status = 'X'`.
 *     - Method calls : `this.updateStatus('X')`, `this.setPhase('Y')` — motifs
 *       `this.(update|set)<Field>(<string-literal>)` où Field est capitalisé.
 *       Le write est attribué au concept dont l'un des states matche la valeur.
 *   - Trigger :
 *     - La fonction englobante est-elle un listener ? (argument 2 de `listen(...)`)
 *       → trigger.kind = 'event', id = event name
 *     - Contient-elle un pattern HTTP route ? → trigger.kind = 'route', id = route
 *     - Sinon → trigger.kind = 'init'
 *
 * Limites v1 assumées :
 *   - Union types inline (`status: 'a' | 'b'` dans une interface) non nommés
 *     ne sont pas extraits — seuls les type aliases nommés le sont.
 *   - Parameterized SQL ($1, $2) : la valeur du state est dynamique, on skip.
 *   - Writes en dehors d'une fonction (module level) : trigger = 'init'.
 *   - Le matching concept ↔ write utilise la valeur cible (cible ∈ states).
 *     Si deux concepts partagent des valeurs, le premier (par ordre stable)
 *     gagne. Cas rare en pratique.
 */

import { Project, SyntaxKind, type SourceFile, type Node, type TypeAliasDeclaration, type EnumDeclaration } from 'ts-morph'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type {
  StateMachine,
  StateTransition,
  StateTrigger,
} from '../core/types.js'

const DEFAULT_SUFFIXES = ['Status', 'State', 'Phase', 'Stage']

export interface StateMachinesOptions {
  suffixes?: string[]
  /** Noms de fonctions de `listen`. Default : listen, on. */
  listenFnNames?: string[]
  /**
   * Globs (relatifs à `rootDir`) des fichiers SQL à scanner pour les
   * DEFAULT de colonnes. Default : `['**\/*.sql']`. `null` → désactive
   * le scan SQL schema.
   */
  sqlGlobs?: string[] | null
}

interface StateConcept {
  name: string
  states: string[]
  file: string
  line: number
}

interface WriteSignal {
  value: string
  field?: string
  file: string
  line: number
  container: string  // "file:function"
}

interface FnRange {
  start: number
  end: number
  name: string
}

interface TriggerContext {
  /** Listeners : container → event name. */
  listenerTrigger: Map<string, string>
  /** Routes : container → liste de 'METHOD path' gérées. */
  routeTriggers: Map<string, string[]>
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function analyzeStateMachines(
  rootDir: string,
  files: string[],
  project: Project,
  options: StateMachinesOptions = {},
): Promise<StateMachine[]> {
  const suffixes = options.suffixes ?? DEFAULT_SUFFIXES
  const listenFns = new Set(options.listenFnNames ?? ['listen', 'on'])
  const fileSet = new Set(files)

  // ─── Pass 1 : concepts (type alias + enums avec suffixe) ────────────

  const concepts: StateConcept[] = []
  const conceptNames = new Set<string>()

  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue

    for (const ta of sf.getTypeAliases()) {
      const name = ta.getName()
      if (!hasSuffix(name, suffixes)) continue
      if (conceptNames.has(name)) continue  // dédup : re-export ou double déclaration.
      const states = extractUnionStates(ta)
      if (states.length === 0) continue
      conceptNames.add(name)
      concepts.push({ name, states, file: relPath, line: ta.getStartLineNumber() })
    }

    for (const en of sf.getEnums()) {
      const name = en.getName()
      if (!hasSuffix(name, suffixes)) continue
      if (conceptNames.has(name)) continue
      const states = extractEnumStates(en)
      if (states.length === 0) continue
      conceptNames.add(name)
      concepts.push({ name, states, file: relPath, line: en.getStartLineNumber() })
    }
  }

  if (concepts.length === 0) return []

  // Value → concept name (premier arrivé gagne en cas de conflit).
  const valueToConcept = new Map<string, string>()
  for (const c of concepts) {
    for (const s of c.states) {
      if (!valueToConcept.has(s)) valueToConcept.set(s, c.name)
    }
  }

  // ─── Pass 2 : fonction ranges + trigger contexts ────────────────────

  const fnRangesByFile = new Map<string, FnRange[]>()
  const triggerCtx: TriggerContext = {
    listenerTrigger: new Map(),
    routeTriggers: new Map(),
  }

  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue

    const ranges = collectFunctionRanges(sf)
    fnRangesByFile.set(relPath, ranges)

    detectListenerTriggers(sf, relPath, ranges, listenFns, triggerCtx.listenerTrigger)
    detectRouteTriggers(sf, relPath, ranges, triggerCtx.routeTriggers)
  }

  // ─── Pass 3 : writes ────────────────────────────────────────────────

  const writes: WriteSignal[] = []

  for (const sf of project.getSourceFiles()) {
    const relPath = relativize(sf.getFilePath(), rootDir)
    if (!relPath || !fileSet.has(relPath)) continue
    const ranges = fnRangesByFile.get(relPath)!

    scanSqlWrites(sf, relPath, ranges, writes)
    scanObjectWrites(sf, relPath, ranges, writes)
    scanMethodCallWrites(sf, relPath, ranges, writes)
    scanClassPropertyInitializers(sf, relPath, writes)
  }

  // ─── Pass 3b : SQL schema DEFAULT reading ───────────────────────────
  // Les colonnes PG `DEFAULT 'value'` sont des writes implicites à l'INSERT
  // (si la colonne n'est pas fournie). Sans ce pass, un state utilisé
  // uniquement via DEFAULT apparaît orphan (cas typique : `ProjectStatus.draft`
  // sur Sentinel — le default est `draft`, aucun INSERT ne le nomme).
  if (options.sqlGlobs !== null) {
    const sqlGlobs = options.sqlGlobs ?? ['**/*.sql']
    const sqlFiles = await discoverSqlFiles(rootDir, sqlGlobs)
    for (const sqlFile of sqlFiles) {
      try {
        const content = await fs.readFile(path.join(rootDir, sqlFile), 'utf-8')
        scanSqlColumnDefaults(content, sqlFile, writes)
      } catch {
        // Fichier illisible — skip silencieux (pas bloquant).
      }
    }
  }

  // ─── Pass 4 : build state machines ──────────────────────────────────

  const machines: StateMachine[] = []

  for (const c of concepts) {
    const stateSet = new Set(c.states)
    const relevant = writes.filter((w) => stateSet.has(w.value) && valueToConcept.get(w.value) === c.name)

    const transitions: StateTransition[] = relevant.map((w) => ({
      from: '*',
      to: w.value,
      trigger: resolveTrigger(w.container, triggerCtx),
      file: w.file,
      line: w.line,
    }))

    // Dédup : deux writes strictement identiques (même container, même value,
    // même line) ne créent qu'une transition.
    const seen = new Set<string>()
    const deduped: StateTransition[] = []
    for (const t of transitions) {
      const k = `${t.trigger.kind}|${t.trigger.id}|${t.to}|${t.file}|${t.line}`
      if (seen.has(k)) continue
      seen.add(k)
      deduped.push(t)
    }

    deduped.sort((a, b) => {
      if (a.trigger.kind !== b.trigger.kind) return a.trigger.kind < b.trigger.kind ? -1 : 1
      if (a.trigger.id !== b.trigger.id) return a.trigger.id < b.trigger.id ? -1 : 1
      if (a.to !== b.to) return a.to < b.to ? -1 : 1
      if (a.file !== b.file) return a.file < b.file ? -1 : 1
      return a.line - b.line
    })

    const writtenStates = new Set(deduped.map((t) => t.to))
    const orphanStates = c.states.filter((s) => !writtenStates.has(s))

    // Dead state : écrit (to) mais jamais "from" d'une transition. Comme v1
    // pose from='*', on détecte les états terminaux (écrits, pas lus dans
    // le champ from d'une transition). Calibré pour être utile : rare v1.
    const fromStates = new Set(deduped.filter((t) => t.from !== '*').map((t) => t.from as string))
    const deadStates = [...writtenStates].filter((s) => !fromStates.has(s) && fromStates.size > 0)

    machines.push({
      concept: c.name,
      states: c.states,
      transitions: deduped,
      orphanStates,
      deadStates,
    })
  }

  // Tri : concepts avec transitions d'abord, puis par nom.
  machines.sort((a, b) => {
    const ha = a.transitions.length > 0 ? 0 : 1
    const hb = b.transitions.length > 0 ? 0 : 1
    if (ha !== hb) return ha - hb
    return a.concept < b.concept ? -1 : a.concept > b.concept ? 1 : 0
  })

  return machines
}

// ─── Concept extraction ─────────────────────────────────────────────────────

function hasSuffix(name: string, suffixes: string[]): boolean {
  for (const s of suffixes) {
    if (name.endsWith(s) && name.length > s.length) return true
  }
  return false
}

function extractUnionStates(ta: TypeAliasDeclaration): string[] {
  const tn = ta.getTypeNode()
  if (!tn) return []
  if (tn.getKind() !== SyntaxKind.UnionType) return []
  const out: string[] = []
  for (const member of (tn as any).getTypeNodes?.() ?? []) {
    if (member.getKind() === SyntaxKind.LiteralType) {
      const literal = (member as any).getLiteral?.()
      if (literal?.getKind?.() === SyntaxKind.StringLiteral) {
        out.push(literal.getLiteralText())
      }
    }
  }
  return dedup(out)
}

function extractEnumStates(en: EnumDeclaration): string[] {
  const out: string[] = []
  for (const m of en.getMembers()) {
    const init = m.getInitializer()
    if (init && init.getKind() === SyntaxKind.StringLiteral) {
      out.push((init as any).getLiteralText())
    } else {
      // Enum sans initializer : on prend le nom du membre.
      out.push(m.getName())
    }
  }
  return dedup(out)
}

// ─── Function ranges ────────────────────────────────────────────────────────

function collectFunctionRanges(sf: SourceFile): FnRange[] {
  const ranges: FnRange[] = []

  for (const fd of sf.getFunctions()) {
    const name = fd.getName()
    if (!name) continue
    ranges.push({ start: fd.getStartLineNumber(), end: fd.getEndLineNumber(), name })
  }

  for (const cd of sf.getClasses()) {
    const className = cd.getName() ?? '<anonymous>'
    for (const m of cd.getMethods()) {
      ranges.push({
        start: m.getStartLineNumber(),
        end: m.getEndLineNumber(),
        name: `${className}.${m.getName()}`,
      })
    }
    const ctor = cd.getConstructors()[0]
    if (ctor) {
      ranges.push({
        start: ctor.getStartLineNumber(),
        end: ctor.getEndLineNumber(),
        name: `${className}.constructor`,
      })
    }
  }

  for (const vs of sf.getVariableStatements()) {
    for (const vd of vs.getDeclarations()) {
      const init = vd.getInitializer()
      if (!init) continue
      const k = init.getKind()
      if (k !== SyntaxKind.ArrowFunction && k !== SyntaxKind.FunctionExpression) continue
      ranges.push({
        start: vd.getStartLineNumber(),
        end: vd.getEndLineNumber(),
        name: vd.getName(),
      })
    }
  }

  ranges.sort((a, b) => (a.end - a.start) - (b.end - b.start))
  return ranges
}

function findContainerAtLine(ranges: FnRange[], line: number): string | null {
  for (const r of ranges) {
    if (line >= r.start && line <= r.end) return r.name
  }
  return null
}

// ─── Trigger detection ──────────────────────────────────────────────────────

function detectListenerTriggers(
  sf: SourceFile,
  file: string,
  _ranges: FnRange[],
  listenFns: Set<string>,
  out: Map<string, string>,
): void {
  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const expr = call.getExpression?.()
    if (!expr) return

    let method: string | undefined
    if (expr.getKind() === SyntaxKind.Identifier) {
      method = expr.getText()
    } else if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      method = expr.getName?.()
      // Filtre : le left side doit être "bus" / "events" / etc.
      const left = expr.getExpression?.()
      if (left?.getKind() === SyntaxKind.Identifier) {
        const leftName = left.getText().toLowerCase()
        if (!/bus|events?|emit|listen|signal/.test(leftName)) return
      } else {
        return
      }
    }
    if (!method || !listenFns.has(method)) return

    const args = call.getArguments?.() ?? []
    const eventName = extractLiteralString(args[0])
    if (!eventName) return

    let handlerArg = args[1]
    if (!handlerArg) return
    let hk = handlerArg.getKind?.()
    if (hk === SyntaxKind.AsExpression || hk === SyntaxKind.TypeAssertionExpression) {
      handlerArg = handlerArg.getExpression?.() ?? handlerArg
      hk = handlerArg.getKind?.()
    }

    if (hk === SyntaxKind.Identifier) {
      const handlerName = handlerArg.getText()
      out.set(`${file}:${handlerName}`, eventName)
    }
    // Arrows inline : on pourrait stocker le container = "<anon@line>" mais
    // les writes à l'intérieur sont rattachés au container inline, pas à un
    // nom. Pour v1 on traite tout ce qui est dans l'arrow comme 'init'.
  })
}

function detectRouteTriggers(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  out: Map<string, string[]>,
): void {
  const content = sf.getFullText()
  const patterns = [
    { re: /path\s*===\s*['"]([^'"]+)['"]\s*&&\s*method\s*===\s*['"]([A-Z]+)['"]/g, pathFirst: true },
    { re: /method\s*===\s*['"]([A-Z]+)['"]\s*&&\s*path\s*===\s*['"]([^'"]+)['"]/g, pathFirst: false },
  ]

  for (const { re, pathFirst } of patterns) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      const routePath = pathFirst ? match[1] : match[2]
      const method = pathFirst ? match[2] : match[1]
      const line = content.substring(0, match.index).split('\n').length
      const container = findContainerAtLine(ranges, line)
      if (!container) continue
      const key = `${file}:${container}`
      if (!out.has(key)) out.set(key, [])
      out.get(key)!.push(`${method} ${routePath}`)
    }
  }
}

function resolveTrigger(container: string, ctx: TriggerContext): StateTrigger {
  const evt = ctx.listenerTrigger.get(container)
  if (evt) return { kind: 'event', id: evt }
  const routes = ctx.routeTriggers.get(container)
  if (routes && routes.length > 0) {
    // Si un handler gère plusieurs routes (pattern Sentinel), on prend la
    // première stable alphabétiquement. Imparfait mais déterministe.
    const sorted = [...routes].sort()
    return { kind: 'route', id: sorted[0] }
  }
  return { kind: 'init', id: '' }
}

// ─── Write scanning ─────────────────────────────────────────────────────────

function scanSqlWrites(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  out: WriteSignal[],
): void {
  const content = sf.getFullText()

  // Pattern 1 : UPDATE ... SET <field> = '<value>' (literal).
  const setRe = /\bSET\s+(\w+)\s*=\s*'([^']+)'/gi
  setRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = setRe.exec(content)) !== null) {
    const field = m[1].toLowerCase()
    const value = m[2]
    const line = content.substring(0, m.index).split('\n').length
    const container = findContainerAtLine(ranges, line) ?? ''
    out.push({ field, value, file, line, container: `${file}:${container}` })
  }

  // Pattern 2 : INSERT INTO ... VALUES (...). Extrait toutes les valeurs
  // littérales dans la liste VALUES — le pairing champ→valeur exact est
  // imparfait v1 (positions), mais pour le matching state-machine on
  // n'a besoin que de la VALEUR (un concept matche une valeur).
  const insertRe = /\bINSERT\s+INTO\s+\w+[\s\S]{0,80}?VALUES\s*\(([\s\S]*?)\)/gi
  insertRe.lastIndex = 0
  while ((m = insertRe.exec(content)) !== null) {
    const valuesBody = m[1]
    const baseOffset = m.index + m[0].indexOf(valuesBody)
    const litRe = /'([^']+)'/g
    let vm: RegExpExecArray | null
    while ((vm = litRe.exec(valuesBody)) !== null) {
      const value = vm[1]
      const absIdx = baseOffset + vm.index
      const line = content.substring(0, absIdx).split('\n').length
      const container = findContainerAtLine(ranges, line) ?? ''
      out.push({ value, file, line, container: `${file}:${container}` })
    }
  }
}

function scanObjectWrites(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  out: WriteSignal[],
): void {
  // Pour chaque PropertyAssignment dont la valeur est un StringLiteral,
  // extraire field + value. Et pour chaque BinaryExpression `x.y = 'z'`.
  sf.forEachDescendant((node) => {
    const k = node.getKind()

    if (k === SyntaxKind.PropertyAssignment) {
      const pa = node as any
      const nameNode = pa.getNameNode?.()
      const init = pa.getInitializer?.()
      if (!nameNode || !init) return
      const field = nameNode.getText?.()?.replace(/['"]/g, '')
      if (!field) return
      const initKind = init.getKind?.()
      if (initKind !== SyntaxKind.StringLiteral && initKind !== SyntaxKind.NoSubstitutionTemplateLiteral) return
      const value = init.getLiteralText?.()
      if (!value) return
      const line = pa.getStartLineNumber?.() ?? 0
      const container = findContainerAtLine(ranges, line) ?? ''
      out.push({ field: field.toLowerCase(), value, file, line, container: `${file}:${container}` })
      return
    }

    if (k === SyntaxKind.BinaryExpression) {
      const be = node as any
      const op = be.getOperatorToken?.()
      if (op?.getKind?.() !== SyntaxKind.EqualsToken) return
      const left = be.getLeft?.()
      const right = be.getRight?.()
      if (!left || !right) return
      if (left.getKind?.() !== SyntaxKind.PropertyAccessExpression) return
      const field = left.getName?.()
      if (!field) return
      const rightKind = right.getKind?.()
      if (rightKind !== SyntaxKind.StringLiteral && rightKind !== SyntaxKind.NoSubstitutionTemplateLiteral) return
      const value = right.getLiteralText?.()
      if (!value) return
      const line = be.getStartLineNumber?.() ?? 0
      const container = findContainerAtLine(ranges, line) ?? ''
      out.push({ field: field.toLowerCase(), value, file, line, container: `${file}:${container}` })
    }
  })
}

// ─── SQL schema DEFAULT scanner (phase 3.6 #2) ──────────────────────────────

/**
 * Walk `rootDir` récursivement pour trouver les fichiers .sql matchant les
 * globs fournis. Implémentation minimaliste via `fs.readdir` récursif —
 * codegraph n'utilise pas de lib de glob dédiée pour les SQL (les TS
 * viennent par ts-morph).
 *
 * Exclus par défaut : node_modules/, .codegraph/, dist/ — éviter de scanner
 * les copies de schémas embarquées.
 */
async function discoverSqlFiles(rootDir: string, globs: string[]): Promise<string[]> {
  const SKIP_DIRS = new Set(['node_modules', '.codegraph', 'dist', '.git'])
  const out: string[] = []

  async function walk(dir: string, rel: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue
      const full = path.join(dir, ent.name)
      const relPath = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        await walk(full, relPath)
      } else if (ent.isFile() && ent.name.endsWith('.sql')) {
        // Pour l'instant les globs sont juste utilisés pour allumer/éteindre
        // le scan ; tout fichier .sql est accepté. Si besoin, étendre plus
        // tard vers un vrai glob matcher (minimatch).
        void globs
        out.push(relPath)
      }
    }
  }

  await walk(rootDir, '')
  out.sort()
  return out
}

/**
 * Parse les `CREATE TABLE` d'un fichier SQL et extrait les colonnes avec
 * `DEFAULT 'value'`. Pour chaque colonne-défaut, émet un `WriteSignal` avec :
 *   - field    = nom de colonne (lower)
 *   - value    = valeur littérale du DEFAULT
 *   - file     = chemin SQL relatif
 *   - line     = numéro de ligne approximatif (à partir du début du fichier)
 *   - container = `<sqlfile>:<tableName>.default` — tagué `init` par le
 *                 trigger resolver (pas de listener / pas de route).
 *
 * Le matching vers un concept FSM se fait ensuite par valeur (comme les
 * autres scans) : si `value ∈ concept.states`, c'est attribué.
 *
 * Limites v1 :
 *   - `ALTER TABLE ... ADD COLUMN ... DEFAULT 'X'` non couvert (rare).
 *   - DEFAULT avec function call (`NOW()`, `gen_random_uuid()`) : skip.
 *   - DEFAULT numérique ou NULL : skip (pas de state valide).
 */
function scanSqlColumnDefaults(content: string, file: string, out: WriteSignal[]): void {
  // Extract `CREATE TABLE [IF NOT EXISTS] <name> ( <body> );` blocks.
  const tableRe = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s*\(([\s\S]+?)\);/gi
  let tableMatch: RegExpExecArray | null
  while ((tableMatch = tableRe.exec(content)) !== null) {
    const tableName = tableMatch[1].toLowerCase()
    const body = tableMatch[2]
    const blockOffset = tableMatch.index

    // Per-column DEFAULT: `<name> <type> [qualifiers] DEFAULT '<value>'`.
    // On capture un nom et une valeur littérale quoted. NULL/NOW()/etc. ignorés.
    const colRe = /(?:^|,)\s*(\w+)\s+\w+(?:\s*\([^)]*\))?(?:\s+(?:NOT\s+NULL|UNIQUE|PRIMARY\s+KEY|REFERENCES\s+[^,]+))*\s+DEFAULT\s+'([^']+)'/gim
    let colMatch: RegExpExecArray | null
    while ((colMatch = colRe.exec(body)) !== null) {
      const colName = colMatch[1].toLowerCase()
      const defaultValue = colMatch[2]
      // Compute line number from absolute offset in the full content.
      const absOffset = blockOffset + (tableMatch[0].indexOf(body) ?? 0) + colMatch.index
      const line = content.slice(0, absOffset).split('\n').length
      out.push({
        field: colName,
        value: defaultValue,
        file,
        line,
        container: `${file}:${tableName}.default`,
      })
    }
  }
}

/**
 * Scan les initializers de propriétés de classe `<access> <name>: <Type> = 'literal'`.
 * L'init d'une propriété de classe est un write inconditionnel à l'instanciation
 * — assimilable à un `init` trigger au même titre qu'un `INSERT ... VALUES ('X')`.
 *
 * Motivation : fermer l'orphan résiduel `WorkerStatus.idle` dans la fixture
 * (`private status: WorkerStatus = 'idle'`) et les cas équivalents sur
 * Sentinel (classes de kernel qui initialisent un status par défaut).
 */
function scanClassPropertyInitializers(
  sf: SourceFile,
  file: string,
  out: WriteSignal[],
): void {
  for (const cd of sf.getClasses()) {
    const className = cd.getName() ?? '<anonymous>'
    for (const prop of cd.getProperties()) {
      const init = prop.getInitializer?.()
      if (!init) continue
      const value = extractLiteralString(init)
      if (!value) continue
      const name = prop.getName?.()
      if (!name) continue
      const line = prop.getStartLineNumber?.() ?? 0
      out.push({
        field: name.toLowerCase(),
        value,
        file,
        line,
        container: `${file}:${className}`,
      })
    }
  }
}

/**
 * Scan les call expressions `this.<method>(<string-literal>)` où `method`
 * matche `(update|set)<Field>` avec Field capitalisé. Le field est dérivé
 * du nom de méthode (ex: `updateStatus` → `status`) et le value est le
 * premier argument string.
 *
 * Motivation : fermer le faux négatif `BlockStatus.waiting_approval`
 * flagué orphan alors que `base-block.ts` fait bien
 * `this.updateStatus('waiting_approval')`. Les extracteurs v1 ne
 * voyaient que SQL + object literals + property assignments directs.
 *
 * Conservatisme — on exige :
 *   - LHS = `this` (pas de méthode sur un objet quelconque, sinon faux
 *     positifs sur des helpers utilitaires comme `setHeader`, `setCookie`)
 *   - Method name match strict `^(update|set)([A-Z][a-zA-Z]*)$`
 *   - Premier argument = StringLiteral (pas de variable, pas de template)
 */
function scanMethodCallWrites(
  sf: SourceFile,
  file: string,
  ranges: FnRange[],
  out: WriteSignal[],
): void {
  const METHOD_RE = /^(update|set)([A-Z][a-zA-Z]*)$/

  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return
    const call = node as any
    const expr = call.getExpression?.()
    if (!expr || expr.getKind() !== SyntaxKind.PropertyAccessExpression) return

    const left = expr.getExpression?.()
    if (!left || left.getKind() !== SyntaxKind.ThisKeyword) return

    const method = expr.getName?.()
    if (!method) return
    const m = METHOD_RE.exec(method)
    if (!m) return

    const args = call.getArguments?.() ?? []
    if (args.length === 0) return
    const value = extractLiteralString(args[0])
    if (!value) return

    const field = m[2].toLowerCase()
    const line = call.getStartLineNumber?.() ?? 0
    const container = findContainerAtLine(ranges, line) ?? ''
    out.push({ field, value, file, line, container: `${file}:${container}` })
  })
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractLiteralString(node: any): string | null {
  if (!node) return null
  const k = node.getKind?.()
  if (k === SyntaxKind.StringLiteral) return node.getLiteralText?.() ?? null
  if (k === SyntaxKind.NoSubstitutionTemplateLiteral) return node.getLiteralText?.() ?? null
  return null
}

function dedup<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

function relativize(absPath: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, absPath).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}
