/**
 * SQL Server catalog queries and pure row-to-model mappers.
 *
 * Everything here is socket-free and I/O-free on purpose: `node --test` covers
 * the SQL text and the mapping rules without a live server. The driver module
 * feeds real `mssql` rows into these functions; rows are cast once at that
 * boundary (`as unknown as MssqlRow[]`), so this module only ever sees
 * `Record<string, unknown>`.
 *
 * Column aliases end in a stable lowercase name: INFORMATION_SCHEMA returns its
 * columns in any case, and SQL Server's default collation makes comparisons
 * case-insensitive, so the mappers must not depend on the casing.
 */

import { DbError } from '../../errors';
import type { ColumnInfo, ForeignKeyInfo, RelationColumns, RoutineInfo, SchemaRef, TableInfo } from '../../types';

export interface MssqlRow {
  readonly [column: string]: unknown;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export const MSSQL_SQL = {
  /** Zero parameters. System databases are filtered in the mapper, not here. */
  databases: `
    SELECT name AS schemaName
      FROM sys.databases
     ORDER BY name`,
  /** Zero parameters. Fixed schema/role names are filtered in the mapper. */
  schemas: `
    SELECT s.name AS schemaName
      FROM sys.schemas s
     WHERE s.name NOT IN ('sys', 'INFORMATION_SCHEMA', 'guest')
       AND s.name NOT LIKE 'db_%'
     ORDER BY s.name`,
  /** 1 parameter: schema. INFORMATION_SCHEMA already returns `BASE TABLE`/`VIEW`. */
  tables: `
    SELECT TABLE_NAME  AS tableName,
           TABLE_TYPE  AS tableType
      FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = @p1
     ORDER BY TABLE_NAME`,
  /** 2 parameters: schema, table. Schema appears once for the OBJECT_ID lookup. */
  columns: `
    SELECT c.COLUMN_NAME          AS columnName,
           c.DATA_TYPE            AS dataType,
           c.CHARACTER_MAXIMUM_LENGTH AS charLength,
           c.NUMERIC_PRECISION    AS numPrecision,
           c.NUMERIC_SCALE        AS numScale,
           c.IS_NULLABLE          AS isNullable,
           c.COLUMN_DEFAULT       AS columnDefault,
           c.ORDINAL_POSITION     AS ordinal,
           COLUMNPROPERTY(OBJECT_ID(@p1 + '.' + @p2), c.COLUMN_NAME, 'IsIdentity') AS isIdentity,
           CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS isPrimaryKey,
           CASE WHEN fk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS isForeignKey
      FROM INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN (
        SELECT kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
           AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
           AND tc.TABLE_NAME        = kcu.TABLE_NAME
         WHERE kcu.TABLE_SCHEMA = @p1
           AND kcu.TABLE_NAME   = @p2
           AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
      LEFT JOIN (
        SELECT DISTINCT kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         WHERE kcu.TABLE_SCHEMA = @p1
           AND kcu.TABLE_NAME   = @p2
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ) fk ON fk.COLUMN_NAME = c.COLUMN_NAME
     WHERE c.TABLE_SCHEMA = @p1
       AND c.TABLE_NAME   = @p2
     ORDER BY c.ORDINAL_POSITION`,
  /**
   * 1 parameter: schema. The same columns as `columns` for **every** relation
   * of the schema at once, so the ER diagram never issues one query per table.
   * The identity lookup is rebuilt per row from `OBJECT_ID`, which is what
   * removes the table parameter.
   */
  schemaColumns: `
    SELECT c.TABLE_NAME            AS tableName,
           c.COLUMN_NAME           AS columnName,
           c.DATA_TYPE             AS dataType,
           c.CHARACTER_MAXIMUM_LENGTH AS charLength,
           c.NUMERIC_PRECISION     AS numPrecision,
           c.NUMERIC_SCALE         AS numScale,
           c.IS_NULLABLE           AS isNullable,
           c.COLUMN_DEFAULT        AS columnDefault,
           c.ORDINAL_POSITION      AS ordinal,
           COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)), c.COLUMN_NAME, 'IsIdentity') AS isIdentity,
           CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS isPrimaryKey,
           CASE WHEN fk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS isForeignKey
      FROM INFORMATION_SCHEMA.COLUMNS c
      LEFT JOIN (
        SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            ON tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
           AND tc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
           AND tc.TABLE_NAME        = kcu.TABLE_NAME
         WHERE kcu.TABLE_SCHEMA = @p1
           AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ) pk ON pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
      LEFT JOIN (
        SELECT DISTINCT kcu.TABLE_NAME, kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         WHERE kcu.TABLE_SCHEMA = @p1
           AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ) fk ON fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME
     WHERE c.TABLE_SCHEMA = @p1
     ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
  /** 1 parameter: schema. */
  routines: `
    SELECT ROUTINE_NAME AS routineName,
           ROUTINE_TYPE AS routineType
      FROM INFORMATION_SCHEMA.ROUTINES
     WHERE ROUTINE_SCHEMA = @p1
     ORDER BY ROUTINE_NAME`,
  /**
   * 1 parameter: schema. One catalog-wide pass over `sys.foreign_keys` yields
   * both ends of every foreign key of the schema - never one query per table.
   */
  foreignKeys: `
    SELECT fk.name                                   AS constraintName,
           OBJECT_SCHEMA_NAME(fk.parent_object_id)   AS sourceSchema,
           st.name                                   AS sourceTable,
           sc.name                                   AS sourceColumn,
           OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS targetSchema,
           rt.name                                   AS targetTable,
           rc.name                                   AS targetColumn,
           fkc.constraint_column_id                 AS ordinal
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.tables st  ON st.object_id  = fk.parent_object_id
      JOIN sys.columns sc ON sc.object_id  = fkc.parent_object_id
                         AND sc.column_id  = fkc.parent_column_id
      JOIN sys.tables rt  ON rt.object_id  = fk.referenced_object_id
      JOIN sys.columns rc ON rc.object_id  = fkc.referenced_object_id
                         AND rc.column_id  = fkc.referenced_column_id
     WHERE OBJECT_SCHEMA_NAME(fk.parent_object_id) = @p1
     ORDER BY fk.name, fkc.constraint_column_id`,
} as const;

/** Databases created by the server that users never query. */
const SYSTEM_DATABASES = new Set(['master', 'tempdb', 'model', 'msdb']);

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toDatabaseNames(rows: readonly MssqlRow[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    const name = typeof row['schemaName'] === 'string' ? row['schemaName'].trim() : '';
    if (name !== '') {
      names.push(name);
    }
  }
  return names;
}

/**
 * Drops system databases but always keeps a database the profile explicitly
 * configured, even when it looks system-generated.
 */
export function filterSystemDatabases(names: readonly string[], configuredDatabase?: string): string[] {
  const keep = configuredDatabase?.trim();
  return names.filter((name) => (SYSTEM_DATABASES.has(name) && name !== keep) === false);
}

/** Built-in schemas users never query (fixed db roles are already filtered in SQL). */
const SYSTEM_SCHEMAS = new Set(['sys', 'INFORMATION_SCHEMA', 'guest']);

/** Drops built-in schemas while keeping `dbo` (the default application schema). */
export function filterSystemSchemas(names: readonly string[]): string[] {
  return names.filter((name) => !SYSTEM_SCHEMAS.has(name) && !name.toLowerCase().startsWith('db_'));
}

export function toBool(value: unknown): boolean {
  if (value === true || value === 1 || value === '1' || value === 'Y' || value === 'y') {
    return true;
  }
  return false;
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  return text === '' ? null : text;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toTableInfos(rows: readonly MssqlRow[]): TableInfo[] {
  return rows.map((row) => {
    const name = String(row['tableName'] ?? '');
    const tableType = toNullableString(row['tableType']) ?? 'BASE TABLE';
    return {
      name,
      kind: tableType === 'VIEW' ? 'view' : 'table',
      tableType,
      comment: undefined,
    };
  });
}

/**
 * Reconstructs a displayable type from INFORMATION_SCHEMA's split columns:
 * `varchar(50)`, `nvarchar(max)`, `decimal(18,2)`; everything else keeps the
 * raw `DATA_TYPE`.
 */
export function mssqlDataType(row: MssqlRow): string {
  const base = String(row['dataType'] ?? '').toLowerCase();
  if (base === '') {
    return '';
  }
  const length = toNullableNumber(row['charLength']);
  const precision = toNullableNumber(row['numPrecision']);
  const scale = toNullableNumber(row['numScale']);
  if (/char|binary/.test(base) && length !== null) {
    return length < 0 ? `${base}(max)` : `${base}(${length})`;
  }
  if ((base === 'decimal' || base === 'numeric') && precision !== null && scale !== null) {
    return `${base}(${precision},${scale})`;
  }
  return base;
}

export function toColumnInfos(rows: readonly MssqlRow[]): ColumnInfo[] {
  return rows.map((row, index) => ({
    name: String(row['columnName'] ?? ''),
    dataType: mssqlDataType(row),
    nullable: toNullableString(row['isNullable']) === 'YES',
    isPrimaryKey: toBool(row['isPrimaryKey']),
    isForeignKey: toBool(row['isForeignKey']),
    isAutoIncrement: toBool(row['isIdentity']),
    defaultValue: toNullableString(row['columnDefault']),
    ordinal: toOrdinal(row['ordinal'], index),
  }));
}

/** The ordinal is a real `ORDINAL_POSITION` (1-based); fall back to array index. */
function toOrdinal(value: unknown, index: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return value;
  }
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return index + 1;
}

export function toRoutineInfos(rows: readonly MssqlRow[]): RoutineInfo[] {
  return rows.map((row) => {
    const routineType = toNullableString(row['routineType']) ?? 'FUNCTION';
    return {
      name: String(row['routineName'] ?? ''),
      kind: routineType === 'PROCEDURE' ? 'procedure' : 'function',
      routineType,
    };
  });
}

// ---------------------------------------------------------------------------
// Schema-wide columns (ER diagram)
// ---------------------------------------------------------------------------

/**
 * Groups `schemaColumns` rows into one entry per relation.
 *
 * Grouping by name (not by contiguity) keeps the mapper correct even if the
 * engine reorders rows.
 */
export function toRelationColumns(rows: readonly MssqlRow[]): RelationColumns[] {
  const groups = new Map<string, MssqlRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    const table = String(row['tableName'] ?? '');
    if (table === '') {
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

/** Maps the catalog-wide `foreignKeys` rows into `ForeignKeyInfo`. */
export function toForeignKeyInfos(rows: readonly MssqlRow[]): ForeignKeyInfo[] {
  const keys: ForeignKeyInfo[] = [];
  for (const row of rows) {
    const sourceTable = toNullableString(row['sourceTable']);
    const sourceColumn = toNullableString(row['sourceColumn']);
    const targetTable = toNullableString(row['targetTable']);
    if (sourceTable === null || sourceColumn === null || targetTable === null) {
      continue;
    }
    keys.push({
      name: toNullableString(row['constraintName']) ?? undefined,
      sourceSchema: toNullableString(row['sourceSchema']) ?? undefined,
      sourceTable,
      sourceColumn,
      targetSchema: toNullableString(row['targetSchema']) ?? undefined,
      targetTable,
      targetColumn: toNullableString(row['targetColumn']) ?? undefined,
      ordinal: toOrdinal(row['ordinal'], keys.length),
    });
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** SQL Server identifiers are bracketed; embedded right brackets are doubled. */
export function quoteMssqlIdentifier(name: string): string {
  return `[${name.replace(/\]/g, ']]')}]`;
}

/**
 * A SQL Server schema IS the scoping level below the database. The explorer
 * always passes a schema; falling back to the database keeps the contract
 * truthful for hand-built refs.
 */
export function mssqlScope(ref: SchemaRef): string {
  const schema = ref.schema?.trim();
  if (schema !== undefined && schema !== '') {
    return schema;
  }
  const database = ref.database?.trim();
  if (database !== undefined && database !== '') {
    return database;
  }
  throw new DbError('CONFIG_ERROR', 'A schema is required for SQL Server relations.');
}