/**
 * Parser pour la syntaxe `.dl` — sous-ensemble compatible Soufflé.
 *
 * Grammaire supportée :
 *
 *   program     := (decl | rule | fact | comment)*
 *
 *   decl        := '.decl' RelName '(' columns ')' eol
 *                | '.input' RelName eol
 *                | '.output' RelName eol
 *
 *   columns     := column (',' column)*
 *   column      := Ident ':' ('symbol' | 'number')
 *
 *   rule        := atom ':-' body '.'
 *   body        := bodyAtom (',' bodyAtom)*
 *   bodyAtom    := atom | '!' atom | 'not' atom
 *
 *   fact        := atom '.'  // atom sans variables ni wildcards
 *
 *   atom        := RelName '(' arglist? ')'
 *   arglist     := arg (',' arg)*
 *   arg         := Variable | StringLit | NumberLit | Wildcard
 *
 *   StringLit   := '"' (escapes) '"'
 *   NumberLit   := '-'? digit+
 *   Variable    := [A-Z_] [A-Za-z0-9_]*
 *   RelName     := [A-Z] [A-Za-z0-9_]*
 *   Ident       := [a-zA-Z_] [A-Za-z0-9_]*
 *   Wildcard    := '_'
 *
 *   comment     := '//' to-eol | '/' '*' ... '*' '/'
 *
 * Décisions explicites :
 *   - Variable et RelName commencent par majuscule (Datalog classique).
 *     `_` est wildcard. `foo` n'est NI variable NI relation — erreur.
 *   - String escapes : \" \\ \n \t (les autres restent littéraux).
 *   - Pas de support pour les types autres que `symbol` / `number`.
 *   - Pas de `.printsize`, `.plan`, `.functor`, `.component` etc.
 *
 * Les errors portent toutes line:col précis. Aucun warning silencieux —
 * tout ce qui n'est pas reconnu fait échouer le parse.
 */

import {
  DatalogError,
  type Atom, type ColumnDecl, type ColumnType,
  type DatalogValue, type Program, type RelationDecl,
  type Rule, type SourcePos, type Term,
} from './types.js'

interface Token {
  kind:
    | 'dot' | 'comma' | 'colon' | 'lparen' | 'rparen' | 'minus'
    | 'turnstile'        // :-
    | 'bang'             // !
    | 'directive'        // .decl / .input / .output
    | 'string' | 'number' | 'ident' | 'kw_not' | 'underscore'
    | 'eof'
  value: string
  pos: SourcePos
}

// ─── Tokenizer ──────────────────────────────────────────────────────────────

class Lexer {
  private i = 0
  private line = 1
  private col = 1
  constructor(private readonly src: string, private readonly source?: string) {}

  private pos(): SourcePos {
    return { line: this.line, col: this.col }
  }

  private peek(off = 0): string {
    return this.src[this.i + off] ?? ''
  }

  private advance(): string {
    const c = this.src[this.i++]
    if (c === '\n') { this.line++; this.col = 1 }
    else { this.col++ }
    return c
  }

  private err(code: string, msg: string, pos: SourcePos): never {
    throw new DatalogError(code, msg, pos, this.source)
  }

