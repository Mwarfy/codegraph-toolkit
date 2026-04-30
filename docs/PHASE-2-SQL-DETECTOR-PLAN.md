# Phase 2 — SQL schema detector pour invariants Postgres

> **Pour Claude qui reprend dans une nouvelle session :** lis CE FICHIER
> EN ENTIER avant toute action. Phase 2 du plan d'enrichissement après
> Phase 1 (B1-B4) livrée. Cf. `ENRICHMENT-5-AXES-PLAN.md`.

## Contexte

Phase 1 a posé : reverse-deps Dijkstra, watch wiring, PR diff, changes-since.
Le toolkit est mûr pour analyser du **SQL** (migrations Postgres) en plus du
TS — généraliste à tout projet React/TS/Node/Postgres (Sentinel, Morovar
futur, Voynich futur).

## Décision tech : pas de tree-sitter

Tree-sitter était mentionné dans la recherche (§6) comme option multi-langage.
Pour Postgres migrations, **overkill** :
- Le SQL des migrations Sentinel suit un pattern uniforme PostgreSQL
- Le détecteur `state-machines.ts` parse déjà du SQL avec des regex
  (cf. `scanSqlColumnDefaultsForIncremental`) — sans drama
- Tree-sitter ajouterait ~2 MB de WASM + complexité multi-grammar

**Approche** : extractor regex-based, comme state-machines. Si on
attaque un jour des SQL plus complexes (vues, fonctions PL/pgSQL,
CTEs imbriquées), on migrera vers tree-sitter à ce moment-là.

## Cible : invariants détectés

### 1. FK sans index (priorité haute)
```sql
CREATE TABLE entity_relationships (
  source_id UUID NOT NULL REFERENCES entities(id),  -- FK
  ...
);
-- ⚠ Si pas de CREATE INDEX sur (source_id), tout DELETE sur entities
-- déclenche un full scan de entity_relationships pour le CASCADE.
```

→ Émettre `SqlFkWithoutIndex(fromTable, fromCol)` quand un FK n'a pas
d'index correspondant sur sa colonne source.

### 2. (Stretch) Migration sans DOWN
Sentinel n'utilise pas le pattern UP/DOWN. À ignorer pour l'instant.

### 3. (Stretch) Colonne ajoutée NOT NULL sans default
```sql
ALTER TABLE foo ADD COLUMN bar TEXT NOT NULL;  -- ⚠ casse les rows existantes
```

À ajouter dans une v2 si demandé.

## Architecture

### Nouveau extractor : `extractors/sql-schema.ts`

```ts
export interface SqlTable {
  name: string
  file: string
  line: number
  columns: SqlColumn[]
}

export interface SqlColumn {
  name: string
  type: string
  notNull: boolean
  /** Référence FK inline si présente. */
  foreignKey?: { toTable: string; toColumn: string }
  line: number
}

export interface SqlIndex {
  name: string
  table: string
  /** Colonnes indexées (dans l'ordre, premier = principal). */
  columns: string[]
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

export interface SqlSchemaResult {
  tables: SqlTable[]
  indexes: SqlIndex[]
  foreignKeys: SqlForeignKey[]
  fkWithoutIndex: SqlFkWithoutIndex[]
}

export async function analyzeSqlSchema(
  rootDir: string,
  sqlGlobs?: string[],  // default ['**/*.sql']
): Promise<SqlSchemaResult>
```

### Algorithme regex

Pour CHAQUE fichier .sql trouvé via glob :

1. **CREATE TABLE** :
   ```regex
   /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s*\(([^;]+)\)/gi
   ```
   Pour le contenu entre parenthèses, splitter par virgules (en respectant
   les parenthèses imbriquées pour `DEFAULT (jsonb_build_object(...))`).
   Pour chaque déclaration de colonne :
   - Match nom + type
   - Match `REFERENCES table(col)` inline → FK
   - Match `NOT NULL` flag

2. **CREATE INDEX** :
   ```regex
   /CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/gi
   ```
   Capture nom + table + liste colonnes (split par `,`, strip ASC/DESC).

3. **ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY** :
   Pattern moins fréquent dans Sentinel mais à supporter.

