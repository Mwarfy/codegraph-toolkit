/**
 * Core types for the datalog interpreter.
 *
 * Le système est volontairement minimaliste : facts + règles non-récursives
 * (extension récursive bornée derrière un flag), négation stratifiée. Tout
 * ce qui n'est pas strictement nécessaire à exprimer un invariant ADR est
 * exclu (agrégats, choice, lattice, fonctions externes…).
 *
 * Déterminisme — invariants tenus à TOUS les niveaux :
 *   1. Les valeurs ne sont QUE 'string' ou 'number'. Pas de Date, pas
 *      d'object, pas de NaN/Infinity. Coercition stricte au load.
 *   2. Les tuples sont triés lex stable AVANT toute écriture (output, hash,
 *      proof). L'ordre d'insertion dans le moteur ne fuit pas.
 *   3. Le hash d'un tuple est `sha256(<rel>\x00<col1>\x00<col2>\x00...)`
 *      tronqué à 16 hex chars. Sert d'identifiant content-addressable
 *      stable entre runs.
 *   4. Les rules sont triées par (head.name, body.length, body[0].name…)
 *      au sein d'un stratum avant exécution.
 *   5. Les errors portent toutes line:col précis pour debug reproductible.
 */

// ─── Values ─────────────────────────────────────────────────────────────────

/**
 * Une valeur datalog. Strict : aucun autre type accepté côté runtime.
 * Le loader coerce les facts depuis TSV (`number` reconnu via /^-?\d+$/,
 * tout le reste est `string`).
 */
export type DatalogValue = string | number

// ─── AST: Term (= argument d'un atom) ──────────────────────────────────────

export type Term =
  | { kind: 'var'; name: string; pos: SourcePos }
  | { kind: 'const'; value: DatalogValue; pos: SourcePos }
  | { kind: 'wildcard'; pos: SourcePos } // `_`

// ─── AST: Atom (= prédicat appliqué) ───────────────────────────────────────

/**
 * `Foo(X, "bar", 42)` ou `!Foo(X, _)`.
 * `negated=true` n'est valide qu'en body d'une rule.
 */
export interface Atom {
  rel: string
  args: Term[]
  negated: boolean
  pos: SourcePos
}

// ─── AST: Declaration (= type d'une relation) ──────────────────────────────

export type ColumnType = 'symbol' | 'number'

export interface ColumnDecl {
  name: string
  type: ColumnType
  pos: SourcePos
}

export interface RelationDecl {
  name: string
  columns: ColumnDecl[]
  /** True ssi la relation est marquée `.input Rel` (chargée depuis facts). */
  isInput: boolean
  /** True ssi la relation est marquée `.output Rel` (sortie publique). */
  isOutput: boolean
  pos: SourcePos
}

// ─── AST: Constraint (Tier 15 — comparaison numérique) ────────────────────

/**
 * Contrainte numérique sur une variable bindée par le body positif.
 * Syntaxe : `Var > 5`, `N >= 10`, `Score < Threshold`, `X != 0`.
 *
 * Position dans le body source : peut apparaître n'importe où entre virgules,
 * mais à l'eval ces contraintes sont appliquées en post-filter après le
 * join des body atoms positifs (avant les négatifs). Sémantiquement
 * équivalent à inline.
 *
 * Range-restriction : toute variable d'une contrainte doit aussi apparaître
 * dans au moins un atom positif du body (sinon unbound — caught at parse).
 *
 * `=` n'est pas une contrainte mais une unification déjà gérée par le join.
 */
export type ConstraintOp = '>' | '<' | '>=' | '<=' | '!='

export interface Constraint {
  op: ConstraintOp
  left: Term
  right: Term
  pos: SourcePos
}

// ─── AST: Rule ─────────────────────────────────────────────────────────────

/**
 * `Head(...) :- Body1(...), !Body2(...), X > 5.`
 *
 * Invariant validé au parse : le head ne peut PAS être négé. Toutes les
 * variables du head DOIVENT apparaître dans au moins un body atom positif
 * (range-restricted). Les variables qui n'apparaissent QUE dans un body
 * négé sont rejetées (unsafe). Idem pour les variables de constraints.
 */
export interface Rule {
  head: Atom
  body: Atom[]
  /** Contraintes numériques (Tier 15). Évaluées en post-filter du join. */
  constraints?: Constraint[]
  pos: SourcePos
  /**
   * Index stable assigné au parse (ordre d'apparition dans le source).
   * Utilisé pour le tri canonique au sein d'un stratum.
   */
  index: number
}

// ─── AST: Aggregate definition (Tier 14 alt2) ─────────────────────────────

/**
 * Une aggregation déclarative.
 *
 * Syntaxe :
 *   `.count <Result>(<col1: type>, ..., <colN: type>) by <Source>(<args>)`
 *   `.sum   <Result>(<colsGroup>, <colTotal: number>) by <Source>(<args>)`
 *   `.min   <Result>(<colsGroup>, <colMin: number>)   by <Source>(<args>)`
 *   `.max   <Result>(<colsGroup>, <colMax: number>)   by <Source>(<args>)`
 *
 * Sémantique :
 *   - Les variables `X, Y, ...` dans les args du source pattern sont les
 *     colonnes de groupement (apparaissent dans le résultat).
 *   - Les `_` (wildcards) ne sont PAS clés — agrégés.
 *   - Pour `count` : la dernière colonne du résultat est l'arity du group.
 *   - Pour `sum/min/max` : la dernière col du résultat est l'agrégat sur
 *     la colonne du source désignée par la variable spéciale `V` (par
 *     convention nommée — toute variable qui apparaît dans le résultat à
 *     la dernière position est interprétée comme la "value column").
 *
 * Exemples :
 *   .count TruthPointsPerFile(file: symbol, count: number)
 *     by TruthPointWriter(_, file)
 *   // → pour chaque distinct file, count des rows TruthPointWriter
 *
 *   .sum TotalRefs(file: symbol, total: number)
 *     by ModuleFanIn(file, total)
 *   // → groupé par file (qui ne se répète pas), somme de la 2ème col
 *
 * Eval : exécuté en post-strates (les facts sont là, on agrège dessus).
 * Le résultat est inséré dans la DB et peut être consommé par d'autres
 * rules (via stratification implicite : aggregates produisent de nouveaux
 * facts, qui peuvent ensuite être utilisés).
 */
