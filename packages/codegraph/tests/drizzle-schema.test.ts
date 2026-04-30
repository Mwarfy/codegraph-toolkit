/**
 * Tests vitest pour l'extracteur Drizzle schema.
 * Couvre : pgTable basique, FK via references(), indexes via 3e arg,
 * UNIQUE / PRIMARY KEY inline, FK without index detection.
 */

import { describe, it, expect } from 'vitest'
import { Project } from 'ts-morph'
import { parseDrizzleFile } from '../src/extractors/drizzle-schema.js'

function makeSourceFile(content: string) {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile('test.ts', content)
  return sf
}

describe('parseDrizzleFile — pgTable basics', () => {
  it('extrait une table simple avec colonnes typées', () => {
    const sf = makeSourceFile(`
      import { pgTable, uuid, text, integer } from 'drizzle-orm/pg-core'
      export const users = pgTable('users', {
        id: uuid('id').primaryKey().defaultRandom(),
        name: text('name').notNull(),
        age: integer('age'),
      })
    `)
    const { tables } = parseDrizzleFile(sf, 'test.ts')
    expect(tables).toHaveLength(1)
    expect(tables[0].name).toBe('users')
    expect(tables[0].columns.map((c) => c.name)).toEqual(['id', 'name', 'age'])
    expect(tables[0].columns[0].isPrimaryKey).toBe(true)
    expect(tables[0].columns[1].notNull).toBe(true)
    expect(tables[0].columns[2].notNull).toBe(false)
  })

  it('extrait FK via references(() => other.col)', () => {
    const sf = makeSourceFile(`
      import { pgTable, uuid } from 'drizzle-orm/pg-core'
      export const users = pgTable('users', {
        id: uuid('id').primaryKey().defaultRandom(),
      })
      export const orders = pgTable('orders', {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id').references(() => users.id),
      })
    `)
    const { tables, foreignKeys } = parseDrizzleFile(sf, 'test.ts')
    expect(tables).toHaveLength(2)
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0]).toMatchObject({
      fromTable: 'orders',
      fromColumn: 'user_id',
      toTable: 'users',
      toColumn: 'id',
    })
  })

  it('extrait FK avec onDelete option (Drizzle peut passer un objet 2e arg)', () => {
    const sf = makeSourceFile(`
      import { pgTable, uuid } from 'drizzle-orm/pg-core'
      export const users = pgTable('users', { id: uuid('id').primaryKey() })
      export const orders = pgTable('orders', {
        userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
      })
    `)
    const { foreignKeys } = parseDrizzleFile(sf, 'test.ts')
    expect(foreignKeys).toHaveLength(1)
    expect(foreignKeys[0].toTable).toBe('users')
  })
})

