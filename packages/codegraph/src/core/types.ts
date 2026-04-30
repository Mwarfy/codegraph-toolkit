// ADR-006
/**
 * CodeGraph Core Types — CANONICAL CONTRACT
 *
 * ⚠ Top hub (in:57+). Modifications conservatives uniquement.
 *
 * Cf. ADR-006 : pas de breaking change sans deprecation cycle. On
 * ajoute des champs optionnels, on ne supprime ni ne renomme. Tous les
 * types ici servent de ground-truth schema pour producers (extractors/)
 * + consumers (synopsis/, facts/, diff/, check/, incremental/) +
 * snapshot.json sérialisé (Sentinel, codegraph-mcp, hooks externes).
 *
 * Three consumers in mind :
 * 1. The CLI (analyze, diff, orphans)
 * 2. The web viewer (Cytoscape.js)
 * 3. An LLM that queries the snapshot JSON to understand the system
 *
 * Every type is serializable to JSON without transformation.
 */

// ─── Edge Types ──────────────────────────────────────────────────────────────

export type EdgeType =
  | 'import'          // Static TS import/export
  | 'event'           // Event-bus emit → listen
  | 'route'           // HTTP route backend ↔ frontend fetch
  | 'queue'           // BullMQ queue.add → worker.process
  | 'dynamic-load'    // Dynamic import() or constructor map lookup
  | 'db-table'        // Implicit coupling via shared DB table access

// ─── Node Types ──────────────────────────────────────────────────────────────

export type NodeType =
  | 'file'            // A source file
  | 'directory'       // A directory (compound/parent node for clustering)

export type NodeStatus =
  | 'connected'       // Has at least one incoming edge (someone uses this)
  | 'orphan'          // Zero incoming edges, not an entry point
  | 'entry-point'     // Explicitly marked as a root (main.ts, server.ts, route handlers)
  | 'uncertain'       // Has only dynamic/unresolved incoming links

// ─── Graph Node ──────────────────────────────────────────────────────────────

export interface GraphNode {
  /** Unique identifier — relative path from project root (e.g., "src/kernel/event-bus.ts") */
  id: string

  /** Human-readable label (filename without path, or directory name) */
  label: string

  /** Node type */
  type: NodeType

  /** Connection status — computed by orphan detector */
  status: NodeStatus

  /** Parent directory node ID (for compound/cluster grouping) */
  parent?: string

  /** Tags for filtering (e.g., ["block", "kernel"], ["api", "route"]) */
  tags: string[]

  /** Number of exports (for file nodes) */
  exportCount?: number

  /** Lines of code (for sizing nodes) */
  loc?: number

  /** Exported symbols with usage info (populated by unused-exports detector) */
  exports?: ExportSymbol[]

  /** Metadata — extensible per detector */
  meta?: Record<string, unknown>
}

// ─── Export Symbol (function-level granularity) ─────────────────────────────

/**
 * Confidence level for whether an unused export is truly dead code.
 *
 * - safe-to-remove: Zero usage in source AND tests AND no dynamic references. Can delete.
 * - test-only: Not imported by source files, but imported by test files. Keep unless removing the test.
 * - possibly-dynamic: Symbol name appears in dynamic patterns (string lookups, TOOL_SCHEMAS, etc.). Needs manual check.
 * - local-only: Exported but only referenced within the same file. Remove `export` keyword, keep the symbol.
 * - used: Imported by at least one source file. Not dead.
 */
export type ExportConfidence =
  | 'safe-to-remove'
  | 'test-only'
  | 'possibly-dynamic'
  | 'local-only'
  | 'used'

export interface ExportSymbol {
  /** Symbol name (function, class, const, type, etc.) */
  name: string

  /** What kind of export */
  kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum' | 'variable' | 'default' | 'other'

  /** Line number of the export declaration */
  line: number

  /** How many files import this specific symbol (0 = unused) */
  usageCount: number

  /** Which files import this symbol */
  usedBy?: string[]

  /** Is this a re-export from another module? */
  reExport?: boolean

  /** Confidence that this export is truly dead code */
  confidence?: ExportConfidence

  /** Human-readable reason for the confidence classification */
  reason?: string
}

// ─── Graph Edge ──────────────────────────────────────────────────────────────

export interface GraphEdge {
  /** Unique edge ID (auto-generated: `${from}--${type}--${to}`) */
  id: string

  /** Source node ID */
  from: string

  /** Target node ID */
  to: string

  /** Link type */
  type: EdgeType

  /** Human-readable label (e.g., event name "product.found", route "/api/health") */
  label?: string

  /** Is this link resolved with certainty or inferred? */
  resolved: boolean

  /** Source line number in the `from` file */
  line?: number

  /** Extra metadata per detector */
  meta?: Record<string, unknown>
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

export interface GraphSnapshot {
  /** Schema version for forward compatibility */
  version: '1'

  /** When this snapshot was generated */
  generatedAt: string

  /** Git commit hash (if in a git repo) */
  commitHash?: string

  /** Git commit message */
  commitMessage?: string

  /** Absolute root directory that was analyzed */
  rootDir: string

  /** All nodes in the graph */
  nodes: GraphNode[]

  /** All edges in the graph */
  edges: GraphEdge[]

  /** Summary statistics */
  stats: GraphStats

  /**
   * Symbol-level references (function → function edges).
   * Chaque edge : { from: "file:symbol", to: "file:symbol", line }.
   * Utilisé par le PageRank symbol-level et par codegraph_symbol mode references.
   * Optionnel : snapshots antérieurs n'en ont pas.
   */
  symbolRefs?: SymbolRefEdge[]

