/**
 * Engine-neutral SQL for row editing: one UPDATE, one INSERT and one DELETE
 * builder shared by every driver.
 *
 * The split mirrors `tableDataQuery.ts`: identifiers and the table expression
 * come in already quoted from the driver, values only ever leave as bind
 * parameters, and the only interpolated text is a validated metadata column
 * name. Every builder refuses a column the schema does not declare, so a
 * webview message can never name a column that is not there.
 *
 * Row identity is the primary key and nothing else: a write is addressed by
 * `WHERE pk = ?`, never by a row number and never by a value the user typed.
 */

import { DbError } from '../errors';
import type { ColumnInfo, RowChange } from '../types';

export interface RowEditSqlOptions {
  /** Already quoted and qualified table expression, e.g. `` `db`.`users` ``. */
  readonly table: string;
  readonly columns: readonly ColumnInfo[];
  /** Primary-key columns of the relation, in schema order. */
  readonly primaryKey: readonly string[];
  readonly quoteIdentifier: (name: string) => string;
  /**
   * Placeholder text for the 1-based parameter position. MySQL/SQLite keep the
   * default `?`; PostgreSQL needs `$1..$n`, SQL Server `@p1..@pN`.
   */
  readonly placeholder?: (index: number) => string;
  /** SQL Server: clause between the column list and VALUES (`OUTPUT INSERTED.x`). */
  readonly insertOutput?: (quotedPrimaryKey: readonly string[]) => string;
  /** PostgreSQL: clause after the VALUES list (`RETURNING "id"`). */
  readonly insertReturning?: (quotedPrimaryKey: readonly string[]) => string;
  /** Syntax for a row made only of column defaults. */
  readonly defaultValues?: 'default-values' | 'empty-columns';
}

export interface BuiltStatement {
  readonly sql: string;
  readonly params: unknown[];
}

/**
 * Rows per DELETE statement. One statement per chunk keeps the parameter count
 * inside every engine's limit while still deleting a ticked page in one go.
 */
export const DELETE_KEY_CHUNK = 250;

/** Splits a delete batch into statements of at most {@link DELETE_KEY_CHUNK} keys. */
export function deleteKeyChunks(
  keys: readonly Record<string, unknown>[],
): Record<string, unknown>[][] {
  const chunks: Record<string, unknown>[][] = [];
  for (let index = 0; index < keys.length; index += DELETE_KEY_CHUNK) {
    chunks.push(keys.slice(index, index + DELETE_KEY_CHUNK));
  }
  return chunks;
}

function columnMap(options: RowEditSqlOptions): Map<string, ColumnInfo> {
  const map = new Map<string, ColumnInfo>();
  for (const column of options.columns) {
    map.set(column.name, column);
  }
  return map;
}

function requireColumn(map: Map<string, ColumnInfo>, name: string): ColumnInfo {
  const column = map.get(name);
  if (!column) {
    throw new DbError('CONFIG_ERROR', `Column '${name}' does not exist in this relation.`);
  }
  return column;
}

/**
 * Every primary-key column must carry a value: an identity half filled in
 * would match several rows or none, and both are silent data loss.
 */
function requireFullKey(options: RowEditSqlOptions, key: Record<string, unknown>): void {
  if (options.primaryKey.length === 0) {
    throw new DbError(
      'CONFIG_ERROR',
      'This relation has no primary key, so its rows cannot be identified safely.',
    );
  }
  for (const name of options.primaryKey) {
    if (!(name in key)) {
      throw new DbError('CONFIG_ERROR', `The row identity is missing the primary key column '${name}'.`);
    }
  }
}

/** `col = ?` / `col IS NULL` for one identity value. */
function equality(
  quoted: string,
  value: unknown,
  params: unknown[],
  next: () => string,
): string {
  if (value === null || value === undefined) {
    return `${quoted} IS NULL`;
  }
  params.push(value);
  return `${quoted} = ${next()}`;
}

