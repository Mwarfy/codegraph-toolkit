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

// ─── AST: Rule ─────────────────────────────────────────────────────────────

/**
 * `Head(...) :- Body1(...), !Body2(...).`
 *
 * Invariant validé au parse : le head ne peut PAS être négé. Toutes les
 * variables du head DOIVENT apparaître dans au moins un body atom positif
 * (range-restricted). Les variables qui n'apparaissent QUE dans un body
 * négé sont rejetées (unsafe).
 */
export interface Rule {
  head: Atom
  body: Atom[]
  pos: SourcePos
  /**
   * Index stable assigné au parse (ordre d'apparition dans le source).
   * Utilisé pour le tri canonique au sein d'un stratum.
   */
  index: number
}

// ─── AST: Programme complet ────────────────────────────────────────────────

export interface Program {
  decls: Map<string, RelationDecl>
  rules: Rule[]
  /** Facts inline `Foo("a", 1).` parsés depuis le source `.dl` (rare). */
  inlineFacts: Atom[]
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