  private skipWS(): void {
    while (this.i < this.src.length) {
      const c = this.peek()
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.advance()
        continue
      }
      if (c === '/' && this.peek(1) === '/') {
        while (this.i < this.src.length && this.peek() !== '\n') this.advance()
        continue
      }
      if (c === '/' && this.peek(1) === '*') {
        const startPos = this.pos()
        this.advance(); this.advance()
        while (this.i < this.src.length && !(this.peek() === '*' && this.peek(1) === '/')) {
          this.advance()
        }
        if (this.i >= this.src.length) {
          this.err('parse.unterminatedComment', 'block comment is not closed', startPos)
        }
        this.advance(); this.advance()
        continue
      }
      break
    }
  }

  private readString(): Token {
    const start = this.pos()
    this.advance()                                   // consume opening "
    let out = ''
    while (this.i < this.src.length && this.peek() !== '"') {
      const c = this.advance()
      if (c === '\\') {
        const next = this.advance()
        if (next === 'n') out += '\n'
        else if (next === 't') out += '\t'
        else if (next === '"') out += '"'
        else if (next === '\\') out += '\\'
        else this.err('parse.badEscape', `unknown escape \\${next}`, start)
      } else if (c === '\n') {
        this.err('parse.newlineInString', 'newline inside string literal', start)
      } else {
        out += c
      }
    }
    if (this.peek() !== '"') {
      this.err('parse.unterminatedString', 'string literal is not closed', start)
    }
    this.advance()                                   // consume closing "
    return { kind: 'string', value: out, pos: start }
  }

  private readNumber(): Token {
    const start = this.pos()
    let s = ''
    if (this.peek() === '-') s += this.advance()
    while (/[0-9]/.test(this.peek())) s += this.advance()
    if (s === '' || s === '-') {
      this.err('parse.badNumber', `expected digits, got '${this.peek()}'`, start)
    }
    return { kind: 'number', value: s, pos: start }
  }

  private readIdentOrKeyword(): Token {
    const start = this.pos()
    let s = ''
    while (/[A-Za-z0-9_]/.test(this.peek())) s += this.advance()
    if (s === 'not') return { kind: 'kw_not', value: s, pos: start }
    if (s === '_') return { kind: 'underscore', value: s, pos: start }
    return { kind: 'ident', value: s, pos: start }
  }

  private readDirective(): Token {
    const start = this.pos()
    this.advance()                                   // consume '.'
    let s = ''
    while (/[a-z]/.test(this.peek())) s += this.advance()
    if (!['decl', 'input', 'output'].includes(s)) {
      this.err('parse.unknownDirective', `unknown directive '.${s}'`, start)
    }
    return { kind: 'directive', value: s, pos: start }
  }

  next(): Token {
    this.skipWS()
    if (this.i >= this.src.length) return { kind: 'eof', value: '', pos: this.pos() }
    const start = this.pos()
    const c = this.peek()

    if (c === '.') {
      const nextC = this.peek(1)
      if (/[a-z]/.test(nextC)) return this.readDirective()
      this.advance()
      return { kind: 'dot', value: '.', pos: start }
    }
    if (c === ',') { this.advance(); return { kind: 'comma', value: ',', pos: start } }
    if (c === '(') { this.advance(); return { kind: 'lparen', value: '(', pos: start } }
    if (c === ')') { this.advance(); return { kind: 'rparen', value: ')', pos: start } }
    if (c === '!') { this.advance(); return { kind: 'bang', value: '!', pos: start } }
    if (c === ':') {
      this.advance()
      if (this.peek() === '-') {
        this.advance()
        return { kind: 'turnstile', value: ':-', pos: start }
      }
      return { kind: 'colon', value: ':', pos: start }
    }
    if (c === '"') return this.readString()
    if (c === '-' || /[0-9]/.test(c)) return this.readNumber()
    if (/[A-Za-z_]/.test(c)) return this.readIdentOrKeyword()

    this.err('parse.unexpectedChar', `unexpected character '${c}'`, start)
  }

  /** Lex the whole source eagerly. Convenience for the parser below. */
  tokenize(): Token[] {
    const out: Token[] = []
    while (true) {
      const t = this.next()
      out.push(t)
      if (t.kind === 'eof') break
    }
    return out
  }
}

// ─── Parser ────────────────────────────────────────────────────────────────

export interface ParseOptions {
  /** Source filename for error messages. Optional. */
  source?: string
  /**
   * Skip the post-parse "every referenced relation must have a .decl" check.
   * Used by the multi-file merger : when parsing a single `.dl` we may
   * reference a relation declared in another file. The merger validates
   * after merging via `validateProgramReferences`.
   */
  skipReferenceCheck?: boolean
}

export function parse(src: string, options: ParseOptions = {}): Program {
  const tokens = new Lexer(src, options.source).tokenize()
  const p = new Parser(tokens, options.source)
  return p.program(options.skipReferenceCheck ?? false)
}

/**
 * Run the "every referenced relation has a .decl" check on a (possibly
 * merged) program. Throws DatalogError on first violation.
 */
export function validateProgramReferences(program: Program): void {
  const checkAtom = (a: Atom): void => {
    const decl = program.decls.get(a.rel)
    if (!decl) {
      throw new DatalogError('parse.unknownRel',
        `relation '${a.rel}' is referenced but not declared`,
        a.pos, program.source)
    }
    if (decl.columns.length !== a.args.length) {
      throw new DatalogError('parse.arityMismatch',
        `'${a.rel}' declared with arity ${decl.columns.length} but called with ${a.args.length}`,
        a.pos, program.source)
    }
  }
  for (const rule of program.rules) {
    checkAtom(rule.head)
    for (const b of rule.body) checkAtom(b)
  }
  for (const f of program.inlineFacts) checkAtom(f)
}