4. **Cross-FK + index match** :
   Pour chaque FK `(fromTable, fromCol) → (toTable, toCol)` :
   - Cherche un index sur `fromTable` dont `columns[0] === fromCol`
   - Si absent → `fkWithoutIndex.push(...)`

### Déterminisme

- Tri stable sur `tables` par `(file, line)`, sur `indexes` idem, sur `fkWithoutIndex`.
- Toutes les regex en mode case-insensitive.
- Pas de dépendance sur ordre de discovery des fichiers (sort par filename
  avant scan).

### Détecteur dans le registry

```ts
// core/detectors/sql-schema-detector.ts
export class SqlSchemaDetector implements Detector<SqlSchemaResult> {
  readonly name = 'sql-schema'
  readonly factsOnlyEligible = true  // facts émis pour invariants Datalog

  async run(ctx: DetectorRunContext): Promise<SqlSchemaResult | undefined> {
    const enabled = (ctx.config.detectorOptions?.['sqlSchema']?.['enabled'] as boolean | undefined) ?? true
    if (!enabled) return undefined

    const opts = ctx.config.detectorOptions?.['sqlSchema'] ?? {}
    const globs = (opts['globs'] as string[] | undefined) ?? ['**/*.sql']
    return await analyzeSqlSchema(ctx.config.rootDir, globs)
  }
}
```

Enregistrer dans `analyzer.ts` après `state-machines` (qui parse déjà du SQL).

### Snapshot field

```ts
// core/types.ts
export interface GraphSnapshot {
  // ...
  sqlSchema?: {
    tables: SqlTable[]
    indexes: SqlIndex[]
    foreignKeys: SqlForeignKey[]
    fkWithoutIndex: SqlFkWithoutIndex[]
  }
}
```

Patch via `patchSnapshotWithDetectorResults` mapping `'sql-schema' → 'sqlSchema'`.

### Facts Datalog

Dans `packages/codegraph/src/facts/index.ts`, ajouter :

```
SqlTable(name:symbol, file:symbol, line:number)
SqlColumn(table:symbol, column:symbol, type:symbol, file:symbol, line:number)
SqlForeignKey(fromTable:symbol, fromCol:symbol, toTable:symbol, toCol:symbol, file:symbol, line:number)
SqlIndex(name:symbol, table:symbol, firstCol:symbol, file:symbol, line:number)
SqlFkWithoutIndex(fromTable:symbol, fromCol:symbol, toTable:symbol, toCol:symbol)
```

