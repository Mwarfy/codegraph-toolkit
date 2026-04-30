/**
 * Tests pour sql-migration-order (Phase 4 Tier 5).
 */

import { describe, it, expect } from 'vitest'
import { findMigrationOrderViolations } from '../src/extractors/sql-migration-order.js'

describe('sql-migration-order', () => {
  it('flag FK déclaré dans une migration avant la création de la table cible', () => {
    const schema = {
      tables: [
        { name: 'users', file: 'db/050_users.sql', line: 5 },
        { name: 'orders', file: 'db/010_orders.sql', line: 10 },
      ],
      foreignKeys: [
        // Migration 010 déclare un FK vers users qui est créée à 050.
        { fromTable: 'orders', fromColumn: 'user_id', toTable: 'users',
          file: 'db/010_orders.sql', line: 12 },
      ],
    }
    const v = findMigrationOrderViolations(schema)
    expect(v).toHaveLength(1)
    expect(v[0].fromTable).toBe('orders')
    expect(v[0].toTable).toBe('users')
    expect(v[0].fkMigrationNumber).toBe(10)
    expect(v[0].targetMigrationNumber).toBe(50)
  })

  it('skip ordre correct (table créée avant FK)', () => {
    const schema = {
      tables: [
        { name: 'users', file: 'db/010_users.sql', line: 5 },
        { name: 'orders', file: 'db/050_orders.sql', line: 10 },
      ],
      foreignKeys: [
        { fromTable: 'orders', fromColumn: 'user_id', toTable: 'users',
          file: 'db/050_orders.sql', line: 12 },
      ],
    }
    const v = findMigrationOrderViolations(schema)
    expect(v).toEqual([])
  })

  it('skip si même migration (FK et table dans le même file)', () => {
    const schema = {
      tables: [
        { name: 'users', file: 'db/010_init.sql', line: 5 },
        { name: 'orders', file: 'db/010_init.sql', line: 15 },
      ],
      foreignKeys: [
        { fromTable: 'orders', fromColumn: 'user_id', toTable: 'users',
          file: 'db/010_init.sql', line: 17 },
      ],
    }
    const v = findMigrationOrderViolations(schema)
    expect(v).toEqual([])
  })

  it('skip si table cible non versionnée (pas extracted)', () => {
    const schema = {
      tables: [],   // table cible inconnue
      foreignKeys: [
        { fromTable: 'orders', fromColumn: 'user_id', toTable: 'external_users',
          file: 'db/010_orders.sql', line: 12 },
      ],
    }
    const v = findMigrationOrderViolations(schema)
    expect(v).toEqual([])
  })

  it('skip si pattern de numérotation absent', () => {
    const schema = {
      tables: [
        { name: 'users', file: 'db/users.sql', line: 5 },
      ],
      foreignKeys: [
        { fromTable: 'orders', fromColumn: 'user_id', toTable: 'users',
          file: 'db/orders.sql', line: 12 },
      ],
    }
    const v = findMigrationOrderViolations(schema)
    expect(v).toEqual([])
  })

  it('utilise le PREMIER fichier où la table apparaît', () => {
    const schema = {
      tables: [
        // users défini dans 050 mais aussi un ALTER dans 100
        { name: 'users', file: 'db/050_users.sql', line: 5 },
        { name: 'users', file: 'db/100_users_alter.sql', line: 1 },
      ],
      foreignKeys: [
        { fromTable: 'orders', fromColumn: 'user_id', toTable: 'users',
          file: 'db/060_orders.sql', line: 12 },
      ],
    }
    // 060 vient APRÈS 050 (création initiale de users) → OK.
    const v = findMigrationOrderViolations(schema)
    expect(v).toEqual([])
  })

  it('supporte les date-based migration numbers', () => {
    const schema = {
      tables: [
        { name: 'users', file: 'db/20240115_users.sql', line: 5 },
      ],
      foreignKeys: [
        { fromTable: 'orders', fromColumn: 'user_id', toTable: 'users',
          file: 'db/20240114_orders.sql', line: 12 },   // 1 jour avant
      ],
    }
    const v = findMigrationOrderViolations(schema)
    expect(v).toHaveLength(1)
    expect(v[0].fkMigrationNumber).toBe(20240114)
    expect(v[0].targetMigrationNumber).toBe(20240115)
  })
})
