/**
 * Narrowing of the row-editing messages posted by the table webview.
 *
 * The webview is untrusted input: it can send any JSON at any time, including
 * from a document the host has already replaced. Everything here accepts only
 * the shape the host itself renders - a non-negative row index, a bounded
 * text, an echoed revision - and nothing more. The schema decisions stay in
 * the driver, which looks every column name up in freshly fetched metadata
 * before an identifier or a value is built.
 */

import type { EditValue } from '../db/rowEdit';

/** Longest text a cell editor or insert field may carry. */
export const MAX_EDIT_TEXT = 64 * 1024;

/** Longest column name accepted from a message (identifiers are far shorter). */
export const MAX_COLUMN_NAME = 128;

/** Columns accepted in one insert, so a message cannot become an unbounded loop. */
export const MAX_INSERT_COLUMNS = 512;

export type EditIntent =
  | {
      readonly kind: 'update';
      readonly revision: number;
      readonly row: number;
      readonly column: string;
      readonly value: EditValue;
    }
  | { readonly kind: 'delete'; readonly revision: number; readonly row: number }
  | { readonly kind: 'insert'; readonly revision: number; readonly values: Record<string, EditValue> };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toColumnName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.length > MAX_COLUMN_NAME) {
    return undefined;
  }
  return value.includes('\0') ? undefined : value;
}

/** A cell value as the editor writes it: bounded text, finite number, or NULL. */
export function toEditValue(value: unknown): EditValue | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    return value.length <= MAX_EDIT_TEXT ? value : undefined;
  }
  return undefined;
}

function toValues(value: unknown): Record<string, EditValue> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const entries = Object.entries(record);
  if (entries.length > MAX_INSERT_COLUMNS) {
    return undefined;
  }
  const values: Record<string, EditValue> = {};
  for (const [name, raw] of entries) {
    const column = toColumnName(name);
    const typed = toEditValue(raw);
    if (column === undefined || typed === undefined) {
      return undefined;
    }
    values[column] = typed;
  }
  return values;
}

/**
 * Narrows one untrusted message into an intent, or `undefined` when the shape
 * is not one this host ever rendered. The caller still re-checks the revision
 * against its own counter before touching the driver.
 */
export function toEditIntent(message: unknown): EditIntent | undefined {
  const record = asRecord(message);
  if (!record) {
    return undefined;
  }
  const revision = toCounter(record['revision']);
  if (revision === undefined) {
    return undefined;
  }
  if (record['type'] === 'update') {
    const row = toCounter(record['row']);
    const column = toColumnName(record['column']);
    const value = toEditValue(record['value']);
    if (row === undefined || column === undefined || value === undefined) {
      return undefined;
    }
    return { kind: 'update', revision, row, column, value };
  }
  if (record['type'] === 'delete') {
    const row = toCounter(record['row']);
    return row === undefined ? undefined : { kind: 'delete', revision, row };
  }
  if (record['type'] === 'insert') {
    const values = toValues(record['values']);
    return values === undefined ? undefined : { kind: 'insert', revision, values };
  }
  return undefined;
}