  /**
   * Structural Map — typed call graph (phase 1.2 du PLAN.md).
   * Signatures d'exports + call edges avec types aux sites d'appel.
   * Fondation des extracteurs de flux / cycles / FSM / truth-points.
   * Optionnel : snapshots antérieurs ou détecteur désactivé n'en ont pas.
   */
  typedCalls?: TypedCalls

  /**
   * Structural Map — cycles détectés (phase 1.3 du PLAN.md).
   * Tarjan SCC sur graphe combiné (import + event + queue + dynamic-load).
   * Chaque cycle porte son statut `gated` (au moins un gate détecté dans la
   * boucle). Les cycles non-gated sont des zones de divergence potentielle
   * pour un agent autonome. Optionnel.
   */
  cycles?: Cycle[]

  /**
   * Structural Map — truth points (phase 1.4 du PLAN.md).
   * Pour chaque concept de donnée partagée : où est sa vérité (table
   * canonique), ses miroirs (redis/memory), ses écrivains, ses lecteurs,
   * ses points d'exposition. Optionnel.
   */
  truthPoints?: TruthPoint[]

  /**
   * Structural Map — data flows (phase 1.5 du PLAN.md).
   * Pour chaque entry-point (route HTTP, event listener, tool MCP), la
   * trajectoire : steps (BFS via typedCalls) + sinks (db-write, event-emit,
   * http-response, bullmq-enqueue). Chaînage downstream 1 niveau pour les
   * sinks event. Optionnel — dépend de typedCalls.
   */
  dataFlows?: DataFlow[]

  /**
   * Structural Map — state machines (phase 1.6 du PLAN.md).
   * Enums et unions de littéraux avec suffixe Status/State/Phase/Stage +
   * transitions observées dans les writes (SQL SET + object literals).
   * Chaque transition porte son trigger (event listener / HTTP route / init).
   * Optionnel.
   */
  stateMachines?: StateMachine[]

  /**
   * Structural Map — env var usage (phase 3.6 B.5).
   * Pour chaque variable d'environnement lue (`process.env.NAME`), liste les
   * readers (file, symbol, line, hasDefault). Marque heuristiquement les
   * noms « secret-like » (contiennent KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL).
   * Utile pour : comprendre la config distribuée, détecter les envs non
   * documentés, repérer les secrets lus sans défaut de fallback. Optionnel.
   */
  envUsage?: EnvVarUsage[]

  /**
   * Structural Map — module-level metrics (phase 3.7 #5 + #6).
   * Pour chaque fichier : PageRank (import subgraph), fan-in / fan-out,
   * complexité Henry-Kafura `(fanIn × fanOut)² × loc`. Signale les hubs
   * critiques (haut PageRank) et les god-modules (haut Henry-Kafura). Optionnel.
   */
  moduleMetrics?: ModuleMetrics[]

  /**
   * Structural Map — component (folder-level) metrics (phase 3.7 #2).
   * Instability / Abstractness / Distance (Robert Martin, 1994). Une ligne
   * par dossier à la granularité configurée. Permet de voir d'un coup d'œil
   * les « zones of pain » (stable + concrete) et « zones of uselessness »
   * (instable + abstrait). Optionnel.
   */
  componentMetrics?: ComponentMetrics[]

  /**
   * Structural Map — Taint analysis (phase 3.8 #3).
   * Flux source non-trusté → sink dangereux sans passage par un sanitizer
   * déclaré. Analyse intra-fonction v1. Optionnel — désactivé par default
   * si aucun `taint-rules.json` n'est présent.
   */
  taintViolations?: TaintViolation[]

  /**
   * Structural Map — Dependency Structure Matrix (phase 3.8 #4).
   * DSM précalculé à la granularité `container` (premiers N segments du chemin),
   * edges `import` uniquement. Signal architectural de haut niveau : SCCs
   * visibles sous forme de blocs + back-edges matérialisant les cycles.
   * Un DSM file-level est calculable via la CLI `codegraph dsm`. Optionnel.
   */
  dsm?: DsmResult

  /**
   * Structural Map — package.json deps hygiene (phase 3.8 #7).
   * Mismatches entre les imports externes observés dans le code et les
   * `dependencies` / `devDependencies` / `peerDependencies` déclarés dans
   * chaque `package.json` découvert (racine + sous-dossiers sans workspaces
   * complexes). Trois catégories : `declared-unused`, `missing`, `devOnly`.
   * Optionnel.
   */
  packageDeps?: PackageDepsIssue[]

  /**
   * Structural Map — barrel files à faible valeur (phase 3.8 #7).
   * Un fichier dont 100 % des statements sont des ré-exports (`export * from`
   * / `export { ... } from`). Si ses consumers < `threshold` (default 2),
   * il est flaggé `lowValue` — ré-export pass-through sans bénéfice concret.
   * Optionnel.
   */
  barrels?: BarrelInfo[]

  /**
   * Event emit sites — chaque appel `emit({ type: ... })` ou
   * `emitEvent({ type: ... })` (y compris les méthodes `bus.emit(...)`,
   * `this.emit(...)`) avec sa classification `literal | eventConstRef |
   * dynamic`. Source des facts Datalog `EmitsEventLiteral` / `EmitsEventConst`
   * pour les invariants ADR-017-style. Optionnel.
   */
  eventEmitSites?: EventEmitSite[]

  /**
   * OAuth scope string literals — strings matchant le pattern d'URL de
   * scope Google Auth (`https://www.googleapis.com/auth/...`). Source du
   * fact Datalog `OauthScopeLiteral` pour ADR-014 (registry typé). Optionnel.
   */
  oauthScopeLiterals?: OauthScopeLiteralRef[]

