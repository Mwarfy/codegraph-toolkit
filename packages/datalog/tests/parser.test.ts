/**
 * Parser tests — every error path + full happy path.
 *
 * Vitest-style. Self-contained.
 */

import { describe, it, expect } from 'vitest'
import { parse } from '../src/parser.js'
import { DatalogError } from '../src/types.js'

describe('parser — happy path', () => {
  it('parses a minimal program with decl + rule', () => {
    const src = `
      .decl Foo(x: symbol)
      .decl Bar(x: symbol)
      .input Foo
      .output Bar
      Bar(X) :- Foo(X).
    `
    const p = parse(src)
    expect(p.decls.size).toBe(2)
    expect(p.decls.get('Foo')!.isInput).toBe(true)
    expect(p.decls.get('Foo')!.isOutput).toBe(false)
    expect(p.decls.get('Bar')!.isOutput).toBe(true)
    expect(p.rules.length).toBe(1)
    expect(p.rules[0].head.rel).toBe('Bar')
    expect(p.rules[0].body[0].rel).toBe('Foo')
    expect(p.rules[0].body[0].negated).toBe(false)
  })

  it('parses inline facts', () => {
    const src = `
      .decl Foo(x: symbol, n: number)
      .input Foo
      Foo("a", 1).
      Foo("b", 2).
    `
    const p = parse(src)
    expect(p.inlineFacts.length).toBe(2)
    expect(p.inlineFacts[0].args[0]).toMatchObject({ kind: 'const', value: 'a' })
    expect(p.inlineFacts[0].args[1]).toMatchObject({ kind: 'const', value: 1 })
  })

  it('parses negation as ! and as `not`', () => {
    const src = `
      .decl A(x: symbol) .decl B(x: symbol) .decl C(x: symbol) .decl D(x: symbol)
      .input A .input B .output C .output D
      C(X) :- A(X), !B(X).
      D(X) :- A(X), not B(X).
    `
    const p = parse(src)
    expect(p.rules[0].body[1].negated).toBe(true)
    expect(p.rules[1].body[1].negated).toBe(true)
  })

  it('parses wildcards and string escapes', () => {
    const src = `
      .decl A(x: symbol, y: symbol) .decl B(x: symbol)
      .input A .output B
      B(X) :- A(X, _).
      A("with \\"quote\\"", "tab\\there").
    `
    const p = parse(src)
    expect(p.rules[0].body[0].args[1].kind).toBe('wildcard')
    expect(p.inlineFacts[0].args[0]).toMatchObject({
      kind: 'const', value: 'with "quote"',
    })
    expect(p.inlineFacts[0].args[1]).toMatchObject({
      kind: 'const', value: 'tab\there',
    })
  })

  it('skips line + block comments', () => {
    const src = `
      // this is a line comment
      .decl A(x: symbol) /* and this
                            is a multi-line block */ .input A
      A("ok"). // trailing comment
    `
    const p = parse(src)
    expect(p.decls.size).toBe(1)
    expect(p.inlineFacts.length).toBe(1)
  })

  it('parses rules with mixed const + var args', () => {
    const src = `
      .decl A(x: symbol, y: number) .decl B(x: symbol)
      .input A .output B
      B(X) :- A(X, 42).
    `
    const p = parse(src)
    const arg2 = p.rules[0].body[0].args[1]
    expect(arg2).toMatchObject({ kind: 'const', value: 42 })
  })
})

describe('parser — errors with line:col', () => {
  function expectError(src: string, code: string, line?: number) {
    let caught: unknown
    try { parse(src, { source: 'test.dl' }) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(DatalogError)
    expect((caught as DatalogError).code).toBe(code)
    if (line !== undefined) {
      expect((caught as DatalogError).pos?.line).toBe(line)
    }
  }

  it('rejects unterminated string', () => {
    expectError(`.decl A(x: symbol)\n.input A\nA("abc).`, 'parse.unterminatedString')
  })

  it('rejects unknown directive', () => {
    expectError(`.foobar A`, 'parse.unknownDirective')
  })

  it('rejects unknown relation in rule', () => {
    expectError(`.decl A(x: symbol) .input A\nB(X) :- A(X).`, 'parse.unknownRel')
  })

  it('rejects arity mismatch', () => {
    expectError(`.decl A(x: symbol, y: symbol) .input A\nA("a").`, 'parse.arityMismatch')
  })

  it('rejects unsafe negated var (var only in negated atom)', () => {
    // Head has no variable but a negated body uses Y not seen positively.
    expectError(
      `.decl A(x: symbol) .decl B(x: symbol) .decl C(x: symbol)
       .input A .input B .output C
       C("ok") :- A(_), !B(Y).`,
      'parse.unsafeNegatedVar',
    )
  })

  it('rejects unsafe head var (not in any positive atom)', () => {
    expectError(
      `.decl A(x: symbol) .decl B(x: symbol)
       .input A .output B
       B(Y) :- A(_).`,
      'parse.unsafeHeadVar',
    )
  })

  it('rejects empty body', () => {
    expectError(
      `.decl A(x: symbol) .decl B(x: symbol)
       .input A .output B
       B(X) :- .`,
      'parse.expected',
    )
  })

  it('rejects duplicate decl', () => {
    expectError(`.decl A(x: symbol) .decl A(x: symbol)`, 'parse.duplicateDecl')
  })

  it('rejects bad column type', () => {
    expectError(`.decl A(x: float)`, 'parse.badColumnType')
  })

  it('rejects fact with variable', () => {
    expectError(`.decl A(x: symbol) .input A\nA(X).`, 'parse.factHasVar')
  })

  it('rejects relation name starting lowercase', () => {
    expectError(`.decl foo(x: symbol)`, 'parse.badRelName')
  })

  it('errors carry line:col from source', () => {
    let caught: unknown
    try {
      parse(`.decl Foo(x: symbol)\n\nfoo(X).`, { source: 'test.dl' })
    } catch (e) { caught = e }
    const err = caught as DatalogError
    expect(err.pos?.line).toBe(3)
    expect(err.code).toBe('parse.badRelName')
    expect(err.format()).toContain('test.dl:3:')
  })
})

describe('parser — determinism', () => {
  it('produces structurally equal AST across two parses', () => {
    const src = `
      .decl A(x: symbol) .decl B(x: symbol) .decl Violation(rel: symbol)
      .input A .input B .output Violation
      Violation(X) :- A(X), !B(X).
    `
    const p1 = parse(src)
    const p2 = parse(src)
    // Same declarations, same rule shape, same indices.
    expect([...p1.decls.keys()].sort()).toEqual([...p2.decls.keys()].sort())
    expect(p1.rules.length).toBe(p2.rules.length)
    expect(p1.rules[0].index).toBe(p2.rules[0].index)
  })
})
