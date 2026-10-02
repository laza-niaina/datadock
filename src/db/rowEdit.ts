/**
 * Engine-neutral value handling for row editing (update / insert / delete).
 *
 * Everything here is pure and free of `vscode`, the DOM and any driver, so the
 * extension host can turn a webview string into a typed bind value and the unit
 * tests can lock the rules that keep a typed value from silently changing
 * meaning: `'12'` is the number 12 in an `int` column, `'12'` stays a string in
 * a `text` column, an out-of-range number is refused instead of rounded and a
 * value can never land in a column the schema does not declare.
 *
 * The webview only ever sends `string | number | null` (see
 * `serializeGridValue`): no object crosses the boundary, and the host decides
 * the type from its own freshly fetched `ColumnInfo`, never from anything the
 * page says.
 */

import { DbError } from './errors';
import type { ColumnInfo, TableDataPage } from './types';

/** A cell value as it arrives from the webview (or leaves the host). */
export type EditValue = string | number | null;

/** Types whose values cannot be round-tripped through a text editor. */
const BINARY_TYPE = /\b(blob|binary|varbinary|image|bytea|longblob|mediumblob|tinyblob)\b/i;

/** Whole-number types: `int`, `integer`, `int4`, `bigint(20)`, `serial`, ... */
const INTEGER_TYPE =
  /\bbigint\b|\bint(eger)?\b|\bint[248]\b|\b(tiny|small|medium|big)?serial\b/i;

/** Numeric but not necessarily whole: `decimal(10,2)`, `double`, `numeric`. */
const NUMERIC_TYPE = /\b(tiny|small|medium|big)?int\b|\bint(eger)?\b|\bnumeric\b|\bdecimal\b|\b(real|float|double)\b|\bnumber\b|\bmoney\b|\blong\b|\bshort\b/i;

/** Boolean types: PostgreSQL `boolean` and SQL Server `bit`. */
const BOOLEAN_TYPE = /^\s*(boolean|bool|bit)\b/i;

/**
 * `true` for types whose bytes cannot be typed into an editor cell.
 *
 * A binary value is already displayed as a descriptive placeholder, so an edit
 * through a text box would write that placeholder back as data.
 */
export function isBinaryColumnType(dataType: string): boolean {
  return BINARY_TYPE.test(dataType);
}

/** `true` when a value typed for this column must become a whole number. */
export function isIntegerColumnType(dataType: string): boolean {
  return INTEGER_TYPE.test(dataType);
}

/** `true` when the column stores a number rather than text. */
export function isNumericColumnType(dataType: string): boolean {
  return NUMERIC_TYPE.test(dataType) || INTEGER_TYPE.test(dataType);
}

/** `true` for PostgreSQL `boolean` / SQL Server `bit`. */
export function isBooleanColumnType(dataType: string): boolean {
  return BOOLEAN_TYPE.test(dataType);
}

function invalid(column: ColumnInfo, reason: string): DbError {
  return new DbError('CONFIG_ERROR', `Column '${column.name}': ${reason}`);
}

/**
 * Converts a webview cell value into a bind value for `column`.
 *
 * The rules, in order:
 * - `null` is SQL NULL, and only when the column accepts it.
 * - A number is passed through (it only comes from the host itself).
 * - A boolean-typed column takes `true`/`false` (also `1`/`0`/`yes`/`no`).
 * - A numeric column takes a finite number; an integer column refuses a
 *   fraction, and a whole number beyond `Number.MAX_SAFE_INTEGER` stays a
 *   string so no digit is lost on the way to the driver.
 * - Everything else is text, exactly as typed.
 */
export function parseEditValue(column: ColumnInfo, raw: EditValue): unknown {
  if (raw === null) {
    if (!column.nullable) {
      throw invalid(column, 'the column does not accept NULL.');
    }
    return null;
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      throw invalid(column, 'the number is not finite.');
    }
    return raw;
  }

  const text = raw;
  const trimmed = text.trim();

  if (isBooleanColumnType(column.dataType)) {
    if (/^(1|true|t|yes|y|on)$/i.test(trimmed)) return true;
    if (/^(0|false|f|no|n|off)$/i.test(trimmed)) return false;
    throw invalid(column, `'${text}' is not a boolean; use true or false.`);
  }

  if (isNumericColumnType(column.dataType)) {
    if (trimmed === '') {
      throw invalid(column, 'the column expects a number and the value is empty.');
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      throw invalid(column, `'${text}' is not a number.`);
    }
    if (isIntegerColumnType(column.dataType)) {
      if (!/^[+-]?\d+$/.test(trimmed)) {
        throw invalid(column, `'${text}' is not a whole number.`);
      }
      // A bigint outside the safe range travels as text: the driver binds a
      // string and the engine converts it, while a Number would be rounded.
      return Number.isSafeInteger(numeric) ? numeric : trimmed;
    }
    return numeric;
  }

  return text;
}

/**
 * Picks the primary-key values of one raw page row, in the order the schema
 * declares them, so the write is addressed by identity and never by position.
 */
export function rowKeyOf(
  page: Pick<TableDataPage, 'columns' | 'primaryKey' | 'rows'>,
  rowIndex: number,
): Record<string, unknown> {
  const row = page.rows[rowIndex];
  if (!Array.isArray(row)) {
    throw new DbError('CONFIG_ERROR', 'The row to write is no longer on this page.');
  }
  if (page.primaryKey.length === 0) {
    throw new DbError(
      'CONFIG_ERROR',
      'This relation has no primary key, so its rows cannot be identified safely.',
    );
  }
  const key: Record<string, unknown> = {};
  for (const name of page.primaryKey) {
    const index = page.columns.findIndex((column) => column.name === name);
    if (index < 0) {
      throw new DbError('CONFIG_ERROR', `Primary key column '${name}' is missing from the page.`);
    }
    key[name] = row[index];
  }
  return key;
}

/** Primary-key columns of a freshly fetched relation, in schema order. */
export function primaryKeyOf(columns: readonly ColumnInfo[]): string[] {
  return columns.filter((column) => column.isPrimaryKey).map((column) => column.name);
}

/**
 * Identity of a freshly inserted row, as the engine can report it back.
 *
 * Only what the driver can actually know is returned: `LAST_INSERT_ID()` for a
 * single auto-increment column, nothing otherwise. An empty object is a valid
 * answer, never a placeholder value.
 */
export function insertIdentity(
  columns: readonly ColumnInfo[],
  insertId: unknown,
): Record<string, unknown> {
  if (typeof insertId !== 'number' || !Number.isFinite(insertId) || insertId === 0) {
    return {};
  }
  const generated = columns.filter((column) => column.isAutoIncrement);
  return generated.length === 1 ? { [generated[0].name]: insertId } : {};
}
