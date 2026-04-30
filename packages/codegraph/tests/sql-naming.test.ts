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
    const v = findSqlNamingViolations(schema({ tables: [{ name: 'user_settings' }] }))
    expect(v.filter((x) => x.kind === 'table-not-snake-case')).toEqual([])
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
      tables: [{ name: 'metrics', cols: [{ name: 'happened', type: 'TIMESTAMPTZ' }] }],
    }))
    expect(v[0].kind).toBe('timestamp-missing-at-suffix')
  })

  it('skip column TIMESTAMP avec _at', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'metrics', cols: [{ name: 'created_at', type: 'TIMESTAMPTZ' }] }],
    }))
    expect(v.filter((x) => x.kind === 'timestamp-missing-at-suffix')).toEqual([])
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
      tables: [{ name: 'metrics', cols: [{ name: 'customer', type: 'INT' }] }],
      fks: [{ fromTable: 'metrics', fromCol: 'customer' }],
    }))
    expect(v.find((x) => x.kind === 'fk-missing-id-suffix')).toBeDefined()
  })

  it('skip FK column avec _id', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'metrics', cols: [{ name: 'customer_id', type: 'INT' }] }],
      fks: [{ fromTable: 'metrics', fromCol: 'customer_id' }],
    }))
    expect(v.filter((x) => x.kind === 'fk-missing-id-suffix')).toEqual([])
  })
})

describe('sql-naming — audit columns required (Tier 6)', () => {
  it('flag table audit-required sans created_at', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'orders', cols: [
        { name: 'id', type: 'SERIAL' },
        { name: 'updated_at', type: 'TIMESTAMPTZ' },
      ] }],
    }))
    expect(v.find((x) => x.kind === 'audit-column-missing-created-at')).toBeDefined()
  })

  it('flag table mutable audit-required sans updated_at', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'orders', cols: [
        { name: 'id', type: 'SERIAL' },
        { name: 'created_at', type: 'TIMESTAMPTZ' },
      ] }],
    }))
    expect(v.find((x) => x.kind === 'audit-column-missing-updated-at')).toBeDefined()
  })

  it('skip updated_at pour table append-only (events / log / history)', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'audit_events', cols: [
        { name: 'id', type: 'SERIAL' },
        { name: 'created_at', type: 'TIMESTAMPTZ' },
      ] }],
    }))
    expect(v.filter((x) => x.kind === 'audit-column-missing-updated-at')).toEqual([])
  })

  it('skip si table non-audit (ex: settings, config)', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'settings', cols: [{ name: 'key', type: 'TEXT' }] }],
    }))
    expect(v.filter((x) =>
      x.kind === 'audit-column-missing-created-at' ||
      x.kind === 'audit-column-missing-updated-at',
    )).toEqual([])
  })

  it('flag table avec pattern ORDERS sans aucune audit column', () => {
    const v = findSqlNamingViolations(schema({
      tables: [{ name: 'orders', cols: [{ name: 'id', type: 'SERIAL' }] }],
    }))
    const kinds = v.map((x) => x.kind).sort()
    expect(kinds).toContain('audit-column-missing-created-at')
    expect(kinds).toContain('audit-column-missing-updated-at')
  })
})
