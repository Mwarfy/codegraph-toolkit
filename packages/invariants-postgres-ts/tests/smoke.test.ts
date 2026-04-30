/**
 * Smoke tests pour @liby-tools/invariants-postgres-ts.
 *
 * Vérifie que les rules tournent contre des facts vides → 0 violations.
 * Vérifie aussi qu'une violation est correctement détectée quand on
 * fournit des facts qui matchent. Et que le ratchet exempte bien.
 *
 * Charge les .dl directement depuis le package (chemin relatif au
 * test file) — pas besoin d'install.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mergePrograms, loadFacts, evaluate } from '@liby-tools/datalog'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INVARIANTS_DIR = path.resolve(__dirname, '..', 'invariants')

async function loadRule(name: string): Promise<string> {
  return fs.readFile(path.join(INVARIANTS_DIR, name), 'utf-8')
}

async function runRule(args: {
  ruleName: string
  facts?: Map<string, string>
}): Promise<{ violations: Array<Array<string | number>> }> {
  const schema = await loadRule('schema-subset.dl')
  const rule = await loadRule(args.ruleName)
  const program = mergePrograms([
    { name: 'schema.dl', content: schema },
    { name: args.ruleName, content: rule },
  ])
  const db = loadFacts(program.decls, { factsByRelation: args.facts ?? new Map() })
  const result = evaluate(program, db, { allowRecursion: true })
  return { violations: result.outputs.get('Violation') ?? [] }
}

describe('cycles-no-new', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'cycles-no-new.dl' })
    expect(violations).toEqual([])
  })

  it('flag un cycle non-gated', async () => {
    const facts = new Map([
      ['CycleNode', 'src/a.ts\tcycle-1\tfalse\nsrc/b.ts\tcycle-1\tfalse'],
    ])
    const { violations } = await runRule({ ruleName: 'cycles-no-new.dl', facts })
    expect(violations).toHaveLength(2)
    expect(violations[0][0]).toBe('CYCLES')
    expect(violations.map((v) => v[1]).sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('skip un cycle gated', async () => {
    const facts = new Map([
      ['CycleNode', 'src/a.ts\tcycle-1\ttrue\nsrc/b.ts\tcycle-1\ttrue'],
    ])
    const { violations } = await runRule({ ruleName: 'cycles-no-new.dl', facts })
    expect(violations).toEqual([])
  })

  // Pour tester le ratchet, on doit ajouter `CyclesGrandfathered("cycle-1").`
  // au rule. Pas faisable directement sans modifier le fichier — on documente
  // que le ratchet est utilisé via inline-facts dans le rule du consumer.
})

describe('sql-fk-needs-index', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'sql-fk-needs-index.dl' })
    expect(violations).toEqual([])
  })

  it('flag un FK sans index', async () => {
    const facts = new Map([
      ['SqlFkWithoutIndex', 'orders\tcustomer_id\tcustomers\tid'],
      ['SqlForeignKey', 'orders\tcustomer_id\tcustomers\tid\tdb/schema.sql\t42'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-fk-needs-index.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('SQL-FK-INDEX')
    expect(violations[0][1]).toBe('db/schema.sql')  // file from SqlForeignKey
    expect(violations[0][2]).toBe(42)  // line
  })

  it('skip un FK avec index présent', async () => {
    const facts = new Map([
      // Note : SqlFkWithoutIndex n'est PAS émis si index existe — on
      // simule en ne le mettant pas dans les facts.
      ['SqlForeignKey', 'orders\tcustomer_id\tcustomers\tid\tdb/schema.sql\t42'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-fk-needs-index.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('schema-subset.dl est valide', () => {
  it('parse sans erreur et déclare les relations attendues', async () => {
    const schema = await loadRule('schema-subset.dl')
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
    ])
    // Relations critiques pour les rules du package
    expect(program.decls.has('CycleNode')).toBe(true)
    expect(program.decls.has('SqlFkWithoutIndex')).toBe(true)
    expect(program.decls.has('SqlForeignKey')).toBe(true)
    expect(program.decls.has('Violation')).toBe(true)
    // Toutes les input relations sont marquées .input
    expect(program.decls.get('CycleNode')!.isInput).toBe(true)
    expect(program.decls.get('Violation')!.isOutput).toBe(true)
  })
})