  /**
   * TODO/FIXME/HACK/XXX/NOTE markers — la dette assumée. Capture les
   * commentaires `// TODO: ...` etc. avec leur file + line + message.
   * Détectés via regex. Optionnel.
   */
  todos?: Array<{
    tag: 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'NOTE'
    message: string
    file: string
    line: number
  }>

  /**
   * Drift signals — patterns que l'agent crée plus que les humains.
   * 3 patterns V1 : excessive-optional-params, wrapper-superfluous,
   * todo-no-owner. Sert à RALENTIR l'agent au bon moment, pas à bloquer.
   * Source : `extractors/drift-patterns.ts` (Phase 4 axe 4). Optionnel.
   */
  driftSignals?: Array<{
    kind: 'excessive-optional-params' | 'wrapper-superfluous' | 'todo-no-owner'
    file: string
    line: number
    message: string
    severity: 1 | 2 | 3
    details?: Record<string, string | number | boolean>
  }>

  /**
   * Long functions — fonctions/méthodes au-delà d'un seuil LOC (default 100).
   * Complement de cyclomatic complexity : capture la verbosité brute (200
   * lignes séquentielles sans branches sont aussi candidats refactor).
   * Optionnel.
   */
  longFunctions?: Array<{
    file: string
    name: string
    line: number
    loc: number
    kind: 'function' | 'method' | 'arrow'
  }>

  /**
   * Magic numbers — littéraux numériques hardcodés dans des positions
   * suspectes (timeouts, thresholds, ratios, large ints en property/call
   * position). Candidats à migrer vers env-driven config (cf. ADR-019).
   * Optionnel.
   */
  magicNumbers?: Array<{
    file: string
    line: number
    value: string
    context: string
    category: 'timeout' | 'threshold' | 'ratio' | 'large-int' | 'other'
  }>

