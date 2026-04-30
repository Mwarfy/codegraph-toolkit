/**
 * Tests pour sql-naming (Phase 4 Tier 5).
 */

import { describe, it, expect } from 'vitest'
import { findSqlNamingViolations } from '../src/extractors/sql-naming.js'

function schema(opts: {
  tables?: Array<{ name: string; cols?: Array<{ name: string; type?: string }> }>
  fks?: Array<{ fromTable: string; fromCol: string }>
}) {
  return {
    tables: (opts.tables ?? []).map((t) => ({
      name: t.name,
      file: 'db/schema.sql',
      line: 1,
      columns: (t.cols ?? []).map((c, i) => ({
        name: c.name,
        type: c.type ?? 'TEXT',
        line: 2 + i,
      })),
    })),
    foreignKeys: (opts.fks ?? []).map((fk) => ({
      fromTable: fk.fromTable,
      fromColumn: fk.fromCol,
      file: 'db/schema.sql',
      line: 10,
    })),
  }
}

describe('sql-naming — table snake_case', () => {
  it('flag camelCase table name', () => {
    const v = findSqlNamingViolations(schema({ tables: [{ name: 'userSessions' }] }))
    expect(v).toHaveLength(1)
    expect(v[0].kind).toBe('table-not-snake-case')
    expect(v[0].table).toBe('userSessions')
  })

  it('flag PascalCase table name', () => {
    const v = findSqlNamingViolations(schema({ tables: [{ name: 'Users' }] }))
    expect(v[0].kind).toBe('table-not-snake-case')
  })

  it('skip snake_case correct', () => {
    const v = findSqlNamingViolations(schema({ tables: [{ name: 'user_sessions' }] }))
    expect(v).toEqual([])
  })
})

describe('sql-naming — column snake_case', () => {
  it('flag camelCase column', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'users', cols: [{ name: 'firstName' }] }],
    }))
    expect(v[0].kind).toBe('column-not-snake-case')
  })

  it('skip si tous snake_case', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'users', cols: [{ name: 'first_name' }, { name: 'email' }] }],
    }))
    expect(v).toEqual([])
  })
})

describe('sql-naming — timestamp _at suffix', () => {
  it('flag column TIMESTAMP sans _at', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'events', cols: [{ name: 'happened', type: 'TIMESTAMPTZ' }] }],
    }))
    expect(v[0].kind).toBe('timestamp-missing-at-suffix')
  })

  it('skip column TIMESTAMP avec _at', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'events', cols: [{ name: 'created_at', type: 'TIMESTAMPTZ' }] }],
    }))
    expect(v).toEqual([])
  })

  it('skip column avec suffix _date (alternative sémantique)', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'users', cols: [{ name: 'birth_date', type: 'DATE' }] }],
    }))
    expect(v).toEqual([])
  })

  it('ne flag PAS un type non-temporel sans _at', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'users', cols: [{ name: 'name', type: 'TEXT' }] }],
    }))
    expect(v).toEqual([])
  })
})

describe('sql-naming — FK _id suffix', () => {
  it('flag FK column sans _id suffix', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'orders', cols: [{ name: 'customer', type: 'INT' }] }],
      fks: [{ fromTable: 'orders', fromCol: 'customer' }],
    }))
    expect(v[0].kind).toBe('fk-missing-id-suffix')
  })

  it('skip FK column avec _id', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'orders', cols: [{ name: 'customer_id', type: 'INT' }] }],
      fks: [{ fromTable: 'orders', fromCol: 'customer_id' }],
    }))
    expect(v).toEqual([])
  })
})