`firstCol` (première colonne de l'index) suffit pour l'invariant FK
(un index multi-col sert le FK si la première col matche).

### Rule Datalog côté Sentinel

```dl
// sentinel-core/invariants/sql-fk-needs-index.dl
//
// Rule: tout SqlForeignKey doit avoir un SqlIndex sur (fromTable, fromCol).
// Sinon, DELETE CASCADE = full scan = perf disaster prod.
//
// Pattern ratchet : `SqlFkIndexGrandfathered(table, col)` pour la dette
// historique. Aujourd'hui Sentinel a probablement N FKs non-indexés.
// Première run : générer la liste, l'ajouter en grandfathered, puis
// la rule attrape uniquement les nouvelles violations.

.decl SqlFkIndexGrandfathered(table: symbol, col: symbol)

// Bootstrap : à remplir avec les violations actuelles après première
// régen des facts. Pour chaque tuple SqlFkWithoutIndex, ajouter un
// SqlFkIndexGrandfathered. Bloque ensuite uniquement les nouveaux.

Violation("SQL-FK-INDEX", File, Line,
  "FK non indexé — DELETE CASCADE = full scan ; ajouter CREATE INDEX") :-
    SqlFkWithoutIndex(FromT, FromC, _, _),
    SqlForeignKey(FromT, FromC, _, _, File, Line),
    !SqlFkIndexGrandfathered(FromT, FromC).
```

## Pièges identifiés

### Piège 1 : INDEX UNIQUE constraint inline
```sql
CREATE TABLE foo (
  email TEXT UNIQUE,  -- crée un index implicite (côté Postgres)
  ...
);
```

Le `UNIQUE` inline crée un index. Le détecteur doit le compter comme
index sur `email`. Pareil pour `PRIMARY KEY` et `UNIQUE` constraints.

### Piège 2 : FK composite (multi-col)
```sql
FOREIGN KEY (a, b) REFERENCES other(x, y)
```

Pour l'instant, ne supporter que les FK mono-col (cas Sentinel à 99%).
Si une FK composite est trouvée, émettre un `SqlForeignKey` par paire
ou skip avec warning.

### Piège 3 : Index sur expression
```sql
CREATE INDEX idx_lower_email ON users (lower(email));
```

L'index est sur `lower(email)`, pas `email` directement. Notre matcher
naïf `firstCol === 'email'` raterait ça. Cas rare dans Sentinel — on
skip pour l'instant et on signale potentiellement comme "complex" plutôt
que "missing".

### Piège 4 : Column references qualifiées
```sql
REFERENCES public.users(id)
```

Nettoyer le préfixe `schema.` si présent (la plupart des migrations
Sentinel sont sans schema explicite).

### Piège 5 : Migrations qui DROP ou RENAME
```sql
ALTER TABLE foo DROP COLUMN bar;
ALTER TABLE foo RENAME COLUMN bar TO baz;
```

Le détecteur naïf agrège tous les `CREATE TABLE` et tous les `CREATE INDEX`
de toutes les migrations — donc une table droppée serait quand même
listée. Acceptable pour v1 : on regarde l'agrégat, pas la timeline.
Si on veut le state final, faut un mini-interpréteur de migrations.

## Plan d'attaque

### Étape 0 — Snapshot baseline (5min)
Pas de parité bit-pour-bit nécessaire — le snapshot ajoute un nouveau
champ. Mais noter avant/après pour validation.

### Étape 1 — Extractor (3-4h)
Créer `extractors/sql-schema.ts` + tests fixture (`tests/sql-schema.test.ts`)
avec 3 scenarios : FK avec index, FK sans index, UNIQUE inline.

### Étape 2 — Detector + analyzer wiring (1h)
Créer `core/detectors/sql-schema-detector.ts`. Register dans
`runDeterministicDetectors` (post-snapshot car n'a besoin que de
file system, pas du graph TS).

Wait : sql-schema est PRE-snapshot car il pourrait alimenter d'autres
détecteurs ? Non — il est stand-alone. POST-snapshot suffit, pattern
identique aux todos/long-functions.

### Étape 3 — Snapshot field + patch (15min)
Ajouter `sqlSchema?: SqlSchemaResult` dans GraphSnapshot. Patch via le
helper.

### Étape 4 — Facts Datalog (1h)
Étendre `facts/index.ts` avec les 5 nouvelles relations + schema.dl.

### Étape 5 — Rule Sentinel + ratchet (1h)
Créer `sentinel-core/invariants/sql-fk-needs-index.dl`. Première run
= générer la liste des FK actuels non-indexés, les ajouter au ratchet
`SqlFkIndexGrandfathered`. Test : 0 violations attendu (tout grandfathered).

### Étape 6 — Tests + commit (1h)
- 156→160 tests toolkit (ajouts fixture)
- 0 violation Datalog Sentinel
- Snapshot sentinel a `sqlSchema.tables.length > 0`

### Étape 7 — Doc + ADR (30min)
ADR Sentinel "FK doivent être indexés" + référence dans CLAUDE-CONTEXT brief.

## Estimation

**~7-9h de travail** soit 1 grosse session. Plus rapide que les 1 semaine
du plan original parce qu'on évite tree-sitter.

## Ce qui n'est PAS dans le scope Phase 2

- Migrations sans DOWN (Sentinel n'utilise pas le pattern)
- Colonne NOT NULL ajoutée sans default (v2 si demandé)
- Schema-level analysis (multi-schema Postgres) — Sentinel mono-schema
- DROP/RENAME timeline analysis — agrégat suffit pour v1
- Vues, fonctions PL/pgSQL, triggers — pas dans Sentinel
- Tree-sitter migration — uniquement si on attaque du SQL plus complexe
