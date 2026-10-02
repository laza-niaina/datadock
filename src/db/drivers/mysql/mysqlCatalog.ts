/**
 * MySQL / MariaDB catalog queries and pure row-to-model mappers.
 *
 * Everything here is socket-free and I/O-free on purpose: `node --test` covers
 * the SQL text and the mapping rules without a live server. The driver module
 * feeds real `mysql2` rows into these functions; rows are cast once at that
 * boundary (`as unknown as MysqlRow[]`), so this module only ever sees
 * `Record<string, unknown>`.
 *
 * Aliases in the SQL are mandatory, not cosmetic: MySQL and MariaDB differ in
 * how they case information_schema column names, and the alias pins the mapper
 * contract to a stable lowercase name.
 */

import { DbError } from '../../errors';
import type { ColumnInfo, ForeignKeyInfo, RelationColumns, RoutineInfo, SchemaRef, TableInfo } from '../../types';

export interface MysqlRow {
  readonly [column: string]: unknown;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export const MYSQL_SQL = {
  /** Zero parameters. */
  databases: `
    SELECT s.SCHEMA_NAME AS schemaName
      FROM information_schema.SCHEMATA s
     ORDER BY s.SCHEMA_NAME`,
  /** 1 parameter: schema (a MySQL "schema" is a database). */
  tables: `
    SELECT t.TABLE_NAME    AS tableName,
           t.TABLE_TYPE    AS tableType,
           t.ENGINE        AS engine,
           t.TABLE_COMMENT AS comment
      FROM information_schema.TABLES t
     WHERE t.TABLE_SCHEMA = ?
     ORDER BY t.TABLE_NAME`,
  /** 2 parameters: schema, table. */
  columns: `
    SELECT c.COLUMN_NAME       AS columnName,
           c.COLUMN_TYPE       AS columnType,
           c.DATA_TYPE         AS dataType,
           c.IS_NULLABLE       AS isNullable,
           c.COLUMN_DEFAULT    AS columnDefault,
           c.COLUMN_COMMENT    AS comment,
           c.ORDINAL_POSITION  AS ordinal,
           c.EXTRA             AS extra,
           IF(k.COLUMN_NAME IS NULL, 0, 1) AS isPrimaryKey,
           IF(fk.COLUMN_NAME IS NULL, 0, 1) AS isForeignKey
      FROM information_schema.COLUMNS c
      LEFT JOIN information_schema.KEY_COLUMN_USAGE k
             ON k.TABLE_SCHEMA    = c.TABLE_SCHEMA
            AND k.TABLE_NAME      = c.TABLE_NAME
            AND k.COLUMN_NAME     = c.COLUMN_NAME
            AND k.CONSTRAINT_NAME = 'PRIMARY'
      LEFT JOIN (
        SELECT DISTINCT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
          FROM information_schema.KEY_COLUMN_USAGE kcu
         WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ) fk
             ON fk.TABLE_SCHEMA = c.TABLE_SCHEMA
            AND fk.TABLE_NAME   = c.TABLE_NAME
            AND fk.COLUMN_NAME  = c.COLUMN_NAME
     WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
     ORDER BY c.ORDINAL_POSITION`,
  /**
   * 1 parameter: schema. The same columns as `columns` for **every** relation
   * of the schema at once, so the ER diagram never issues one query per table.
   */
  schemaColumns: `
    SELECT c.TABLE_NAME        AS tableName,
           c.COLUMN_NAME       AS columnName,
           c.COLUMN_TYPE       AS columnType,
           c.DATA_TYPE         AS dataType,
           c.IS_NULLABLE       AS isNullable,
           c.COLUMN_DEFAULT    AS columnDefault,
           c.COLUMN_COMMENT    AS comment,
           c.ORDINAL_POSITION  AS ordinal,
           c.EXTRA             AS extra,
           IF(k.COLUMN_NAME IS NULL, 0, 1) AS isPrimaryKey,
           IF(fk.COLUMN_NAME IS NULL, 0, 1) AS isForeignKey
      FROM information_schema.COLUMNS c
      LEFT JOIN information_schema.KEY_COLUMN_USAGE k
             ON k.TABLE_SCHEMA    = c.TABLE_SCHEMA
            AND k.TABLE_NAME      = c.TABLE_NAME
            AND k.COLUMN_NAME     = c.COLUMN_NAME
            AND k.CONSTRAINT_NAME = 'PRIMARY'
      LEFT JOIN (
        SELECT DISTINCT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME
          FROM information_schema.KEY_COLUMN_USAGE kcu
         WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ) fk
             ON fk.TABLE_SCHEMA = c.TABLE_SCHEMA
            AND fk.TABLE_NAME   = c.TABLE_NAME
            AND fk.COLUMN_NAME  = c.COLUMN_NAME
     WHERE c.TABLE_SCHEMA = ?
     ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
  /** 1 parameter: schema. */
  routines: `
    SELECT r.ROUTINE_NAME AS routineName, r.ROUTINE_TYPE AS routineType
      FROM information_schema.ROUTINES r
     WHERE r.ROUTINE_SCHEMA = ?
     ORDER BY r.ROUTINE_NAME`,
  /**
   * 1 parameter: schema. One catalog-wide pass returns both ends of every
   * foreign key of the schema - never one query per table.
   */
  foreignKeys: `
    SELECT kcu.CONSTRAINT_NAME       AS constraintName,
           kcu.TABLE_SCHEMA          AS sourceSchema,
           kcu.TABLE_NAME            AS sourceTable,
           kcu.COLUMN_NAME           AS sourceColumn,
           kcu.REFERENCED_TABLE_SCHEMA AS targetSchema,
           kcu.REFERENCED_TABLE_NAME   AS targetTable,
           kcu.REFERENCED_COLUMN_NAME  AS targetColumn,
           kcu.ORDINAL_POSITION      AS ordinal
      FROM information_schema.KEY_COLUMN_USAGE kcu
     WHERE kcu.TABLE_SCHEMA = ?
       AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** MySQL boolean-typed columns may arrive as `1`/`'1'`/`true`/`0`/`null`. */
export function toBool(value: unknown): boolean {
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return value.trim() === '1';
  }
  return value === true;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return typeof value === 'number' ? String(value) : undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The scope every metadata query runs against: the ref's schema when present,
 * otherwise the database (they are the same thing in MySQL).
 */
export function mysqlScope(ref: SchemaRef): string {
  const scope = ref.schema?.trim() || ref.database?.trim() || '';
  if (scope === '') {
    throw new DbError('CONFIG_ERROR', 'No database was selected for this metadata query.');
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

const SYSTEM_SCHEMAS = new Set(['information_schema', 'performance_schema', 'sys']);

export function toDatabaseNames(rows: readonly MysqlRow[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const name = text(row['schemaName']);
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Drops the system schemas nobody browses, while keeping a name the user
 * explicitly configured as the connection's database.
 */
export function filterSystemSchemas(names: readonly string[], requestedDatabase?: string): string[] {
  const requested = requestedDatabase?.trim();
  return names.filter((name) => !SYSTEM_SCHEMAS.has(name) || name === requested);
}


// ---------------------------------------------------------------------------
// Tables / views
// ---------------------------------------------------------------------------

export function toTableInfos(rows: readonly MysqlRow[]): TableInfo[] {
  const tables: TableInfo[] = [];
  for (const row of rows) {
    const name = text(row['tableName']);
    if (name === undefined) {
      continue;
    }
    const tableType = text(row['tableType']) ?? '';
    const kind: TableInfo['kind'] = /VIEW$/i.test(tableType) ? 'view' : 'table';
    const engine = text(row['engine']);
    tables.push({
      name,
      kind,
      tableType: kind === 'view' ? tableType || undefined : engine ?? (tableType || undefined),
      comment: text(row['comment']),
    });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** `EXTRA` carries `auto_increment` - but also unrelated words like `GENERATED`. */
export function isAutoIncrementColumn(extra: unknown): boolean {
  return typeof extra === 'string' && /\bauto_increment\b/i.test(extra);
}

/**
 * `IS_NULLABLE` is the string 'YES'/'NO' in information_schema, not a `1`/`0`
 * boolean column, so `toBool` would read 'YES' as false.
 */
function toNullable(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().toUpperCase() !== 'NO' : toBool(value);
}

export function toColumnInfos(rows: readonly MysqlRow[]): ColumnInfo[] {
  const columns: ColumnInfo[] = [];
  rows.forEach((row, index) => {
    const name = text(row['columnName']);
    if (name === undefined) {
      return;
    }
    const ordinalRaw = Number(row['ordinal']);
    columns.push({
      name,
      dataType: text(row['columnType']) ?? text(row['dataType']) ?? 'UNKNOWN',
      nullable: toNullable(row['isNullable']),
      isPrimaryKey: toBool(row['isPrimaryKey']),
      isForeignKey: toBool(row['isForeignKey']),
      isAutoIncrement: isAutoIncrementColumn(row['extra']),
      defaultValue:
        row['columnDefault'] === undefined
          ? undefined
          : row['columnDefault'] === null
            ? null
            : String(row['columnDefault']),
      comment: text(row['comment']),
      ordinal: Number.isFinite(ordinalRaw) && ordinalRaw > 0 ? ordinalRaw : index + 1,
    });
  });
  return columns;
}

// ---------------------------------------------------------------------------
// Schema-wide columns (ER diagram)
// ---------------------------------------------------------------------------

/**
 * Groups `schemaColumns` rows into one entry per relation.
 *
 * The query orders by `TABLE_NAME` first, but grouping by name (not by
 * contiguity) keeps the mapper correct even if the engine reorders rows.
 */
export function toRelationColumns(rows: readonly MysqlRow[]): RelationColumns[] {
  const groups = new Map<string, MysqlRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    const table = text(row['tableName']);
    if (table === undefined) {
      continue;
    }
    let bucket = groups.get(table);
    if (bucket === undefined) {
      bucket = [];
      groups.set(table, bucket);
      order.push(table);
    }
    bucket.push(row);
  }
  return order.map((table) => ({ table, columns: toColumnInfos(groups.get(table) ?? []) }));
}

// ---------------------------------------------------------------------------
// Foreign keys (ER diagram)
// ---------------------------------------------------------------------------

/**
 * Maps the catalog-wide `foreignKeys` rows into `ForeignKeyInfo`.
 *
 * Rows with no referenced table (self-describing key usage) are dropped, which
 * is what makes this query safe to run over a whole schema.
 */
export function toForeignKeyInfos(rows: readonly MysqlRow[]): ForeignKeyInfo[] {
  const keys: ForeignKeyInfo[] = [];
  for (const row of rows) {
    const sourceTable = text(row['sourceTable']);
    const sourceColumn = text(row['sourceColumn']);
    const targetTable = text(row['targetTable']);
    if (sourceTable === undefined || sourceColumn === undefined || targetTable === undefined) {
      continue;
    }
    const ordinalRaw = Number(row['ordinal']);
    keys.push({
      name: text(row['constraintName']),
      sourceSchema: text(row['sourceSchema']),
      sourceTable,
      sourceColumn,
      targetSchema: text(row['targetSchema']),
      targetTable,
      targetColumn: text(row['targetColumn']),
      ordinal: Number.isFinite(ordinalRaw) && ordinalRaw > 0 ? ordinalRaw : keys.length + 1,
    });
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export function toRoutineInfos(rows: readonly MysqlRow[]): RoutineInfo[] {
  const routines: RoutineInfo[] = [];
  for (const row of rows) {
    const name = text(row['routineName']);
    if (name === undefined) {
      continue;
    }
    const routineType = text(row['routineType']);
    routines.push({
      name,
      kind: routineType?.toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function',
      routineType,
    });
  }
  return routines;
}