  /**
   * Test coverage structurel — pour chaque fichier source, liste les
   * tests qui le couvrent (par naming convention OU par import). Pas de
   * coverage runtime, juste la présence/absence d'un test associé.
   * Optionnel.
   */
  testCoverage?: {
    entries: Array<{
      sourceFile: string
      testFiles: string[]
      matchedBy: Array<'naming' | 'import'>
    }>
    totalSourceFiles: number
    coveredFiles: number
    uncoveredFiles: number
    coverageRatio: number
  }
  /**
   * Paires de fichiers fréquemment co-modifiés sur les N derniers
   * jours (default 90j). Source: `git log --name-only`. Filtre :
   * count >= 3, jaccard >= 0 (cf. CoChangeOptions).
   *
   * Cf. axe 2 du plan d'enrichissement.
   */
  coChangePairs?: Array<{
    from: string
    to: string
    count: number
    totalCommitsFrom: number
    totalCommitsTo: number
    jaccard: number
  }>
  /**
   * Schema SQL Postgres détecté à partir des migrations (`*.sql`).
   * Tables + colonnes + indexes + foreignKeys + dérivé fkWithoutIndex
   * (FKs sans index correspondant — risque DELETE CASCADE full scan).
   *
   * Cf. Phase 2 du plan d'enrichissement (docs/PHASE-2-SQL-DETECTOR-PLAN.md).
   */
  sqlSchema?: {
    tables: Array<{
      name: string
      file: string
      line: number
      columns: Array<{
        name: string
        type: string
        notNull: boolean
        isUnique: boolean
        isPrimaryKey: boolean
        foreignKey?: { toTable: string; toColumn: string }
        line: number
      }>
    }>
    indexes: Array<{
      name: string
      table: string
      firstColumn: string | null
      columns: string[]
      unique: boolean
      implicit: boolean
      file: string
      line: number
    }>
    foreignKeys: Array<{
      fromTable: string
      fromColumn: string
      toTable: string
      toColumn: string
      file: string
      line: number
    }>
    fkWithoutIndex: Array<{
      fromTable: string
      fromColumn: string
      toTable: string
      toColumn: string
      file: string
      line: number
    }>
  }
}

/** Re-export du type produit par `extractors/oauth-scope-literals`. */
export interface OauthScopeLiteralRef {
  file: string
  line: number
  scope: string
}

// ─── Event Emit Sites ──────────────────────────────────────────────────────

/**
 * Re-export du type produit par `extractors/event-emit-sites`. Conservé ici
 * pour que `GraphSnapshot` reste auto-portant côté types.
 */
export interface EventEmitSite {
  file: string
  line: number
  symbol: string
  callee: string
  isMethodCall: boolean
  receiver?: string
  kind: 'literal' | 'eventConstRef' | 'dynamic'
  literalValue?: string
  refExpression?: string
}

// ─── Module Metrics (structural map, phase 3.7) ────────────────────────────

// ─── Component Metrics (structural map, phase 3.7 #2) ──────────────────────

/**
 * Métriques Martin (Clean Architecture) au niveau composant (dossier).
 * Toutes déterministes — pure arithmétique sur le graphe d'imports.
 *
 * - Ca (afferent coupling)  = # fichiers HORS composant qui importent un
 *                             fichier DANS le composant.
 * - Ce (efferent coupling)  = # fichiers DANS le composant qui importent
 *                             un fichier HORS composant.
 * - I  (instability)        = Ce / (Ca + Ce), ∈ [0, 1].
 *                             0 = maximally stable (tout le monde dépend
 *                             de lui, il ne dépend de personne).
 *                             1 = maximally unstable (il dépend de tout,
 *                             personne ne dépend de lui).
 * - A  (abstractness)       = # exports abstraits / # exports totaux, ∈ [0, 1].
 *                             Abstract = interface | type | enum | abstract class.
 *                             Concrete = class non-abstract | function | const | variable.
 * - D  (distance from main  = |A + I − 1|, ∈ [0, 1].
 *       sequence)            Main sequence = la droite `A + I = 1` : soit
 *                             stable+abstract (A≈1,I≈0), soit instable+concret
 *                             (A≈0,I≈1). D ≈ 0 = équilibré. D ≈ 1 = soit
 *                             zone-of-pain (stable+concret, rigide à changer)
 *                             soit zone-of-uselessness (instable+abstract,
 *                             inutilisable).
 */
export interface ComponentMetrics {
  /** Chemin relatif du dossier (ex: `sentinel-core/src/kernel`). */
  component: string
  /** Nombre de fichiers dans le composant. */
  fileCount: number
  /** Exports totaux dans le composant (pour le calcul A). */
  exportCount: number
  /** Ca — afferent coupling. */
  ca: number
  /** Ce — efferent coupling. */
  ce: number
  /** I = Ce / (Ca + Ce), 0 si Ca+Ce=0. */
  instability: number
  /** A = abstract / total, 0 si total=0. */
  abstractness: number
  /** D = |A + I − 1|. */
  distance: number
}

export interface ModuleMetrics {
  /** Node id = relative file path. */
  file: string
  /** Nombre d'edges entrants (imports qui ciblent ce fichier). */
  fanIn: number
  /** Nombre d'edges sortants (imports que ce fichier fait). */
  fanOut: number
  /**
   * PageRank sur le subgraph des edges import uniquement, normalisé en
   * [0, 1]. Valeur absolue de PageRank (somme des scores = 1 avant
   * normalisation). Plus la valeur est haute, plus le module est
   * architecturalement critique.
   */
  pageRank: number
  /**
   * Henry-Kafura Information-Flow Complexity = `(fanIn × fanOut)² × loc`.
   * Identifie les god-modules : un fichier qui fan-in ET fan-out beaucoup
   * ET est long concentre la complexité. Très sensible — les ordres de
   * grandeur diffèrent entre modules ordinaires (< 1000) et hubs (> 100k).
   */
  henryKafura: number
  /** Lines of code (issu de GraphNode.loc si dispo, sinon 0). */
  loc: number
}

// ─── Env Var Usage (structural map, phase 3.6 B.5) ─────────────────────────

export interface EnvVarReader {
  file: string
  /** Fonction englobante ou '' si module-level. */
  symbol: string
  line: number
  /**
   * True si le site de lecture a un default via `??` / `||` / `??=`.
   * Signale une config tolérante. Absence de default = dépendance dure.
   */
  hasDefault: boolean
  /**
   * Nom de la fonction qui wrappe immédiatement le `process.env.X` :
   *   - 'parseInt'    → `parseInt(process.env.X, 10)`
   *   - 'parseFloat'  → `parseFloat(process.env.X)`
   *   - 'Number'      → `Number(process.env.X)`
   *   - 'envInt'      → `envInt('X', N)` — ce form n'est PAS un read direct,
   *                      capturé seulement quand on voit `process.env[X]`
   *                      EN ARG, pas via le resolver. Souvent absent.
   * Undefined si le read n'est pas l'argument direct d'un call. Le détecteur
   * remonte au parent immédiat — pas plus loin.
   *
   * Utile pour ADR-019 : `parseInt(process.env.X, 10)` est interdit hors
   * `shared/env.ts`. La rule Datalog filtre sur ce champ.
   */
  wrappedIn?: string
}

export interface EnvVarUsage {
  /** Nom de la variable (ex: 'DATABASE_URL', 'NODE_ENV'). */
  name: string
  readers: EnvVarReader[]
  /**
   * Heuristique : le nom contient `KEY`, `TOKEN`, `SECRET`, `PASSWORD`,
   * `CREDENTIAL`, `PRIVATE`, `API_KEY`, `DSN`. True = secret probable.
   * Approximation assumée — `API_URL` par ex. n'est pas un secret mais
   * passera par le filtre `*API*`. v1 accepte ce faux positif.
   */
  isSecret: boolean
}

// ─── Package Deps / Barrels (structural map, phase 3.8 #7) ─────────────────

/**
 * Quatre catégories de mismatch entre imports externes et `package.json` :
 *
 * - `declared-unused`    : déclaré dans deps/devDeps mais jamais importé dans
 *                          aucun fichier du scope. **Safe to remove.**
 * - `declared-runtime-asset` : déclaré, pas d'import statique, MAIS un fichier
 *                          du scope référence `node_modules/<pkg>/...` via un
 *                          path runtime (ex: `new URL('node_modules/p5/lib/p5.min.js',
 *                          import.meta.url)`, `readFile('node_modules/X/...')`).
 *                          **NE PAS uninstall** sans grep manuel.
 *                          Ajouté 2026-04-29 après cas vécu Sentinel : audit
 *                          codegraph DEP-UNUSED a fait uninstall p5, tous les
 *                          renders ont fail ENOENT en prod.
 * - `missing`            : importé mais absent de tous les blocs deps ; casse
 *                          le build en prod si npm install --omit=dev.
 * - `devOnly`            : importé uniquement depuis les fichiers de test
 *                          (`*.test.ts`, `*.spec.ts`, `tests/**`) mais déclaré
 *                          dans `dependencies` au lieu de `devDependencies`.
 *                          Pollue le bundle prod sans raison.
 */
export type PackageDepsIssueKind =
  | 'declared-unused'
  | 'declared-runtime-asset'
  | 'missing'
  | 'devOnly'

export interface PackageDepsIssue {
  kind: PackageDepsIssueKind
  /** Nom normalisé du package (ex: `lodash`, `@types/node`, `@scope/pkg`). */
  packageName: string
  /** `package.json` de rattachement (relatif à rootDir). */
  packageJson: string
  /** Fichiers (relatifs à rootDir) qui importent le package. Vide pour declared-unused. */
  importers: string[]
  /** Fichiers tests parmi `importers`. Renseigné uniquement pour `devOnly`. */
  testImporters?: string[]
  /** Bloc dans lequel le package est déclaré, s'il existe. */
  declaredIn?: 'dependencies' | 'devDependencies' | 'peerDependencies'
  /** Fichiers où un usage runtime asset a été détecté (pour declared-runtime-asset). */
  runtimeAssetReferences?: string[]
}

// ─── Taint Analysis (structural map, phase 3.8 #3) ─────────────────────────

/**
 * Pattern de matching pour une règle de taint. Trois formes supportées v1 :
 *
 *   - `property-access` : chaîne d'accès à partir d'un identifier root.
 *     `path: ['req', 'body']` matche `req.body`, `req.body.foo`, `req.body[0]`.
 *     Utilisé pour sources (`req.body`, `process.env`, etc.).
 *
 *   - `call` : appel à une fonction libre dont l'identifier matche `name`.
 *     Matche `eval(x)`, `execSync(x)`. Utilisé pour sinks/sanitizers.
 *
 *   - `method-call` : appel à une méthode dont le nom final matche `methodName`.
 *     Matche `z.parse(x)`, `db.query(x)`. Utile pour sanitizers zod ou sinks SQL.
 */
export type TaintPattern =
  | { kind: 'property-access'; path: string[] }
  | { kind: 'call'; name: string }
  | { kind: 'method-call'; methodName: string }

export type TaintSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface TaintRule {
  /** Identifiant humain stable (ex: 'http-body', 'eval', 'zod-parse'). */
  name: string
  pattern: TaintPattern
  /** Applicable aux sinks. Ignoré pour sources/sanitizers. */
  severity?: TaintSeverity
}

export interface TaintRules {
  sources: TaintRule[]
  sinks: TaintRule[]
  sanitizers: TaintRule[]
}

/**
 * Un maillon de la chaîne source → sink reconstituée pour un violation.
 */
export interface TaintChainStep {
  kind: 'source' | 'propagate' | 'sink'
  file: string
  line: number
  /** Texte humain : `const body = req.body`, `danger(body)`, etc. Tronqué à ~80 char. */
  detail: string
}

export interface TaintViolation {
  /** Nom de la règle source qui a introduit le taint (ex: `http-body`). */
  sourceName: string
  /** Nom de la règle sink qui a reçu le taint (ex: `eval`). */
  sinkName: string
  severity: TaintSeverity
  /** Fichier du sink (lieu de la violation). */
  file: string
  /** Ligne exacte du call sink. */
  line: number
  /** Fonction englobante du sink. '' si module-level. */
  symbol: string
  /** Trace : source(s) → propagations intermédiaires → sink. */
  chain: TaintChainStep[]
}

// ─── DSM (structural map, phase 3.8 #4) ────────────────────────────────────

/**
 * Dependency Structure Matrix. Partition des nodes en SCCs via Tarjan puis
 * tri topologique du DAG condensé. Chaque nœud prend sa place dans un ordre
 * stable où :
 *   - les edges « forward » (matrix[i][j] avec i < j) représentent des
 *     dépendances saines ;
 *   - les edges « back-edge » (matrix[i][j] avec i > j) marquent un cycle —
 *     impossible en DAG pur, visible comme une entrée sous la diagonale.
 *
 * `levels` groupe les nodes par SCC d'appartenance (taille 1 en DAG pur,
 * taille ≥ 2 pour une boucle) dans l'ordre topologique condensé.
 *
 * Format matrice : `matrix[i][j] = 1` ssi `order[i]` importe `order[j]`.
 * Taille dense O(N²). Acceptable tant que N < quelques centaines. Au-delà
 * (ex: file-level sur gros repos), préférer la granularité container.
 */
export interface DsmResult {
  /** Ordre global des nodes. `order.length` = taille de la matrice. */
  order: string[]
  /** Chaque élément = une SCC (membres tri alpha), SCCs en ordre topo. */
  levels: string[][]
  /** matrix[i][j] ∈ {0, 1}. Carré, côté = `order.length`. */
  matrix: number[][]
  /** Edges tq fromIdx > toIdx (sous-diagonale) — signature des cycles. */
  backEdges: Array<{ from: string; to: string; fromIdx: number; toIdx: number }>
}

/**
 * Un fichier barrel : 100 % de ses statements sont des ré-exports
 * (`export * from '...'` ou `export { ... } from '...'`). La v1 se limite
 * à la forme « ré-exports seulement » — un fichier qui mélange ré-exports
 * et déclarations n'est pas un barrel.
 *
 * `lowValue` quand `consumers.length < threshold` (default 2) : le barrel
 * ne fait pas son travail d'agrégation, il est un pass-through.
 */
export interface BarrelInfo {
  /** Fichier barrel (relatif à rootDir). */
  file: string
  /** Nombre de ré-exports. */
  reExportCount: number
  /** Fichiers qui importent ce barrel (triés, dédupliqués). */
  consumers: string[]
  /** `consumers.length` (pratique pour les consumers programmatiques). */
  consumerCount: number
  /** True si `consumerCount < threshold` — barrel pass-through sans valeur. */
  lowValue: boolean
}

// ─── Typed Calls (structural map, phase 1.2) ────────────────────────────────

/**
 * Signature typée d'un symbole exporté (function / class / method / const fonction).
 * `kind` distingue ce que le symbole est au niveau déclaration.
 */
export interface TypedSignature {
  /** Fichier (relatif à rootDir) qui contient la déclaration. */
  file: string
  /** Nom du symbole exporté ("foo", "ClassName", "ClassName.method"). */
  exportName: string
  /** Catégorie de déclaration. */
  kind: 'function' | 'class' | 'method' | 'const'
  /** Paramètres positionnels avec type texte. */
  params: Array<{ name: string; type: string; optional: boolean }>
  /** Type de retour texte. "void" pour les constructors. */
  returnType: string
  /** Ligne de début de la déclaration. */
  line: number
}

/**
 * Edge de call typé entre deux symboles. `from`/`to` au format "file:symbolName".
 * `to` est non résolu si le symbole appelé n'est pas un export connu du graphe
 * (appel interne, appel externe) — dans ce cas l'edge est absent.
 */
export interface TypedCallEdge {
  /** "file:symbolName" — la fonction qui effectue l'appel. */
  from: string
  /** "file:symbolName" — l'export appelé. */
  to: string
  /** Types positionnels au site d'appel (getText() sur chaque argument). */
  argTypes: string[]
  /** Type consommé au retour (type du call expression). */
  returnType: string
  /** Ligne du call site dans le fichier de `from`. */
  line: number
}

export interface TypedCalls {
  signatures: TypedSignature[]
  callEdges: TypedCallEdge[]
}

// ─── State Machines (structural map, phase 1.6) ────────────────────────────

/**
 * Déclencheur d'une transition d'état.
 * - `event` : le write est dans une fonction listener d'un event bus.
 * - `route` : le write est dans un handler HTTP (path === / path.match).
 * - `cron`  : le write est dans une callback de scheduler (v1 non détecté).
 * - `init`  : le write est inconditionnel (constructor / initialisation).
 */
export interface StateTrigger {
  kind: 'event' | 'route' | 'cron' | 'init'
  /** Event name, route id ('METHOD /path'), cron name, ou '' pour init. */
  id: string
}

export interface StateTransition {
  /** État source si détectable ; '*' sinon (cas INSERT/write inconditionnel). */
  from: string | '*'
  /** État cible écrit. */
  to: string
  trigger: StateTrigger
  file: string
  line: number
}

export interface StateMachine {
  /**
   * Nom du concept — nom du type alias / enum (ex: `ProjectStatus`) ou
   * `<table>.<column>` pour les colonnes SQL sans type TS nommé.
   */
  concept: string
  /** États possibles extraits du type / enum. */
  states: string[]
  /** Transitions observées dans le code. Tri stable (trigger, file, line). */
  transitions: StateTransition[]
  /** États déclarés dans le concept mais jamais écrits. */
  orphanStates: string[]
  /**
   * États écrits mais sans transition sortante vers un autre état. v1 :
   * détecté quand l'état est uniquement en `to` d'une transition, jamais en
   * `from`. Bruit attendu vu qu'on a rarement `from != '*'` v1.
   */
  deadStates: string[]
  /**
   * Confidence de détection :
   *   - `'observed'`  : au moins une transition observée dans le code
   *     (`transitions.length > 0`). Le détecteur a vu le concept ET ses
   *     transitions — signal fiable.
   *   - `'declared-only'` : type/enum déclaré mais aucune transition
   *     observée. Soit la FSM est vraiment orpheline (à supprimer ?),
   *     soit le détecteur rate les writes pour cette FSM (bug à
   *     investiguer). Les consumers doivent traiter ce cas avec prudence.
   *
   * Cf. axe 4 du plan d'enrichissement post-Phase-C
   * (docs/ENRICHMENT-5-AXES-PLAN.md).
   */
  detectionConfidence: 'observed' | 'declared-only'
}

// ─── Cycles (structural map, phase 1.3) ─────────────────────────────────────

/**
 * Gate détecté dans un cycle — un call site vers une fonction dont le nom
 * matche un pattern de garde connu (`isAllowed`, `canExecute`, `peerReview`,
 * `checkTrust`, `guardrail*`). Signale qu'une transition dans la boucle est
 * conditionnée, ce qui réduit le risque de divergence autonome.
 */
export interface CycleGate {
  /** Fichier du cycle où le gate apparaît. */
  file: string
  /** Nom du symbole appelé (rightmost identifier du callee). */
  symbol: string
  /** Ligne du call site. */
  line: number
}

/**
 * Edge participant à un cycle — reprojection minimale d'un `GraphEdge` sans
 * les champs non nécessaires au consommateur du cycle.
 */
export interface CycleEdge {
  from: string
  to: string
  type: EdgeType
  label?: string
}

// ─── Truth Points (structural map, phase 1.4) ──────────────────────────────

/**
 * Un miroir d'un concept (redis ou cache in-memory).
 * `ttl` est capturé quand `redis.set(key, val, 'EX', <n>)` est utilisé ou
 * via `setex(...)`. Pour les caches memory, `ttl` est généralement absent.
 */
export interface TruthMirror {
  kind: 'redis' | 'memory'
  /** Clé/nom du mirror (template literal avec ${...} conservé tel quel). */
  key: string
  /** TTL en secondes si détectable (littéral numérique). */
  ttl?: string
  file: string
  line: number
}

/**
 * Référence typée vers une fonction/méthode qui touche le concept.
 * `symbol` est la fonction englobante si détectable ; sinon chaîne vide.
 */
export interface TruthRef {
  file: string
  symbol: string
  line: number
}

/**
 * Point d'exposition d'un concept vers l'extérieur.
 * - `function` : export `get*`/`find*`/`read*`/`list*` qui sert le concept.
 * - `route`    : route HTTP GET dans un fichier writer/reader (label = path).
 * - `mcp-tool` : tool MCP `sentinel_get_*` détecté par nom.
 */
export interface TruthExposure {
  kind: 'function' | 'route' | 'mcp-tool'
  /** Identifiant : nom de la fonction, path de la route, nom du tool. */
  id: string
  file?: string
  line?: number
}

/**
 * Un point de vérité — cartographie d'un concept de donnée partagée.
 * Concept = nom canonique (typiquement le nom de la table, ou un alias
 * explicite via `detectorOptions.truthPoints.conceptAliases`).
 * Un concept sans `canonical` est un signal : donnée en cache/memory
 * sans persistance (souvent non voulu).
 */
export interface TruthPoint {
  concept: string
  canonical?: { kind: 'table'; name: string }
  mirrors: TruthMirror[]
  writers: TruthRef[]
  readers: TruthRef[]
  exposed: TruthExposure[]
}

// ─── Data Flows (structural map, phase 1.5) ────────────────────────────────

/**
 * Type d'entry-point pour un data flow.
 * - `http-route` : pattern Sentinel `if (path === '/api/...' && method === 'X')`
 * - `event-listener` : `listen('event.name', handler)` ou `bus.on('...', h)`
 * - `mcp-tool` : export dans `mcp/tools/*.ts` (nom convention + handler)
 * - `bullmq-job` : `new Worker('queue', handler)` — v1 non détecté
 * - `cron` : `setInterval` / scheduler — v1 non détecté
 */
export type DataFlowEntryKind =
  | 'http-route'
  | 'event-listener'
  | 'mcp-tool'
  | 'bullmq-job'  // `new Worker('queue', handler)` BullMQ
  | 'cron'        // `cron.schedule(...)` node-cron (v1 non détecté)
  | 'interval'    // `setInterval(handler, ms)` / `setTimeout` module-level

export interface DataFlowEntry {
  kind: DataFlowEntryKind
  /** Identifiant lisible : "POST /api/approvals", "event:approval.resolved", etc. */
  id: string
  /** Fichier où l'entry-point est défini. */
  file: string
  /** Ligne du point d'entrée (déclaration du handler ou du match de route). */
  line: number
  /** "file:symbolName" de la fonction handler (undefined pour arrow anonymes). */
  handler?: string
}

/**
 * Un step dans la trajectoire BFS : un nœud de la chaîne d'appels typée.
 * `inputTypes` sont les types positionnels du call qui a amené ici ;
 * `outputType` est ce qui est retourné au précédent niveau.
 */
export interface DataFlowStep {
  /** "file:symbolName" de la fonction visitée. */
  node: string
  file: string
  symbol: string
  line: number
  /** Profondeur BFS (entry = 0). */
  depth: number
  /** Types des args au site d'appel qui a amené ici. Vide pour l'entry. */
  inputTypes: string[]
  /** Type consommé au retour. Vide pour l'entry. */
  outputType?: string
}

/**
 * Un sink dans le flow — le bout où la donnée "sort" du système.
 */
export interface DataFlowSink {
  kind: 'db-write' | 'event-emit' | 'http-response' | 'bullmq-enqueue' | 'mcp-return' | 'http-outbound'
  /**
   * Cible :
   *   - db-write          : nom de table (users, trust_scores, ...)
   *   - event-emit        : nom d'événement
   *   - http-response     : '' (rien à cibler)
   *   - bullmq-enqueue    : nom de queue
   *   - mcp-return        : '' (v1 non émis)
   *   - http-outbound     : host (api.github.com, ...) OU '<dynamic>' si URL
   *                         non-littéral OU module SDK ('googleapis', 'axios') si
   *                         détecté par client nommé.
   */
  target: string
  file: string
  line: number
  /** "file:symbolName" de la fonction dans laquelle le sink apparaît. */
  container: string
}

export interface DataFlow {
  entry: DataFlowEntry
  /** Type déclaré du premier paramètre du handler si détectable. */
  inputType?: string
  /** Steps BFS, ordonnés par ordre de visite (profondeur puis FIFO). */
  steps: DataFlowStep[]
  /** Sinks rencontrés dans les fonctions visitées, dédupliqués. */
  sinks: DataFlowSink[]
  /**
   * Flows déclenchés par les event-emit de ce flow. Niveau de chaînage
   * limité à 1 par default (configurable via `detectorOptions.dataFlows.downstreamDepth`).
   */
  downstream?: DataFlow[]
}

/**
 * Un cycle structurel — SCC de taille ≥ 2 dans le graphe combiné
 * (import + event + queue + dynamic-load). Le champ `nodes` contient UN
 * cycle concret extrait par DFS depuis le plus petit-id du SCC ; si la SCC
 * est plus grande que le path affiché, `sccSize` l'indique.
 */
export interface Cycle {
  /** Identifiant stable : hash des nodes triés (survit aux renommages d'edges). */
  id: string
  /** Path du cycle, ordonné : [a, b, c, ..., a] ; nodes[0] == nodes[nodes.length-1]. */
  nodes: string[]
  /** Edges effectivement traversés par le path. */
  edges: CycleEdge[]
  /** true si au moins un `CycleGate` est détecté dans un fichier du cycle. */
  gated: boolean
  /** Liste des gates détectés dans les fichiers du cycle (triés par file/line). */
  gates: CycleGate[]
  /** Nombre de nœuds dans le path affiché (nodes.length - 1, car dernier = premier). */
  size: number
  /** Taille de la SCC complète d'où le path est extrait. size ≤ sccSize. */
  sccSize: number
}

/**
 * Edge function→function produit par le détecteur symbol-refs.
 * Format "file:symbolName" pour from/to — symbolName peut être
 * "methodName" pour une function standalone ou "ClassName.methodName"
 * pour une méthode de classe.
 */
export interface SymbolRefEdge {
  /** "file:symbolName" — la fonction qui contient la référence. */
  from: string
  /** "file:symbolName" — l'export référencé. */
  to: string
  /** Ligne exacte dans le fichier source du from. */
  line: number
}

export interface GraphStats {
  totalFiles: number
  totalEdges: number
  orphanCount: number
  connectedCount: number
  entryPointCount: number
  uncertainCount: number

