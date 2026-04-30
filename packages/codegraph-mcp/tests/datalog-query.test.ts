/**
 * Tests pour codegraph_datalog_query — exécute une rule Datalog ad hoc
 * contre un facts dir fixture.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { codegraphDatalogQuery } from '../src/tools/datalog-query.js'

let tmpRoot: string
let factsDir: string

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-datalog-'))
  factsDir = path.join(tmpRoot, '.codegraph', 'facts')
  fs.mkdirSync(factsDir, { recursive: true })

  // Schema minimal — juste les relations qu'on va requêter dans les tests.
  fs.writeFileSync(
    path.join(factsDir, 'schema.dl'),
    [
      '.decl File(file:symbol)',
      '.input File',
      '.decl ImportEdge(from:symbol, to:symbol, line:number)',
      '.input ImportEdge',
      '.decl FileTag(file:symbol, tag:symbol)',
      '.input FileTag',
      '.decl EmitsLiteral(file:symbol, line:number, eventName:symbol)',
      '.input EmitsLiteral',
      '',
    ].join('\n'),
  )

  // Facts fixture : graphe a → b → c → d, plus e isolé. Tag "audit" sur c.
  fs.writeFileSync(path.join(factsDir, 'File.facts'),
    ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].join('\n'))
  fs.writeFileSync(path.join(factsDir, 'ImportEdge.facts'),
    ['a.ts\tb.ts\t1', 'b.ts\tc.ts\t2', 'c.ts\td.ts\t3'].join('\n'))
  fs.writeFileSync(path.join(factsDir, 'FileTag.facts'),
    ['c.ts\taudit'].join('\n'))
  fs.writeFileSync(path.join(factsDir, 'EmitsLiteral.facts'),
    ['a.ts\t10\tuser.created', 'b.ts\t20\torder.placed', 'a.ts\t15\torder.placed'].join('\n'))
})

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('codegraph_datalog_query', () => {
  it('exécute une rule simple (importeurs directs de c.ts)', () => {
    const out = codegraphDatalogQuery({
      rule_text:
        '.decl R(f:symbol)\n' +
        'R(F) :- ImportEdge(F, "c.ts", _).',
      repo_root: tmpRoot,
    })
    expect(out.content).toContain('R("b.ts")')
    expect(out.content).toContain('Tuples: 1')
  })

  it('supporte la transitivité (closure transitive de Imports)', () => {
    const out = codegraphDatalogQuery({
      rule_text:
        '.decl Reach(from:symbol, to:symbol)\n' +
        'Reach(F, T) :- ImportEdge(F, T, _).\n' +
        'Reach(F, T) :- ImportEdge(F, M, _), Reach(M, T).',
      repo_root: tmpRoot,
    })
    // a→b, b→c, c→d, a→c, a→d, b→d = 6 paires
    expect(out.content).toContain('Tuples: 6')
    expect(out.content).toContain('Reach("a.ts", "d.ts")')
  })

  it('supporte les anti-jointures (fichiers émettant sans tag audit)', () => {
    const out = codegraphDatalogQuery({
      rule_text:
        '.decl Untagged(f:symbol)\n' +
        'Untagged(F) :- EmitsLiteral(F, _, _), !FileTag(F, "audit").',
      repo_root: tmpRoot,
    })
    // a.ts et b.ts émettent. c.ts est tagged audit mais n'émet pas.
    expect(out.content).toContain('Untagged("a.ts")')
    expect(out.content).toContain('Untagged("b.ts")')
    expect(out.content).not.toContain('Untagged("c.ts")')
  })

  it('output_relation explicite override l\'auto-detect', () => {
    const out = codegraphDatalogQuery({
      rule_text:
        '.decl First(f:symbol)\n' +
        'First(F) :- File(F).\n' +
        '.decl Second(f:symbol)\n' +
        'Second(F) :- ImportEdge(F, _, _).',
      output_relation: 'First',
      repo_root: tmpRoot,
    })
    expect(out.content).toContain('First(')
    expect(out.content).not.toContain('Second(')
    expect(out.content).toContain('Tuples: 5')  // 5 files
  })

  it('retourne 0 tuples si la rule ne match rien', () => {
    const out = codegraphDatalogQuery({
      rule_text:
        '.decl R(f:symbol)\n' +
        'R(F) :- ImportEdge(F, "nonexistent.ts", _).',
      repo_root: tmpRoot,
    })
    expect(out.content).toContain('Tuples: 0')
    expect(out.content).toContain('(no tuples)')
  })

  it('rejette une rule sans .decl avec un message clair', () => {
    const out = codegraphDatalogQuery({
      rule_text: 'Foo(X) :- File(X).',
      repo_root: tmpRoot,
    })
    expect(out.content).toContain('❌')
    expect(out.content).toContain('No `.decl` found')
  })

  it('relaie les erreurs de parse Datalog proprement (pas de crash)', () => {
    const out = codegraphDatalogQuery({
      rule_text:
        '.decl R(f:symbol)\n' +
        'this is not valid datalog syntax @@@',
      repo_root: tmpRoot,
    })
    expect(out.content).toContain('❌')
    expect(out.content).toMatch(/parse|merge|error/i)
  })

  it('retourne erreur claire si schema.dl absent', () => {
    const emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-empty-'))
    try {
      const out = codegraphDatalogQuery({
        rule_text: '.decl R(f:symbol)\nR(F) :- File(F).',
        repo_root: emptyTmp,
      })
      expect(out.content).toContain('❌')
      expect(out.content).toContain('No schema.dl')
    } finally {
      fs.rmSync(emptyTmp, { recursive: true, force: true })
    }
  })

  it('respecte le limit (truncation)', () => {
    const out = codegraphDatalogQuery({
      rule_text:
        '.decl R(f:symbol)\n' +
        'R(F) :- File(F).',
      limit: 2,
      repo_root: tmpRoot,
    })
    expect(out.content).toContain('Tuples: 5')
    expect(out.content).toContain('showing 2')
    expect(out.content).toContain('+3 truncated')
  })
})