export interface AggregateDef {
  kind: 'count' | 'sum' | 'min' | 'max'
  resultRel: string
  /** Décl. de la rel résultat. La dernière col est numérique (l'agrégat). */
  resultDecl: RelationDecl
  /** Source à scanner. */
  sourceRel: string
  /**
   * Pattern matché contre les rows de sourceRel. Variables = clés de
   * groupement (par leur position dans le résultat). Wildcards = ignorés.
   */
  pattern: Term[]
  pos: SourcePos
}

// ─── AST: Programme complet ────────────────────────────────────────────────

export interface Program {
  decls: Map<string, RelationDecl>
  rules: Rule[]
  /** Facts inline `Foo("a", 1).` parsés depuis le source `.dl` (rare). */
  inlineFacts: Atom[]
  /** Aggregations (Tier 14 alt2 — count/sum/min/max post-strata). */
  aggregates?: AggregateDef[]
  /** Source path si chargé depuis disque, sinon undefined. */
  source?: string
}

// ─── Source position (pour errors lisibles) ────────────────────────────────

export interface SourcePos {
  /** 1-based. */
  line: number
  /** 1-based. */
  col: number
}

// ─── Runtime: Tuple ────────────────────────────────────────────────────────

/**
 * Un tuple = array de DatalogValue. Pas d'objet — array pour égalité
 * structurelle bon marché via JSON.stringify.
 */
export type Tuple = readonly DatalogValue[]

/**
 * Une relation matérialisée à un instant t.
 * `tuples` est dédupliqué par contenu (cf. `tupleKey`). Ordre d'insertion
 * est préservé pour le proof recording mais non garanti à l'output (cf.
 * `sortTuples`).
 */
export interface Relation {
  name: string
  arity: number
  tuples: Tuple[]
  /** Map(canonical key → tuple index dans `tuples`) pour dédup O(1). */
  index: Map<string, number>
}

// ─── Runtime: Database ─────────────────────────────────────────────────────

/**
 * État courant du moteur — facts initiaux + tuples dérivés par les rules.
 * Le runner construit incrémentalement la DB strate par strate.
 */
export interface Database {
  relations: Map<string, Relation>
}

// ─── Runtime: Proof ────────────────────────────────────────────────────────

/**
 * Comment un tuple a été dérivé. `kind:'fact'` = chargé en input. `kind:'rule'`
 * = produit par l'application d'une règle, avec les tuples body qui ont
 * déclenché la dérivation.
 *
 * Les proofs ne sont enregistrés QUE pour les relations marquées `.output`
 * (sinon le coût mémoire explose sur des récursions). Le récap exact des
 * relations enregistrées est dans `EvalOptions.recordProofsFor`.
 */
export type Provenance =
  | { kind: 'fact'; source: string }
  | {
      kind: 'rule'
      ruleIndex: number
      ruleHead: string
      bodyTuples: Array<{ rel: string; tuple: Tuple }>
    }

/**
 * Proof tree — un noeud par tuple, avec les enfants = les body tuples qui
 * l'ont produit (récursivement). Un fact n'a pas d'enfants.
 *
 * Le tree est construit on-demand par `buildProof(db, rel, tuple)` après
 * eval, en remontant via `provenance`.
 */
export interface ProofNode {
  rel: string
  tuple: Tuple
  /** Comment ce tuple a été obtenu. */
  via: Provenance
  /** Si via.kind='rule', les arbres des bodyTuples ; sinon vide. */
  children: ProofNode[]
}

// ─── Output ────────────────────────────────────────────────────────────────

/**
 * Résultat d'une exécution complète. `outputs` ne contient QUE les
 * relations `.output`. Tri lex sur les colonnes : déterministe.
 */
export interface RunResult {
  outputs: Map<string, Tuple[]>
  /** Stats utiles pour debugging — non normatives. */
  stats: {
    rulesExecuted: number
    tuplesProduced: number
    iterations: number
    /** ms wall-clock — à ignorer pour l'égalité byte. */
    elapsedMs: number
  }
  /** Map(rel → Map(tupleKey → ProofNode)). Présent uniquement pour les rels demandées. */
  proofs?: Map<string, Map<string, ProofNode>>
}

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * Toutes les erreurs du moteur étendent cette classe — porte une SourcePos
 * lisible et un code stable pour le filtrage côté caller.
 */
export class DatalogError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly pos?: SourcePos,
    public readonly source?: string,
  ) {
    super(message)
    this.name = 'DatalogError'
  }

  format(): string {
    const where = this.source && this.pos
      ? `${this.source}:${this.pos.line}:${this.pos.col}`
      : this.pos
        ? `${this.pos.line}:${this.pos.col}`
        : ''
    return where ? `[${this.code}] ${where} — ${this.message}` : `[${this.code}] ${this.message}`
  }
}