  /** Edges broken down by type */
  edgesByType: Record<EdgeType, number>

  /** Health score: connectedCount / (totalFiles - entryPointCount) */
  healthScore: number
}

// ─── Diff ────────────────────────────────────────────────────────────────────

export interface SnapshotDiff {
  /** The two commits being compared */
  fromCommit?: string
  toCommit?: string

  /** Timestamp of diff generation */
  generatedAt: string

  /** Nodes added in the newer snapshot */
  addedNodes: GraphNode[]

  /** Nodes removed from the older snapshot */
  removedNodes: GraphNode[]

  /** Nodes present in both but with changed attributes */
  modifiedNodes: Array<{
    id: string
    before: Partial<GraphNode>
    after: Partial<GraphNode>
  }>

  /** Edges added */
  addedEdges: GraphEdge[]

  /** Edges removed */
  removedEdges: GraphEdge[]

  /** Nodes that became orphans (were connected, now orphan) */
  newOrphans: string[]

  /** Nodes that were orphans but are now connected */
  resolvedOrphans: string[]

  /** Summary */
  summary: {
    addedFiles: number
    removedFiles: number
    addedEdges: number
    removedEdges: number
    newOrphanCount: number
    resolvedOrphanCount: number
    healthBefore: number
    healthAfter: number
  }
}

// ─── Detector Interface ──────────────────────────────────────────────────────

/**
 * A Detector discovers links between files that go beyond static imports.
 * Each detector is responsible for one "layer" of the graph.
 */
export interface Detector {
  /** Unique name (e.g., "ts-imports", "event-bus") */
  name: string