class Parser {
  private i = 0
  private ruleCount = 0

  constructor(
    private readonly tokens: Token[],
    private readonly source?: string,
  ) {}

  private peek(off = 0): Token {
    return this.tokens[this.i + off]!
  }

  private advance(): Token {
    return this.tokens[this.i++]!
  }

  private expect(kind: Token['kind'], msg: string): Token {
    const t = this.peek()
    if (t.kind !== kind) this.err('parse.expected', `${msg} (got ${t.kind} '${t.value}')`, t.pos)
    return this.advance()
  }

  private err(code: string, msg: string, pos: SourcePos): never {
    throw new DatalogError(code, msg, pos, this.source)
  }

  program(skipReferenceCheck: boolean): Program {
    const decls = new Map<string, RelationDecl>()
    const rules: Rule[] = []
    const inlineFacts: Atom[] = []

    while (this.peek().kind !== 'eof') {
      const t = this.peek()
      if (t.kind === 'directive') {
        this.parseDirective(decls)
        continue
      }
      if (t.kind === 'ident') {
        // Atom (fact or rule head)
        const head = this.parseAtom()
        const next = this.peek()
        if (next.kind === 'turnstile') {
          this.advance()
          const body = this.parseBody()
          this.expect('dot', "'.' expected at end of rule")
          this.validateRule(head, body, t.pos)
          rules.push({ head, body, pos: t.pos, index: this.ruleCount++ })
        } else if (next.kind === 'dot') {
          this.advance()
          this.validateFact(head)
          inlineFacts.push(head)
        } else {
          this.err('parse.expected', `expected ':-' or '.' after head atom`, next.pos)
        }
        continue
      }
      this.err('parse.expected', `unexpected token '${t.value}' at top level`, t.pos)
    }

    const program: Program = { decls, rules, inlineFacts }
    if (this.source !== undefined) program.source = this.source

    if (!skipReferenceCheck) {
      // Validation post-parse : toutes les rels référencées DOIVENT avoir
      // un .decl. Skippable pour les fichiers parsés indépendamment puis
      // mergés (cf. mergePrograms / validateProgramReferences).
      validateProgramReferences(program)
    }
    return program
  }

  // ─── Directives ────────────────────────────────────────────────────────

  private parseDirective(decls: Map<string, RelationDecl>): void {
    const t = this.advance()                         // directive
    const which = t.value
    if (which === 'decl') {
      const name = this.expect('ident', "relation name expected after '.decl'")
      this.assertRelName(name.value, name.pos)
      this.expect('lparen', "'(' expected after .decl name")
      const columns: ColumnDecl[] = []
      if (this.peek().kind !== 'rparen') {
        columns.push(this.parseColumn())
        while (this.peek().kind === 'comma') {
          this.advance()
          columns.push(this.parseColumn())
        }
      }
      this.expect('rparen', "')' expected to close .decl columns")
      if (decls.has(name.value)) {
        this.err('parse.duplicateDecl', `relation '${name.value}' declared twice`, name.pos)
      }
      decls.set(name.value, {
        name: name.value, columns, isInput: false, isOutput: false, pos: name.pos,
      })
      return
    }
    if (which === 'input' || which === 'output') {
      const name = this.expect('ident', "relation name expected after directive")
      this.assertRelName(name.value, name.pos)
      const decl = decls.get(name.value)
      if (!decl) {
        this.err('parse.unknownRel', `relation '${name.value}' has no .decl`, name.pos)
      }
      if (which === 'input') decl.isInput = true
      else decl.isOutput = true
      return
    }
    /* istanbul ignore next: covered by lexer's whitelist */
    this.err('parse.unknownDirective', `unknown directive '${which}'`, t.pos)
  }

  private parseColumn(): ColumnDecl {
    const name = this.expect('ident', 'column name expected')
    this.expect('colon', "':' expected after column name")
    const typ = this.expect('ident', "column type expected ('symbol' or 'number')")
    if (typ.value !== 'symbol' && typ.value !== 'number') {
      this.err('parse.badColumnType',
        `unsupported column type '${typ.value}' (expected 'symbol' or 'number')`, typ.pos)
    }
    return { name: name.value, type: typ.value as ColumnType, pos: name.pos }
  }

