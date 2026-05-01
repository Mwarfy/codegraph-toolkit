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

describe('sql-table-needs-pk', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'sql-table-needs-pk.dl' })
    expect(violations).toEqual([])
  })

  it('flag une table sans PK', async () => {
    const facts = new Map([
      ['SqlTable', 'orders\tdb/schema.sql\t10\nlogs\tdb/schema.sql\t20'],
      ['SqlPrimaryKey', 'orders\tid\tdb/schema.sql\t10'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-table-needs-pk.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('SQL-TABLE-NEEDS-PK')
    expect(violations[0][1]).toBe('db/schema.sql')
    expect(violations[0][2]).toBe(20)
  })

  it('skip si table grandfathered', async () => {
    // Crée une rule custom qui contient le grandfather pour `logs`.
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('sql-table-needs-pk.dl')
    const customRule = baseRule + '\nTableNoPkGrandfathered("logs").\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['SqlTable', 'orders\tdb/schema.sql\t10\nlogs\tdb/schema.sql\t20'],
      ['SqlPrimaryKey', 'orders\tid\tdb/schema.sql\t10'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('sql-timestamp-needs-tz', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'sql-timestamp-needs-tz.dl' })
    expect(violations).toEqual([])
  })

  it('flag TIMESTAMP sans tz (uppercase)', async () => {
    const facts = new Map([
      ['SqlColumn', 'events\tcreated_at\tTIMESTAMP\tdb/schema.sql\t12'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-timestamp-needs-tz.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('SQL-TIMESTAMP-NEEDS-TZ')
  })

  it('skip TIMESTAMPTZ', async () => {
    const facts = new Map([
      ['SqlColumn', 'events\tcreated_at\tTIMESTAMPTZ\tdb/schema.sql\t12'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-timestamp-needs-tz.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('sql-orphan-fk', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'sql-orphan-fk.dl' })
    expect(violations).toEqual([])
  })

  it('flag un FK vers table inexistante', async () => {
    const facts = new Map([
      ['SqlTable', 'orders\tdb/schema.sql\t10'],
      ['SqlForeignKey', 'invoices\torder_id\tnonexistent\tid\tdb/migrations/050.sql\t42'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-orphan-fk.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('SQL-ORPHAN-FK')
    expect(violations[0][2]).toBe(42)
  })

  it('skip un FK vers table existante', async () => {
    const facts = new Map([
      ['SqlTable', 'orders\tdb/schema.sql\t10'],
      ['SqlForeignKey', 'invoices\torder_id\torders\tid\tdb/migrations/050.sql\t42'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-orphan-fk.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('no-eval', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-eval.dl' })
    expect(violations).toEqual([])
  })

  it('flag un eval call', async () => {
    const facts = new Map([
      ['EvalCall', 'src/runner.ts\t42\teval\trunSandbox'],
    ])
    const { violations } = await runRule({ ruleName: 'no-eval.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('NO-EVAL')
    expect(violations[0][1]).toBe('src/runner.ts')
    expect(violations[0][2]).toBe(42)
  })

  it('flag function-constructor aussi', async () => {
    const facts = new Map([
      ['EvalCall', 'src/dynamic.ts\t10\tfunction-constructor\tmakeFn'],
    ])
    const { violations } = await runRule({ ruleName: 'no-eval.dl', facts })
    expect(violations).toHaveLength(1)
  })
})

describe('no-hardcoded-secret', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-hardcoded-secret.dl' })
    expect(violations).toEqual([])
  })

  it('flag un secret détecté', async () => {
    const facts = new Map([
      ['HardcodedSecret', 'src/auth.ts\t42\tapi_key\tname\t450'],
    ])
    const { violations } = await runRule({ ruleName: 'no-hardcoded-secret.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('NO-HARDCODED-SECRET')
    expect(violations[0][1]).toBe('src/auth.ts')
    expect(violations[0][2]).toBe(42)
  })

  it('skip si grandfathered', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-hardcoded-secret.dl')
    const customRule = baseRule + '\nHardcodedSecretGrandfathered("src/auth.ts", 42).\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['HardcodedSecret', 'src/auth.ts\t42\tapi_key\tname\t450'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('no-boolean-positional-param', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-boolean-positional-param.dl' })
    expect(violations).toEqual([])
  })

  it('flag un boolean positionnel', async () => {
    const facts = new Map([
      ['BooleanParam', 'src/api.ts\t10\tsendMessage\turgent\t1\t2'],
    ])
    const { violations } = await runRule({ ruleName: 'no-boolean-positional-param.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('NO-BOOLEAN-POSITIONAL-PARAM')
  })

  it('skip si grandfathered par (file, name)', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-boolean-positional-param.dl')
    const customRule = baseRule + '\nBooleanParamGrandfathered("src/api.ts", "sendMessage").\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['BooleanParam', 'src/api.ts\t10\tsendMessage\turgent\t1\t2'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('no-identical-subexpressions', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-identical-subexpressions.dl' })
    expect(violations).toEqual([])
  })

  it('flag un identical-subexpressions', async () => {
    const facts = new Map([
      ['DeadCode', 'src/foo.ts\t10\tidentical-subexpressions'],
    ])
    const { violations } = await runRule({ ruleName: 'no-identical-subexpressions.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('NO-IDENTICAL-SUBEXPRESSIONS')
  })

  it('skip si grandfathered', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-identical-subexpressions.dl')
    const customRule = baseRule + '\nIdenticalSubexprGrandfathered("src/foo.ts", 10).\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['DeadCode', 'src/foo.ts\t10\tidentical-subexpressions'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })

  it('ne flag PAS un return-then-else (kind discriminé)', async () => {
    const facts = new Map([
      ['DeadCode', 'src/foo.ts\t10\treturn-then-else'],
    ])
    const { violations } = await runRule({ ruleName: 'no-identical-subexpressions.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('no-return-then-else', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-return-then-else.dl' })
    expect(violations).toEqual([])
  })

  it('flag un return-then-else', async () => {
    const facts = new Map([
      ['DeadCode', 'src/foo.ts\t42\treturn-then-else'],
    ])
    const { violations } = await runRule({ ruleName: 'no-return-then-else.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('NO-RETURN-THEN-ELSE')
    expect(violations[0][2]).toBe(42)
  })

  it('skip si grandfathered par (file, line)', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-return-then-else.dl')
    const customRule = baseRule + '\nReturnThenElseGrandfathered("src/foo.ts", 42).\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['DeadCode', 'src/foo.ts\t42\treturn-then-else'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('no-switch-fallthrough', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-switch-fallthrough.dl' })
    expect(violations).toEqual([])
  })

  it('flag un switch-fallthrough', async () => {
    const facts = new Map([
      ['DeadCode', 'src/router.ts\t42\tswitch-fallthrough'],
    ])
    const { violations } = await runRule({ ruleName: 'no-switch-fallthrough.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('NO-SWITCH-FALLTHROUGH')
  })

  it('ne flag PAS un return-then-else (kind discriminé)', async () => {
    const facts = new Map([
      ['DeadCode', 'src/foo.ts\t42\treturn-then-else'],
    ])
    const { violations } = await runRule({ ruleName: 'no-switch-fallthrough.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('no-floating-promise', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-floating-promise.dl' })
    expect(violations).toEqual([])
  })

  it('flag une floating promise', async () => {
    const facts = new Map([
      ['FloatingPromise', 'src/api.ts\t10\tfetchData\thandleRequest'],
    ])
    const { violations } = await runRule({ ruleName: 'no-floating-promise.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('NO-FLOATING-PROMISE')
  })

  it('skip si grandfathered', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-floating-promise.dl')
    const customRule = baseRule + '\nFloatingPromiseGrandfathered("src/api.ts", 10).\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['FloatingPromise', 'src/api.ts\t10\tfetchData\thandleRequest'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('no-deprecated-usage', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-deprecated-usage.dl' })
    expect(violations).toEqual([])
  })

  it('flag un usage de symbole deprecated', async () => {
    const facts = new Map([
      ['DeprecatedDecl', 'oldApi\tsrc/legacy.ts\t10'],
      ['DeprecatedUsage', 'src/consumer.ts\t42\toldApi'],
    ])
    const { violations } = await runRule({ ruleName: 'no-deprecated-usage.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('NO-DEPRECATED-USAGE')
  })

  it('skip si grandfathered', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-deprecated-usage.dl')
    const customRule = baseRule + '\nDeprecatedUsageGrandfathered("src/consumer.ts", 42).\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['DeprecatedDecl', 'oldApi\tsrc/legacy.ts\t10'],
      ['DeprecatedUsage', 'src/consumer.ts\t42\toldApi'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('no-new-articulation-point', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-new-articulation-point.dl' })
    expect(violations).toEqual([])
  })

  it('flag un articulation point non grandfathered', async () => {
    const facts = new Map([
      ['ArticulationPoint', 'src/hub.ts\t3'],
    ])
    const { violations } = await runRule({ ruleName: 'no-new-articulation-point.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('NO-NEW-ARTICULATION-POINT')
    expect(violations[0][1]).toBe('src/hub.ts')
  })

  it('skip si grandfathered', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-new-articulation-point.dl')
    const customRule = baseRule + '\nArticulationPointGrandfathered("src/hub.ts").\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['ArticulationPoint', 'src/hub.ts\t3'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('sql-naming-convention', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'sql-naming-convention.dl' })
    expect(violations).toEqual([])
  })

  it('flag chacun des 4 kinds', async () => {
    const facts = new Map([
      ['SqlNamingViolation', [
        'db/schema.sql\t5\tuserOrders\t_\ttable-not-snake-case',
        'db/schema.sql\t10\tusers\tfirstName\tcolumn-not-snake-case',
        'db/schema.sql\t15\tevents\thappened\ttimestamp-missing-at-suffix',
        'db/schema.sql\t20\torders\tcustomer\tfk-missing-id-suffix',
      ].join('\n')],
    ])
    const { violations } = await runRule({ ruleName: 'sql-naming-convention.dl', facts })
    expect(violations).toHaveLength(4)
  })

  it('skip si grandfathered par (file, line, kind)', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('sql-naming-convention.dl')
    const customRule = baseRule +
      '\nSqlNamingGrandfathered("db/schema.sql", 15, "timestamp-missing-at-suffix").\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['SqlNamingViolation',
        'db/schema.sql\t15\tevents\thappened\ttimestamp-missing-at-suffix'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('sql-migration-order', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'sql-migration-order.dl' })
    expect(violations).toEqual([])
  })

  it('flag un FK forward-reference', async () => {
    const facts = new Map([
      ['SqlMigrationOrderViolation',
        'db/010_orders.sql\t12\torders\tuser_id\tusers\t10\t50'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-migration-order.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('SQL-MIGRATION-ORDER')
  })

  it('skip si grandfathered', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('sql-migration-order.dl')
    const customRule = baseRule +
      '\nMigrationOrderGrandfathered("db/010_orders.sql", 12).\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['SqlMigrationOrderViolation',
        'db/010_orders.sql\t12\torders\tuser_id\tusers\t10\t50'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('no-switch-empty-or-no-default', () => {
  it('flag switch-empty', async () => {
    const facts = new Map([
      ['DeadCode', 'src/router.ts\t10\tswitch-empty'],
    ])
    const { violations } = await runRule({ ruleName: 'no-switch-empty-or-no-default.dl', facts })
    expect(violations).toHaveLength(1)
  })

  it('flag switch-no-default', async () => {
    const facts = new Map([
      ['DeadCode', 'src/router.ts\t20\tswitch-no-default'],
    ])
    const { violations } = await runRule({ ruleName: 'no-switch-empty-or-no-default.dl', facts })
    expect(violations).toHaveLength(1)
  })

  it('skip si grandfathered', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-switch-empty-or-no-default.dl')
    const customRule = baseRule + '\nSwitchDefaultGrandfathered("src/router.ts", 10).\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['DeadCode', 'src/router.ts\t10\tswitch-empty'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('no-controlling-expression-constant', () => {
  it('flag controlling-expression-constant', async () => {
    const facts = new Map([
      ['DeadCode', 'src/foo.ts\t5\tcontrolling-expression-constant'],
    ])
    const { violations } = await runRule({ ruleName: 'no-controlling-expression-constant.dl', facts })
    expect(violations).toHaveLength(1)
  })

  it('skip si grandfathered', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-controlling-expression-constant.dl')
    const customRule = baseRule + '\nControllingConstantGrandfathered("src/foo.ts", 5).\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['DeadCode', 'src/foo.ts\t5\tcontrolling-expression-constant'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('sql-audit-columns', () => {
  it('flag audit-column-missing-created-at', async () => {
    const facts = new Map([
      ['SqlNamingViolation',
        'db/schema.sql\t5\torders\t_\taudit-column-missing-created-at'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-audit-columns.dl', facts })
    expect(violations).toHaveLength(1)
  })

  it('flag audit-column-missing-updated-at', async () => {
    const facts = new Map([
      ['SqlNamingViolation',
        'db/schema.sql\t5\torders\t_\taudit-column-missing-updated-at'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-audit-columns.dl', facts })
    expect(violations).toHaveLength(1)
  })

  it('skip si grandfathered par (table, kind)', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('sql-audit-columns.dl')
    const customRule = baseRule +
      '\nAuditColumnGrandfathered("orders", "audit-column-missing-updated-at").\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['SqlNamingViolation',
        'db/schema.sql\t5\torders\t_\taudit-column-missing-updated-at'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })

  it('ne flag PAS un naming violation classique (kind discriminé)', async () => {
    const facts = new Map([
      ['SqlNamingViolation',
        'db/schema.sql\t5\torders\tcustomer\tfk-missing-id-suffix'],
    ])
    const { violations } = await runRule({ ruleName: 'sql-audit-columns.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('no-resource-imbalance', () => {
  it('0 violations sur facts vides', async () => {
    const { violations } = await runRule({ ruleName: 'no-resource-imbalance.dl' })
    expect(violations).toEqual([])
  })

  it('flag une imbalance', async () => {
    const facts = new Map([
      ['ResourceImbalance',
        'src/foo.ts\t10\thandle\tsetInterval/clearInterval\t2\t1'],
    ])
    const { violations } = await runRule({ ruleName: 'no-resource-imbalance.dl', facts })
    expect(violations).toHaveLength(1)
  })

  it('skip si grandfathered par (file, symbol)', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('no-resource-imbalance.dl')
    const customRule = baseRule +
      '\nResourceImbalanceGrandfathered("src/foo.ts", "handle").\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['ResourceImbalance',
        'src/foo.ts\t10\thandle\tsetInterval/clearInterval\t2\t1'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
  })
})

describe('composite-eval-in-http-route (Tier 7)', () => {
  it('flag eval dans un fichier qui declare une http-route', async () => {
    const facts = new Map([
      ['EvalCall', 'src/api.ts\t10\teval\thandler'],
      ['EntryPoint', 'src/api.ts\thttp-route\tPOST /api/run'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-eval-in-http-route.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('COMPOSITE-EVAL-IN-HTTP-ROUTE')
  })

  it('skip si eval mais pas dans http-route', async () => {
    const facts = new Map([
      ['EvalCall', 'src/sandbox.ts\t10\teval\thandler'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-eval-in-http-route.dl', facts })
    expect(violations).toEqual([])
  })

  it('skip si http-route mais pas eval', async () => {
    const facts = new Map([
      ['EntryPoint', 'src/api.ts\thttp-route\tPOST /api/run'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-eval-in-http-route.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('composite-fk-chain-without-index (Tier 7)', () => {
  it('flag FK source d\\u0027une chaine transitive sans index', async () => {
    // Chaine A → B → C, A→B sans index.
    const facts = new Map([
      ['SqlForeignKey', [
        'orders\tcustomer_id\tcustomers\tid\tdb/schema.sql\t10',
        'customers\tcompany_id\tcompanies\tid\tdb/schema.sql\t20',
      ].join('\n')],
      ['SqlFkWithoutIndex', 'orders\tcustomer_id\tcustomers\tid'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-fk-chain-without-index.dl', facts })
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0][0]).toBe('COMPOSITE-FK-CHAIN-WITHOUT-INDEX')
  })

  it('skip si FK isole (pas de chaine)', async () => {
    const facts = new Map([
      ['SqlForeignKey', 'orders\tcustomer_id\tcustomers\tid\tdb/schema.sql\t10'],
      ['SqlFkWithoutIndex', 'orders\tcustomer_id\tcustomers\tid'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-fk-chain-without-index.dl', facts })
    // Pas de chaine A→B→C donc pas de violation par cette rule
    // (sql-fk-needs-index attrape l'isolated case).
    expect(violations).toEqual([])
  })

  it('skip si chaine indexee', async () => {
    const facts = new Map([
      ['SqlForeignKey', [
        'orders\tcustomer_id\tcustomers\tid\tdb/schema.sql\t10',
        'customers\tcompany_id\tcompanies\tid\tdb/schema.sql\t20',
      ].join('\n')],
      // SqlFkWithoutIndex vide = tout est indexé
    ])
    const { violations } = await runRule({ ruleName: 'composite-fk-chain-without-index.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('composite-high-critical-untested (Tier 7)', () => {
  it('flag intersection des 3 conditions', async () => {
    const facts = new Map([
      ['ArticulationPoint', 'src/hub.ts\t5'],
      ['TruthPointWriter', 'visual_renders\tsrc/hub.ts'],
      // TestedFile vide = pas de test pour src/hub.ts
    ])
    const { violations } = await runRule({ ruleName: 'composite-high-critical-untested.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('COMPOSITE-HIGH-CRITICAL-UNTESTED')
    expect(violations[0][1]).toBe('src/hub.ts')
  })

  it('skip si tested', async () => {
    const facts = new Map([
      ['ArticulationPoint', 'src/hub.ts\t5'],
      ['TruthPointWriter', 'concept\tsrc/hub.ts'],
      ['TestedFile', 'src/hub.ts'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-high-critical-untested.dl', facts })
    expect(violations).toEqual([])
  })

  it('skip si pas truth-point writer', async () => {
    const facts = new Map([
      ['ArticulationPoint', 'src/hub.ts\t5'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-high-critical-untested.dl', facts })
    expect(violations).toEqual([])
  })

  it('skip si pas articulation point', async () => {
    const facts = new Map([
      ['TruthPointWriter', 'concept\tsrc/hub.ts'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-high-critical-untested.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('composite-double-drift-wrapper-boolean (Tier 7)', () => {
  it('flag wrapper-superfluous + boolean param meme line', async () => {
    const facts = new Map([
      ['DriftSignalFact', 'src/wrap.ts\t10\twrapper-superfluous'],
      ['BooleanParam', 'src/wrap.ts\t10\tsendMessage\turgent\t1\t2'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-double-drift-wrapper-boolean.dl', facts })
    expect(violations).toHaveLength(1)
    expect(violations[0][0]).toBe('COMPOSITE-DOUBLE-DRIFT-WRAPPER-BOOLEAN')
  })

  it('skip si juste wrapper sans boolean param', async () => {
    const facts = new Map([
      ['DriftSignalFact', 'src/wrap.ts\t10\twrapper-superfluous'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-double-drift-wrapper-boolean.dl', facts })
    expect(violations).toEqual([])
  })

  it('skip si juste boolean param sans wrapper', async () => {
    const facts = new Map([
      ['BooleanParam', 'src/api.ts\t10\tsendMessage\turgent\t1\t2'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-double-drift-wrapper-boolean.dl', facts })
    expect(violations).toEqual([])
  })
})

describe('composite-tainted-flow (Tier 10)', () => {
  it('flag flow http-route -> sink sans sanitizer (1 hop)', async () => {
    const facts = new Map([
      ['EntryPoint', 'src/api.ts\thttp-route\tPOST /api/run'],
      ['SymbolCallEdge', 'src/api.ts\thandler\tsrc/db.ts\tquery\t10'],
      ['TaintSink', 'src/db.ts\t20\tsql\tdb.query\tquery'],
      // Pas de SanitizerCall = aucun sanitizer dans le path
    ])
    const { violations } = await runRule({ ruleName: 'composite-tainted-flow.dl', facts })
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0][0]).toBe('COMPOSITE-TAINTED-FLOW')
  })

  it('skip si sanitizer dans le src file', async () => {
    const facts = new Map([
      ['EntryPoint', 'src/api.ts\thttp-route\tPOST /api/run'],
      ['SymbolCallEdge', 'src/api.ts\thandler\tsrc/db.ts\tquery\t10'],
      ['TaintSink', 'src/db.ts\t20\tsql\tdb.query\tquery'],
      ['SanitizerCall', 'src/api.ts\t5\tvalidateBody\thandler'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-tainted-flow.dl', facts })
    expect(violations).toEqual([])
  })

  it('skip si sanitizer dans le sink file', async () => {
    const facts = new Map([
      ['EntryPoint', 'src/api.ts\thttp-route\tPOST /api/run'],
      ['SymbolCallEdge', 'src/api.ts\thandler\tsrc/db.ts\tquery\t10'],
      ['TaintSink', 'src/db.ts\t20\tsql\tdb.query\tquery'],
      ['SanitizerCall', 'src/db.ts\t15\tparse\tquery'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-tainted-flow.dl', facts })
    expect(violations).toEqual([])
  })

  it('flag transitif (2 hops)', async () => {
    const facts = new Map([
      ['EntryPoint', 'src/api.ts\thttp-route\tPOST /api/run'],
      ['SymbolCallEdge', 'src/api.ts\thandler\tsrc/service.ts\tdoStuff\t10\nsrc/service.ts\tdoStuff\tsrc/db.ts\tquery\t20'],
      ['TaintSink', 'src/db.ts\t30\tsql\tdb.query\tquery'],
    ])
    const { violations } = await runRule({ ruleName: 'composite-tainted-flow.dl', facts })
    expect(violations.length).toBeGreaterThan(0)
  })

  it('skip si grandfathered par (sinkFile, sinkLine)', async () => {
    const schema = await loadRule('schema-subset.dl')
    const baseRule = await loadRule('composite-tainted-flow.dl')
    const customRule = baseRule + '\nTaintedFlowGrandfathered("src/db.ts", 20).\n'
    const program = mergePrograms([
      { name: 'schema.dl', content: schema },
      { name: 'rule.dl', content: customRule },
    ])
    const facts = new Map([
      ['EntryPoint', 'src/api.ts\thttp-route\tPOST /api/run'],
      ['SymbolCallEdge', 'src/api.ts\thandler\tsrc/db.ts\tquery\t10'],
      ['TaintSink', 'src/db.ts\t20\tsql\tdb.query\tquery'],
    ])
    const db = loadFacts(program.decls, { factsByRelation: facts })
    const result = evaluate(program, db, { allowRecursion: true })
    expect(result.outputs.get('Violation') ?? []).toEqual([])
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
    expect(program.decls.has('SqlPrimaryKey')).toBe(true)
    expect(program.decls.has('EvalCall')).toBe(true)
    expect(program.decls.has('HardcodedSecret')).toBe(true)
    expect(program.decls.has('BooleanParam')).toBe(true)
    expect(program.decls.has('DeadCode')).toBe(true)
    expect(program.decls.has('FloatingPromise')).toBe(true)
    expect(program.decls.has('DeprecatedDecl')).toBe(true)
    expect(program.decls.has('DeprecatedUsage')).toBe(true)
    expect(program.decls.has('ArticulationPoint')).toBe(true)
    expect(program.decls.has('SqlNamingViolation')).toBe(true)
    expect(program.decls.has('SqlMigrationOrderViolation')).toBe(true)
    expect(program.decls.has('ResourceImbalance')).toBe(true)
    expect(program.decls.has('TruthPointWriter')).toBe(true)
    expect(program.decls.has('TruthPointReader')).toBe(true)
    expect(program.decls.has('TestedFile')).toBe(true)
    expect(program.decls.has('DriftSignalFact')).toBe(true)
    expect(program.decls.has('CoChange')).toBe(true)
    expect(program.decls.has('TaintSink')).toBe(true)
    expect(program.decls.has('SanitizerCall')).toBe(true)
    expect(program.decls.has('Violation')).toBe(true)
    // Toutes les input relations sont marquées .input
    expect(program.decls.get('CycleNode')!.isInput).toBe(true)
    expect(program.decls.get('Violation')!.isOutput).toBe(true)
  })
})
