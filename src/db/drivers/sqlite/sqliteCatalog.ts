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

import type { ColumnInfo, ForeignKeyInfo, RelationColumns, TableInfo } from '../../types';

export const SQLITE_SQL = {
  relations: `
    SELECT m.name AS name, m.type AS type
      FROM sqlite_master m
     WHERE m.type IN ('table','view')
       AND m.name NOT LIKE 'sqlite_%'
     ORDER BY m.name`,
  /** Cheap probe run right after opening, so a non-database file fails fast. */
  schemaVersion: 'PRAGMA schema_version',
  /**
   * Zero parameters. One pass joining `sqlite_master` with the
   * `pragma_foreign_key_list` table-valued function returns both ends of every
   * foreign key of the database - never one PRAGMA per table.
   */
  foreignKeys: `
    SELECT m.name    AS sourceTable,
           f."table" AS targetTable,
           f."from"  AS sourceColumn,
           f."to"    AS targetColumn,
           f.id      AS constraintId,
           f.seq     AS seq
      FROM sqlite_master m
      JOIN pragma_foreign_key_list(m.name) f
     WHERE m.type = 'table'
       AND m.name NOT LIKE 'sqlite_%'
     ORDER BY m.name, f.id, f.seq`,
  /**
   * Zero parameters. The `pragma_table_info` table-valued function returns the
   * columns of every table **and view** of the database in one pass, so the ER
   * diagram never runs one PRAGMA per table.
   */
  schemaColumns: `
    SELECT m.name AS tableName, p.*
      FROM sqlite_master m
      JOIN pragma_table_info(m.name) p
     WHERE m.type IN ('table','view')
       AND m.name NOT LIKE 'sqlite_%'
     ORDER BY m.name, p.cid`,
} as const;

export function quoteSqliteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `PRAGMA table_info` cannot take a bound parameter, hence the interpolation. */
export function tableInfoPragma(table: string): string {
  return `PRAGMA table_info(${quoteSqliteIdentifier(table)})`;
}

/** `PRAGMA foreign_key_list` shares table_info's interpolation constraint. */
export function foreignKeyPragma(table: string): string {
  return `PRAGMA foreign_key_list(${quoteSqliteIdentifier(table)})`;
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

/**
 * `PRAGMA foreign_key_list` rows narrowed to the local columns they constrain.
 *
 * One row per `(id, seq)` of every constraint, so the same column can appear
 * several times: a set collapses the duplicates and the mapper only ever
 * answers "is this column part of a foreign key".
 */
export function foreignKeyColumns(rows: readonly SqliteRow[]): Set<string> {
  const columns = new Set<string>();
  for (const row of rows) {
    const name = typeof row['from'] === 'string' ? row['from'] : '';
    if (name !== '') {
      columns.add(name);
    }
  }
  return columns;
}

export function toSqliteColumnInfos(
  rows: readonly SqliteRow[],
  foreignKeys: ReadonlySet<string> = new Set(),
): ColumnInfo[] {
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
      isForeignKey: foreignKeys.has(name),
      isAutoIncrement: name === rowIdColumn,
      defaultValue,
      ordinal: toInt(row['cid']) > 0 ? toInt(row['cid']) + 1 : index + 1,
    });
  });
  return columns;
}

// ---------------------------------------------------------------------------
// Foreign keys (ER diagram)
// ---------------------------------------------------------------------------

/**
 * Maps `SQLITE_SQL.foreignKeys` rows into `ForeignKeyInfo`.
 *
 * `PRAGMA foreign_key_list`'s `to` column is `NULL` when the constraint points
 * at the parent's implicit `INTEGER PRIMARY KEY`, which is why `targetColumn`
 * stays optional; the constraint id + seq give the composite-key ordinal.
 */
export function toSqliteForeignKeyInfos(rows: readonly SqliteRow[]): ForeignKeyInfo[] {
  const keys: ForeignKeyInfo[] = [];
  for (const row of rows) {
    const sourceTable = typeof row['sourceTable'] === 'string' ? row['sourceTable'] : '';
    const sourceColumn = typeof row['sourceColumn'] === 'string' ? row['sourceColumn'] : '';
    const targetTable = typeof row['targetTable'] === 'string' ? row['targetTable'] : '';
    if (sourceTable === '' || sourceColumn === '' || targetTable === '') {
      continue;
    }
    const seq = toInt(row['seq']);
    keys.push({
      sourceTable,
      sourceColumn,
      targetTable,
      targetColumn:
        typeof row['targetColumn'] === 'string' && row['targetColumn'] !== ''
          ? row['targetColumn']
          : undefined,
      ordinal: Number.isFinite(seq) && seq >= 0 ? seq + 1 : keys.length + 1,
    });
  }
  return keys;
}

/**
 * Indexes a catalog-wide `foreignKeys` result by referencing table, so a
 * schema-wide column listing can mark its foreign-key columns without ever
 * running a PRAGMA per table.
 */
export function foreignKeysByTable(rows: readonly SqliteRow[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const key of toSqliteForeignKeyInfos(rows)) {
    let columns = index.get(key.sourceTable);
    if (columns === undefined) {
      columns = new Set<string>();
      index.set(key.sourceTable, columns);
    }
    columns.add(key.sourceColumn);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Schema-wide columns (ER diagram)
// ---------------------------------------------------------------------------

/**
 * Groups `schemaColumns` rows into one entry per relation, applying each
 * table's foreign-key marks when an index from `foreignKeysByTable` is given.
 */
export function toSqliteRelationColumns(
  rows: readonly SqliteRow[],
  foreignKeysByTableName?: ReadonlyMap<string, ReadonlySet<string>>,
): RelationColumns[] {
  const groups = new Map<string, SqliteRow[]>();
  const order: string[] = [];
  for (const row of rows) {
    const table = typeof row['tableName'] === 'string' ? row['tableName'] : '';
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
  return order.map((table) => ({
    table,
    columns: toSqliteColumnInfos(
      groups.get(table) ?? [],
      foreignKeysByTableName?.get(table) ?? new Set<string>(),
    ),
  }));
}

