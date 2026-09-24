/**
 * SQLite catalog queries and pure mapping helpers for sql.js.
 *
 * Deliberately socket-free, I/O-free and sql.js-free: `SqliteExecResult` is a
 * structural copy of sql.js' `QueryExecResult`, so every mapper here can be
 * unit-tested with plain object literals and no WASM runtime at all.
 *
 * SQLite quirk honoured here: `PRAGMA table_info` does not accept a bound
 * parameter for the pragma argument, so the identifier is interpolated after
 * doubling every `"` - which is why `quoteSqliteIdentifier` is exported and
 * tested on its own.
 */

import type { ColumnInfo, TableInfo } from '../../types';

export const SQLITE_SQL = {
  relations: `
    SELECT m.name AS name, m.type AS type
      FROM sqlite_master m
     WHERE m.type IN ('table','view')
       AND m.name NOT LIKE 'sqlite_%'
     ORDER BY m.name`,
  /** Cheap probe run right after opening, so a non-database file fails fast. */
  schemaVersion: 'PRAGMA schema_version',
} as const;

export function quoteSqliteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `PRAGMA table_info` cannot take a bound parameter, hence the interpolation. */
export function tableInfoPragma(table: string): string {
  return `PRAGMA table_info(${quoteSqliteIdentifier(table)})`;
}

/** Structural subset of sql.js' `QueryExecResult`. */
export interface SqliteExecResult {
  readonly columns: readonly string[];
  readonly values: ReadonlyArray<ReadonlyArray<unknown>>;
}

export type SqliteRow = Record<string, unknown>;

/** Flattens the column/value pairs of `db.exec()` output into row objects. */
export function rowsFromExecResult(results: readonly SqliteExecResult[]): SqliteRow[] {
  const first = results.find((result) => result.columns.length > 0);
  if (!first) {
    return [];
  }
  const { columns, values } = first;
  const rows: SqliteRow[] = [];
  for (const valueRow of values) {
    const row: SqliteRow = {};
    columns.forEach((column, index) => {
      row[column] = valueRow[index];
    });
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Tables / views
// ---------------------------------------------------------------------------

export function toSqliteTableInfos(rows: readonly SqliteRow[]): TableInfo[] {
  const tables: TableInfo[] = [];
  for (const row of rows) {
    const name = typeof row['name'] === 'string' ? row['name'] : '';
    if (name === '') {
      continue;
    }
    const type = row['type'] === 'view' ? 'view' : 'table';
    tables.push({
      name,
      kind: type === 'view' ? 'view' : 'table',
      tableType: type.toUpperCase(),
    });
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Columns (PRAGMA table_info)
// ---------------------------------------------------------------------------

/**
 * Returns the name of the single `INTEGER PRIMARY KEY` column (a rowid alias),
 * or `undefined`.
 *
 * SQLite auto-assigns rowids for `INTEGER PRIMARY KEY` - with or without the
 * `AUTOINCREMENT` keyword - and `PRAGMA table_info` cannot tell the two apart,
 * so both are reported as auto-increment. Multi-column primary keys (`pk` =
 * 1-based position, so >1 distinct values) and non-INTEGER types are not
 * rowid aliases.
 */
export function isRowIdAlias(columns: readonly SqliteRow[]): string | undefined {
  const pkColumns = columns.filter((column) => toInt(column['pk']) > 0);
  if (pkColumns.length !== 1) {
    return undefined;
  }
  const single = pkColumns[0];
  const type = typeof single['type'] === 'string' ? single['type'].trim().toUpperCase() : '';
  return type === 'INTEGER' && typeof single['name'] === 'string' ? single['name'] : undefined;
}

function toInt(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toSqliteColumnInfos(rows: readonly SqliteRow[]): ColumnInfo[] {
  const rowIdColumn = isRowIdAlias(rows);
  const columns: ColumnInfo[] = [];
  rows.forEach((row, index) => {
    const name = typeof row['name'] === 'string' ? row['name'] : '';
    if (name === '') {
      return;
    }
    const declaredType = typeof row['type'] === 'string' ? row['type'].trim() : '';
    const defaultValue =
      row['dflt_value'] === undefined || row['dflt_value'] === null
        ? undefined
        : String(row['dflt_value']);
    columns.push({
      name,
      // SQLite reports an empty type for untyped columns; show something useful.
      dataType: declaredType === '' ? 'ANY' : declaredType,
      // The rowid alias is implicitly NOT NULL even when `notnull` says 0.
      nullable: toInt(row['notnull']) === 0 && name !== rowIdColumn,
      isPrimaryKey: toInt(row['pk']) > 0,
      isAutoIncrement: name === rowIdColumn,
      defaultValue,
      ordinal: toInt(row['cid']) > 0 ? toInt(row['cid']) + 1 : index + 1,
    });
  });
  return columns;
}

