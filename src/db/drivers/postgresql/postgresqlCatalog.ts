/**
 * PostgreSQL catalog queries and pure row-to-model mappers.
 *
 * Everything here is socket-free and I/O-free on purpose: `node --test` covers
 * the SQL text and the mapping rules without a live server. The driver module
 * feeds real `pg` rows into these functions; rows are cast once at that
 * boundary (`as unknown as PostgresRow[]`), so this module only ever sees
 * `Record<string, unknown>`.
 *
 * Column aliases end in a stable lowercase name so the mappers never depend on
 * PostgreSQL's case handling.
 */

import { DbError } from '../../errors';
import type { ColumnInfo, RoutineInfo, SchemaRef, TableInfo } from '../../types';

export interface PostgresRow {
  readonly [column: string]: unknown;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export const PG_SQL = {
  /** Zero parameters. Filters template databases; the profile's own database stays. */
  databases: `
    SELECT d.datname AS schemaName
      FROM pg_catalog.pg_database d
     WHERE d.datallowconn = TRUE
     ORDER BY d.datname`,
  /** Zero parameters. System namespaces are filtered in the mapper, not here. */
  schemas: `
    SELECT n.nspname AS schemaName
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname NOT LIKE 'pg_%'
       AND n.nspname <> 'information_schema'
     ORDER BY n.nspname`,
  /** 1 parameter: schema (namespace). */
  tables: `
    SELECT c.relname AS tableName,
           CASE c.relkind
             WHEN 'v' THEN 'VIEW'
             WHEN 'm' THEN 'VIEW'
             ELSE 'BASE TABLE'
           END       AS tableType
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     ORDER BY c.relname`,
  /** 2 parameters: schema, table. */
  columns: `
    SELECT a.attname                                       AS columnName,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS dataType,
           CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS isNullable,
           COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') AS columnDefault,
           a.attnum                                        AS ordinal,
           CASE WHEN a.attidentity <> '' THEN 'YES' ELSE 'NO' END AS isIdentity,
           CASE WHEN pk.attnum IS NULL THEN 0 ELSE 1 END   AS isPrimaryKey
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      LEFT JOIN (
        SELECT i.indrelid, u.attnum
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_attribute u ON u.attrelid = i.indrelid AND u.attnum = ANY(i.indkey)
         WHERE i.indisprimary
      ) pk ON pk.indrelid = a.attrelid AND pk.attnum = a.attnum
     WHERE n.nspname = $1
       AND c.relname = $2
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     ORDER BY a.attnum`,
  /** 1 parameter: schema (namespace). */
  routines: `
    SELECT p.proname AS routineName,
           CASE p.prokind
             WHEN 'p' THEN 'PROCEDURE'
             WHEN 'a' THEN 'AGGREGATE'
             ELSE 'FUNCTION'
           END       AS routineType
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1
     ORDER BY p.proname`,
} as const;

/** Databases created by the server (`template0`, `template1`) plus the system maintenance DB. */
const SYSTEM_DATABASES = new Set(['template0', 'template1', 'postgres']);

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toDatabaseNames(rows: readonly PostgresRow[]): string[] {
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
 * Drops template/maintenance databases but always keeps a database the profile
 * explicitly configured, even when it looks system-generated.
 */
export function filterSystemDatabases(names: readonly string[], configuredDatabase?: string): string[] {
  const keep = configuredDatabase?.trim();
  return names.filter((name) => (SYSTEM_DATABASES.has(name) && name !== keep) === false);
}

/** Built-in schemas users never query, beyond the `pg_%` names filtered in SQL. */
const SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog']);

/** Drops built-in schemas while keeping `public` (the default application schema). */
export function filterSystemSchemas(names: readonly string[]): string[] {
  return names.filter((name) => !SYSTEM_SCHEMAS.has(name));
}

export function toBool(value: unknown): boolean {
  if (value === true || value === 1 || value === '1' || value === 't' || value === 'true') {
    return true;
  }
  return false;
}

export function toNullableBool(value: unknown): boolean {
  return toBool(value);
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  return text === '' ? null : text;
}

export function toTableInfos(rows: readonly PostgresRow[]): TableInfo[] {
  return rows.map((row) => {
    const name = String(row['tableName'] ?? '');
    const tableType = toNullableString(row['tableType']) ?? 'BASE TABLE';
    return {
      name,
      kind: tableType === 'VIEW' ? 'view' : 'table',
      tableType,
      comment: toNullableString(row['comment']) ?? undefined,
    };
  });
}

export function toColumnInfos(rows: readonly PostgresRow[]): ColumnInfo[] {
  return rows.map((row, index) => {
    const defaultExpr = toNullableString(row['columnDefault']);
    return {
      name: String(row['columnName'] ?? ''),
      dataType: String(row['dataType'] ?? ''),
      nullable: !toBool(row['isNullable'] === 'NO'),
      isPrimaryKey: toBool(row['isPrimaryKey']),
      isAutoIncrement:
        toBool(row['isIdentity'] === 'YES') || (defaultExpr !== null && /^nextval\(/i.test(defaultExpr)),
      defaultValue: defaultExpr,
      ordinal: toOrdinal(row['ordinal'], index),
    };
  });
}

/**
 * The ordinal is a real `attnum` (1-based). When a row is missing it (defensive
 * shape from mssql-style mappers), fall back to the array position.
 */
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

export function toRoutineInfos(rows: readonly PostgresRow[]): RoutineInfo[] {
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
// Identifiers
// ---------------------------------------------------------------------------

/** PostgreSQL identifiers are double-quoted; embedded double quotes are doubled. */
export function quotePostgresIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A PostgreSQL schema IS the scoping level below the database. The explorer
 * always passes a schema; falling back to the database keeps the contract
 * truthful for hand-built refs.
 */
export function postgresScope(ref: SchemaRef): string {
  const schema = ref.schema?.trim();
  if (schema !== undefined && schema !== '') {
    return schema;
  }
  const database = ref.database?.trim();
  if (database !== undefined && database !== '') {
    return database;
  }
  throw new DbError('CONFIG_ERROR', 'A schema is required for PostgreSQL relations.');
}