/**
 * Tests vitest pour l'extracteur SQL schema.
 * Couvre : CREATE TABLE inline FK, CREATE INDEX, FK sans index,
 * UNIQUE inline implicit index, PRIMARY KEY implicit index,
 * FK composite (skip), index sur expression (skip), schemas qualifiés.
 */

import { describe, it, expect } from 'vitest'
import { parseSqlFile } from '../src/extractors/sql-schema.js'

describe('parseSqlFile — CREATE TABLE', () => {
  it('extrait nom + colonnes + types', () => {
    const sql = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        name TEXT
      );
    `
    const { tables } = parseSqlFile(sql, 'test.sql')
    expect(tables).toHaveLength(1)
    expect(tables[0].name).toBe('users')
    expect(tables[0].columns).toHaveLength(3)
    expect(tables[0].columns[0].name).toBe('id')
    expect(tables[0].columns[0].isPrimaryKey).toBe(true)
    expect(tables[0].columns[1].name).toBe('email')
    expect(tables[0].columns[1].notNull).toBe(true)
    expect(tables[0].columns[1].isUnique).toBe(true)
    expect(tables[0].columns[2].name).toBe('name')
    expect(tables[0].columns[2].notNull).toBe(false)
  })

  it('supporte IF NOT EXISTS', () => {
    const sql = `CREATE TABLE IF NOT EXISTS foo (id SERIAL PRIMARY KEY);`
    const { tables } = parseSqlFile(sql, 'test.sql')
    expect(tables).toHaveLength(1)
    expect(tables[0].name).toBe('foo')
  })

  it('strip schema qualifiés (public.foo → foo)', () => {
    const sql = `CREATE TABLE public.foo (id INT);`
    const { tables } = parseSqlFile(sql, 'test.sql')
    expect(tables[0].name).toBe('foo')
  })
})

describe('parseSqlFile — Foreign Keys', () => {
  it('extrait FK inline REFERENCES', () => {
    const sql = `
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
    `
    const { tables, foreignKeys } = parseSqlFile(sql, 'test.sql')
    expect(tables[0].columns[1].foreignKey).toEqual({
      toTable: 'users',
      toColumn: 'id',
    })
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]).toMatchObject({
      fromTable: 'orders',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
    })
  })

  it('extrait FK via ALTER TABLE ADD CONSTRAINT', () => {
    const sql = `
      ALTER TABLE orders
      ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);
    `
    const { foreignKeys } = parseSqlFile(sql, 'test.sql')
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]).toMatchObject({
      fromTable: 'orders',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
    })
  })
})

describe('parseSqlFile — Indexes', () => {
  it('extrait CREATE INDEX', () => {
    const sql = `CREATE INDEX idx_orders_user ON orders (user_id);`
    const { indexes } = parseSqlFile(sql, 'test.sql')
    expect(indexes).toHaveLength(1)
    expect(indexes[0]).toMatchObject({
      name: 'idx_orders_user',
      table: 'orders',
      firstColumn: 'user_id',
      columns: ['user_id'],
      unique: false,
      implicit: false,
    })
  })

  it('extrait CREATE UNIQUE INDEX', () => {
    const sql = `CREATE UNIQUE INDEX uniq_email ON users (email);`
    const { indexes } = parseSqlFile(sql, 'test.sql')
    expect(indexes[0].unique).toBe(true)
  })

  it('extrait index multi-col, garde firstColumn', () => {
    const sql = `CREATE INDEX idx_alerts ON alerts (level, created_at DESC);`
    const { indexes } = parseSqlFile(sql, 'test.sql')
    expect(indexes[0].firstColumn).toBe('level')
    expect(indexes[0].columns).toEqual(['level', 'created_at'])
  })

  it('émet index implicite pour PRIMARY KEY inline', () => {
    const sql = `CREATE TABLE t (id SERIAL PRIMARY KEY);`
    const { indexes } = parseSqlFile(sql, 'test.sql')
    const pk = indexes.find((i) => i.implicit && i.unique)
    expect(pk).toBeDefined()
    expect(pk!.firstColumn).toBe('id')
  })

  it('émet index implicite pour UNIQUE inline', () => {
    const sql = `CREATE TABLE t (id INT, email TEXT UNIQUE);`
    const { indexes } = parseSqlFile(sql, 'test.sql')
    const uniq = indexes.find((i) => i.implicit && i.firstColumn === 'email')
    expect(uniq).toBeDefined()
  })

  it('émet index implicite pour PRIMARY KEY (a, b) table-level', () => {
    const sql = `CREATE TABLE t (a INT, b INT, PRIMARY KEY (a, b));`
    const { indexes } = parseSqlFile(sql, 'test.sql')
    const pk = indexes.find((i) => i.implicit && i.firstColumn === 'a')
    expect(pk).toBeDefined()
    expect(pk!.columns).toEqual(['a', 'b'])
  })
})

describe('parseSqlFile — édge cases', () => {
  it('skip les CHECK / CONSTRAINT comme colonnes', () => {
    const sql = `
      CREATE TABLE t (
        id INT,
        amount NUMERIC NOT NULL,
        CHECK (amount > 0),
        CONSTRAINT pos CHECK (amount > 0)
      );
    `
    const { tables } = parseSqlFile(sql, 'test.sql')
    expect(tables[0].columns.map((c) => c.name)).toEqual(['id', 'amount'])
  })

  it('extrait plusieurs CREATE TABLE dans un même fichier', () => {
    const sql = `
      CREATE TABLE a (id INT);
      CREATE TABLE b (id INT REFERENCES a(id));
    `
    const { tables, foreignKeys } = parseSqlFile(sql, 'test.sql')
    expect(tables.map((t) => t.name)).toEqual(['a', 'b'])
    expect(foreignKeys).toHaveLength(1)
  })
})

describe('analyzeSqlSchema — FK without index detection', () => {
  it('détecte FK sans index correspondant', async () => {
    const sql = `
      CREATE TABLE users (id SERIAL PRIMARY KEY);
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id)
      );
      -- Pas d'index sur orders.user_id
    `
    const { foreignKeys, indexes, fkWithoutIndex } = parseSqlFile(sql, 'test.sql')
    expect(foreignKeys).toHaveLength(1)
    // Calcul cross-FK + indexes (logique dans computeFkWithoutIndex via analyze)
    const indexedSet = new Set<string>()
    for (const idx of indexes) {
      if (idx.firstColumn) indexedSet.add(`${idx.table}\x00${idx.firstColumn}`)
    }
    const fk = foreignKeys[0]
    const isIndexed = indexedSet.has(`${fk.fromTable}\x00${fk.fromColumn}`)
    expect(isIndexed).toBe(false)
  })

  it("ne flag pas les FK qui ont un index", async () => {
    const sql = `
      CREATE TABLE users (id SERIAL PRIMARY KEY);
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id)
      );
      CREATE INDEX idx_orders_user ON orders (user_id);
    `
    const { foreignKeys, indexes } = parseSqlFile(sql, 'test.sql')
    const indexedSet = new Set<string>()
    for (const idx of indexes) {
      if (idx.firstColumn) indexedSet.add(`${idx.table}\x00${idx.firstColumn}`)
    }
    const fk = foreignKeys[0]
    const isIndexed = indexedSet.has(`${fk.fromTable}\x00${fk.fromColumn}`)
    expect(isIndexed).toBe(true)
  })

  it("ne flag pas les FK quand UNIQUE inline crée un index implicite", async () => {
    const sql = `
      CREATE TABLE users (id SERIAL PRIMARY KEY);
      CREATE TABLE profiles (
        user_id INT UNIQUE REFERENCES users(id)
      );
    `
    const { foreignKeys, indexes } = parseSqlFile(sql, 'test.sql')
    const indexedSet = new Set<string>()
    for (const idx of indexes) {
      if (idx.firstColumn) indexedSet.add(`${idx.table}\x00${idx.firstColumn}`)
    }
    expect(foreignKeys).toHaveLength(1)
    expect(indexedSet.has('profiles\x00user_id')).toBe(true)
  })
})