  /** What type of edges this detector produces */
  edgeType: EdgeType

  /** Human-readable description */
  description: string

  /**
   * Analyze files and return discovered edges.
   * The detector receives the list of all source file paths
   * and returns edges it found.
   */
  detect(context: DetectorContext): Promise<DetectedLink[]>
}

export interface DetectorContext {
  /** Absolute path to the project root */
  rootDir: string

  /** All source file paths (relative to rootDir) */
  files: string[]

  /** Read a file's content (cached) */
  readFile(relativePath: string): Promise<string>

  /** Get the ts-morph SourceFile for a path (only for TS detectors) */
  getSourceFile?(relativePath: string): unknown

  /**
   * Tsconfig path from the codegraph config (relative to rootDir or absolute).
   * Detectors that need ts-morph alias resolution should use this in priority
   * over hardcoded fallbacks. Optional — fallback aux conventions standards.
   */
  tsconfigPath?: string
}

export interface DetectedLink {
  from: string
  to: string
  type: EdgeType
  label?: string
  resolved: boolean
  line?: number
  meta?: Record<string, unknown>
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface CodeGraphConfig {
  /** Project root directory (absolute) */
  rootDir: string

  /** Glob patterns for files to analyze (relative to rootDir) */
  include: string[]

  /** Glob patterns to exclude */
  exclude: string[]

  /** Entry point patterns — files matching these are never flagged as orphans */
  entryPoints: string[]

  /** Which detectors to run */
  detectors: string[]

  /**
   * Path vers le tsconfig à utiliser pour résoudre les path aliases TS.
   * Relatif à rootDir ou absolu. Optional — fallback à `<rootDir>/tsconfig.json`.
   */
  tsconfigPath?: string

  /** Where to store snapshots */
  snapshotDir: string

  /** Max snapshots to keep */
  maxSnapshots: number

  /** Custom detector options per detector name */
  detectorOptions?: Record<string, Record<string, unknown>>

  /**
   * Rules pour `codegraph check` (phase 2). Mapping `ruleName → severity`.
   * Sévérités : `'error'` (exit non-zéro), `'warn'` (log only), `'off'`
   * (règle désactivée). Règles absentes = sévérité par défaut de la règle.
   */
  rules?: Record<string, 'error' | 'warn' | 'off'>

  /**
   * Concerns : regroupement de fichiers par préoccupation (ex: "video-chain",
   * "healer", "learning"). Chaque entrée = nom humain → liste de patterns de
   * préfixes de fichiers (pas de glob complet, juste startsWith). Surfacé dans
   * MAP.md section 0.5 pour accélérer l'orientation archi.
   *
   * Exemple :
   *   "concerns": {
   *     "video-chain": ["packs/llm-fanout/", "packs/visual-render/", "kernel/video-chain-orchestrator"],
   *     "learning":    ["kernel/learning/", "kernel/dimension-learner", "kernel/content-optimization-loop"]
   *   }
   */
  concerns?: Record<string, string[]>
}