/** `UPDATE t SET a = ? WHERE pk = ?`. */
export function buildUpdateSql(
  options: RowEditSqlOptions,
  change: RowChange,
): BuiltStatement {
  const map = columnMap(options);
  const names = Object.keys(change.values);
  if (names.length === 0) {
    throw new DbError('CONFIG_ERROR', 'There is no column to update.');
  }
  requireFullKey(options, change.key);

  const params: unknown[] = [];
  let paramIndex = 0;
  const next = (): string => (options.placeholder ?? (() => '?'))(++paramIndex);

  const sets = names.map((name) => {
    requireColumn(map, name);
    const value = change.values[name];
    if (value === null || value === undefined) {
      return `${options.quoteIdentifier(name)} = NULL`;
    }
    params.push(value);
    return `${options.quoteIdentifier(name)} = ${next()}`;
  });

  const where = options.primaryKey.map((name) =>
    equality(options.quoteIdentifier(name), change.key[name], params, next),
  );

  return {
    sql: `UPDATE ${options.table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`,
    params,
  };
}

/** `INSERT INTO t (a, b) VALUES (?, ?)`, plus the dialect's identity clause. */
export function buildInsertSql(
  options: RowEditSqlOptions,
  values: Record<string, unknown>,
): BuiltStatement {
  const map = columnMap(options);
  const names = Object.keys(values);
  const quotedKey = options.primaryKey.map((name) => options.quoteIdentifier(name));

  if (names.length === 0) {
    const syntax = options.defaultValues ?? 'default-values';
    const clause =
      syntax === 'empty-columns'
        ? `INSERT INTO ${options.table} () VALUES ()`
        : `INSERT INTO ${options.table} DEFAULT VALUES`;
    const suffix =
      quotedKey.length === 0
        ? ''
        : [
            options.insertOutput ? options.insertOutput(quotedKey) : '',
            options.insertReturning ? options.insertReturning(quotedKey) : '',
          ]
            .filter((part) => part !== '')
            .map((part) => ` ${part}`)
            .join('');
    return { sql: `${clause}${suffix}`, params: [] };
  }

  const params: unknown[] = [];
  let paramIndex = 0;
  const next = (): string => (options.placeholder ?? (() => '?'))(++paramIndex);

  for (const name of names) {
    requireColumn(map, name);
    const value = values[name];
    if (value !== null && value !== undefined) {
      params.push(value);
    }
  }

  const columns = names.map((name) => options.quoteIdentifier(name));
  const placeholders = names.map((name) =>
    values[name] === null || values[name] === undefined ? 'NULL' : next(),
  );
  const output = options.insertOutput && quotedKey.length > 0 ? ` ${options.insertOutput(quotedKey)}` : '';
  const returning =
    options.insertReturning && quotedKey.length > 0 ? ` ${options.insertReturning(quotedKey)}` : '';

  return {
    sql: `INSERT INTO ${options.table} (${columns.join(', ')})${output} VALUES (${placeholders.join(', ')})${returning}`,
    params,
  };
}

/**
 * `DELETE FROM t WHERE (pk = ? AND pk2 = ?) OR (...)`.
 *
 * The caller chunks the keys with {@link DELETE_KEY_CHUNK}; an empty list is a
 * programming error, because "delete no rows" must never look like a success.
 */
export function buildDeleteSql(
  options: RowEditSqlOptions,
  keys: readonly Record<string, unknown>[],
): BuiltStatement {
  const map = columnMap(options);
  if (keys.length === 0) {
    throw new DbError('CONFIG_ERROR', 'There is no row to delete.');
  }

  const params: unknown[] = [];
  let paramIndex = 0;
  const next = (): string => (options.placeholder ?? (() => '?'))(++paramIndex);

  const groups = keys.map((key) => {
    requireFullKey(options, key);
    const parts = options.primaryKey.map((name) => {
      requireColumn(map, name);
      return equality(options.quoteIdentifier(name), key[name], params, next);
    });
    return `(${parts.join(' AND ')})`;
  });

  return {
    sql: `DELETE FROM ${options.table} WHERE ${groups.join(' OR ')}`,
    params,
  };
}