describe('parseDrizzleFile — Indexes', () => {
  it('extrait indexes via 3e arg (table) => ({ idx: index().on() })', () => {
    const sf = makeSourceFile(`
      import { pgTable, uuid, text, index, uniqueIndex } from 'drizzle-orm/pg-core'
      export const users = pgTable('users', {
        id: uuid('id').primaryKey(),
        email: text('email').notNull(),
        name: text('name'),
      }, (table) => ({
        emailIdx: uniqueIndex('email_idx').on(table.email),
        nameIdx: index('name_idx').on(table.name),
      }))
    `)
    const { indexes } = parseDrizzleFile(sf, 'test.ts')
    const explicit = indexes.filter((i) => !i.implicit)
    expect(explicit).toHaveLength(2)
    const emailIdx = explicit.find((i) => i.name === 'email_idx')
    expect(emailIdx).toBeDefined()
    expect(emailIdx!.unique).toBe(true)
    expect(emailIdx!.firstColumn).toBe('email')
    const nameIdx = explicit.find((i) => i.name === 'name_idx')
    expect(nameIdx!.unique).toBe(false)
  })

  it('extrait index multi-col, garde firstColumn', () => {
    const sf = makeSourceFile(`
      import { pgTable, uuid, text, index } from 'drizzle-orm/pg-core'
      export const items = pgTable('items', {
        id: uuid('id').primaryKey(),
        playerId: uuid('player_id'),
        equipped: text('equipped'),
      }, (table) => ({
        playerEquippedIdx: index('player_equipped').on(table.playerId, table.equipped),
      }))
    `)
    const { indexes } = parseDrizzleFile(sf, 'test.ts')
    const idx = indexes.find((i) => i.name === 'player_equipped')
    expect(idx).toBeDefined()
    expect(idx!.firstColumn).toBe('player_id')
    expect(idx!.columns).toEqual(['player_id', 'equipped'])
  })

  it('émet index implicite pour PRIMARY KEY', () => {
    const sf = makeSourceFile(`
      import { pgTable, uuid } from 'drizzle-orm/pg-core'
      export const t = pgTable('t', { id: uuid('id').primaryKey() })
    `)
    const { indexes } = parseDrizzleFile(sf, 'test.ts')
    const pk = indexes.find((i) => i.implicit && i.unique)
    expect(pk).toBeDefined()
    expect(pk!.firstColumn).toBe('id')
  })

  it('émet index implicite pour UNIQUE inline', () => {
    const sf = makeSourceFile(`
      import { pgTable, text } from 'drizzle-orm/pg-core'
      export const t = pgTable('t', {
        email: text('email').unique(),
      })
    `)
    const { indexes } = parseDrizzleFile(sf, 'test.ts')
    const uniq = indexes.find((i) => i.implicit && i.firstColumn === 'email')
    expect(uniq).toBeDefined()
    expect(uniq!.unique).toBe(true)
  })
})

describe('parseDrizzleFile — détection FK without index', () => {
  it('flag les FK sans index correspondant', () => {
    const sf = makeSourceFile(`
      import { pgTable, uuid } from 'drizzle-orm/pg-core'
      export const users = pgTable('users', { id: uuid('id').primaryKey() })
      export const posts = pgTable('posts', {
        id: uuid('id').primaryKey(),
        userId: uuid('user_id').references(() => users.id).notNull(),
      })
    `)
    const { foreignKeys, indexes } = parseDrizzleFile(sf, 'test.ts')
    // Vérifie qu'il n'y a pas d'index sur posts.user_id
    const indexedSet = new Set<string>()
    for (const idx of indexes) {
      if (idx.firstColumn) indexedSet.add(`${idx.table}\x00${idx.firstColumn}`)
    }
    const fk = foreignKeys[0]
    expect(indexedSet.has(`${fk.fromTable}\x00${fk.fromColumn}`)).toBe(false)
  })

  it("ne flag pas les FK qui ont un index dédié", () => {
    const sf = makeSourceFile(`
      import { pgTable, uuid, index } from 'drizzle-orm/pg-core'
      export const users = pgTable('users', { id: uuid('id').primaryKey() })
      export const posts = pgTable('posts', {
        userId: uuid('user_id').references(() => users.id).notNull(),
      }, (table) => ({
        userIdx: index('post_user_idx').on(table.userId),
      }))
    `)
    const { foreignKeys, indexes } = parseDrizzleFile(sf, 'test.ts')
    const indexedSet = new Set<string>()
    for (const idx of indexes) {
      if (idx.firstColumn) indexedSet.add(`${idx.table}\x00${idx.firstColumn}`)
    }
    const fk = foreignKeys[0]
    expect(indexedSet.has(`${fk.fromTable}\x00${fk.fromColumn}`)).toBe(true)
  })

  it('UNIQUE inline résout le besoin d\'index', () => {
    const sf = makeSourceFile(`
      import { pgTable, uuid } from 'drizzle-orm/pg-core'
      export const users = pgTable('users', { id: uuid('id').primaryKey() })
      export const profiles = pgTable('profiles', {
        userId: uuid('user_id').unique().references(() => users.id).notNull(),
      })
    `)
    const { foreignKeys, indexes } = parseDrizzleFile(sf, 'test.ts')
    const indexedSet = new Set<string>()
    for (const idx of indexes) {
      if (idx.firstColumn) indexedSet.add(`${idx.table}\x00${idx.firstColumn}`)
    }
    const fk = foreignKeys[0]
    expect(indexedSet.has(`${fk.fromTable}\x00${fk.fromColumn}`)).toBe(true)
  })
})
