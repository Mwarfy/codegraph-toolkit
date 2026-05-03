/**
 * SQL types partagés entre `sql-schema.ts` et `_shared/sql-helpers.ts`.
 *
 * Pourquoi ce fichier : avant ce split, sql-helpers importait des types
 * depuis sql-schema.ts, et sql-schema importait `computeFkWithoutIndex`
 * depuis sql-helpers.ts. Ce cycle direct (CYCLE structurel détecté par
 * codegraph statique) est cassé en extrayant les types canoniques ici.
 *
 * sql-schema.ts re-exporte ces types pour préserver l'API publique
 * existante (consumers externes important depuis '../sql-schema.js').
 */

export interface SqlIndex {
  name: string
  table: string
  /** Première colonne (utilisée pour matcher les FK). Skip si index sur expression. */
  firstColumn: string | null
  /** Toutes les colonnes (dans l'ordre). */
  columns: string[]
  /** True si index UNIQUE (incluant les contraintes UNIQUE inline). */
  unique: boolean
  /** True si index implicite (créé par PRIMARY KEY ou UNIQUE inline, pas via CREATE INDEX). */
  implicit: boolean
  file: string
  line: number
}

export interface SqlForeignKey {
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
  file: string
  line: number
}

export interface SqlFkWithoutIndex {
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
  file: string
  line: number
}