  // ─── Atoms / Bodies ────────────────────────────────────────────────────

  private parseAtom(): Atom {
    const name = this.expect('ident', 'relation name expected')
    this.assertRelName(name.value, name.pos)
    this.expect('lparen', "'(' expected after relation name")
    const args: Term[] = []
    if (this.peek().kind !== 'rparen') {
      args.push(this.parseTerm())
      while (this.peek().kind === 'comma') {
        this.advance()
        args.push(this.parseTerm())
      }
    }
    this.expect('rparen', "')' expected to close atom")
    return { rel: name.value, args, negated: false, pos: name.pos }
  }

  private parseBody(): Atom[] {
    const out: Atom[] = []
    out.push(this.parseBodyAtom())
    while (this.peek().kind === 'comma') {
      this.advance()
      out.push(this.parseBodyAtom())
    }
    return out
  }

  private parseBodyAtom(): Atom {
    let negated = false
    const t = this.peek()
    if (t.kind === 'bang' || t.kind === 'kw_not') {
      this.advance()
      negated = true
    }
    const a = this.parseAtom()
    a.negated = negated
    return a
  }

  private parseTerm(): Term {
    const t = this.peek()
    if (t.kind === 'underscore') {
      this.advance()
      return { kind: 'wildcard', pos: t.pos }
    }
    if (t.kind === 'string') {
      this.advance()
      return { kind: 'const', value: t.value, pos: t.pos }
    }
    if (t.kind === 'number') {
      this.advance()
      const n = parseInt(t.value, 10)
      if (!Number.isFinite(n)) {
        this.err('parse.badNumber', `not a finite number: ${t.value}`, t.pos)
      }
      return { kind: 'const', value: n as DatalogValue, pos: t.pos }
    }
    if (t.kind === 'ident') {
      this.advance()
      this.assertVarName(t.value, t.pos)
      return { kind: 'var', name: t.value, pos: t.pos }
    }
    this.err('parse.expected', `term expected (got ${t.kind} '${t.value}')`, t.pos)
  }

  // ─── Validation ────────────────────────────────────────────────────────

  private assertRelName(name: string, pos: SourcePos): void {
    if (!/^[A-Z][A-Za-z0-9_]*$/.test(name)) {
      this.err('parse.badRelName',
        `relation name must start with uppercase ('${name}')`, pos)
    }
  }

  private assertVarName(name: string, pos: SourcePos): void {
    if (!/^[A-Z_][A-Za-z0-9_]*$/.test(name)) {
      this.err('parse.badVarName',
        `variable must start with uppercase or '_' ('${name}')`, pos)
    }
  }

  private validateFact(atom: Atom): void {
    for (const a of atom.args) {
      if (a.kind === 'var') {
        this.err('parse.factHasVar',
          `inline facts cannot contain variables ('${a.name}')`, a.pos)
      }
      if (a.kind === 'wildcard') {
        this.err('parse.factHasWildcard',
          `inline facts cannot contain wildcards`, a.pos)
      }
    }
  }

  /**
   * Range-restriction : toute variable du head DOIT apparaître dans au moins
   * un atom positif du body. Une variable qui n'apparaît QUE dans un atom
   * négé est unsafe (l'évaluateur ne peut pas l'instancier).
   */
  private validateRule(head: Atom, body: Atom[], pos: SourcePos): void {
    if (head.negated) {
      this.err('parse.negatedHead', 'rule head cannot be negated', head.pos)
    }
    const positiveVars = new Set<string>()
    for (const ba of body) {
      if (ba.negated) continue
      for (const term of ba.args) {
        if (term.kind === 'var') positiveVars.add(term.name)
      }
    }
    for (const t of head.args) {
      if (t.kind === 'var' && !positiveVars.has(t.name)) {
        this.err('parse.unsafeHeadVar',
          `head variable '${t.name}' does not appear in a positive body atom`, t.pos)
      }
    }
    for (const ba of body) {
      if (!ba.negated) continue
      for (const term of ba.args) {
        if (term.kind === 'var' && !positiveVars.has(term.name)) {
          this.err('parse.unsafeNegatedVar',
            `variable '${term.name}' in negated atom must also appear in a positive atom`, term.pos)
        }
      }
    }
    if (body.length === 0) {
      this.err('parse.emptyBody', 'rule body cannot be empty (use a fact instead)', pos)
    }
  }

}
