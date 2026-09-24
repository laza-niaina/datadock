/**
 * Pure data-grid model for the DataDock result views.
 *
 * Everything here is free of `vscode` and of DOM access so `node --test` can
 * lock the behaviour: cell serialization, filter matching, sorting and the
 * export renderers (CSV / JSON / SQL INSERT / Markdown) used by the query
 * result panel and the table viewer.
 *
 * The webview only ever receives serialized cells (`GridCell`): strings,
 * numbers and `null`. Dates become ISO strings, bigints strings and binary
 * values a descriptive placeholder, so no object can cross the boundary.
 */

import type { FilterOperator } from '../../db/types';

/** One grid column header. */
export interface GridColumn {
  readonly name: string;
  /** Driver-reported type shown under the column name (e.g. `int`, `varchar(255)`). */
  readonly type?: string;
}

/** One active filter rule (mirrors the data layer's `TableFilter` shape). */
export interface GridFilter {
  readonly column: string;
  readonly operator: FilterOperator;
  /** Raw text value; ignored by the NULL operators. */
  readonly value?: string;
}

/** One sort rule; the grid keeps a single active sort like the reference UI. */
export interface GridSort {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

/** A webview-safe cell value. */
export type GridCell = string | number | null;

/** Rows per page in the grid, matching the reference design's page size. */
export const GRID_PAGE_SIZE = 100;

/** Upper row cap for "remove pagination" exports. */
export const GRID_EXPORT_ROW_CAP = 10_000;

/** The four export formats offered by the Export dialog. */
export type GridExportFormat = 'csv' | 'json' | 'sql' | 'markdown';

/**
 * Converts a driver value into a webview-safe cell. `null` stays `null` so the
 * UI can style it like the reference grid does.
 */
export function serializeGridValue(value: unknown): GridCell {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return `<binary ${value.byteLength} bytes>`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** True when both values can be compared as numbers. */
function numericPair(a: GridCell, b: string): [number, number] | undefined {
  const left = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : NaN;
  const right = Number(b);
  if (Number.isFinite(left) && Number.isFinite(right) && typeof a !== 'boolean') {
    return [left, right];
  }
  return undefined;
}

/** Evaluates one filter rule against one cell. Unknown columns never match. */
export function matchesGridFilter(cell: GridCell, filter: GridFilter): boolean {
  if (filter.operator === 'IS NULL') {
    return cell === null;
  }
  if (filter.operator === 'IS NOT NULL') {
    return cell !== null;
  }
  const raw = filter.value ?? '';
  if (filter.operator === 'IN') {
    const members = raw.split(',').map((member) => member.trim()).filter((member) => member !== '');
    if (members.length === 0 || cell === null) {
      return false;
    }
    return members.some((member) => {
      const numeric = numericPair(cell, member);
      if (numeric) {
        return numeric[0] === numeric[1];
      }
      return String(cell) === member;
    });
  }
  if (cell === null) {
    return false;
  }
  switch (filter.operator) {
    case '=':
    case '!=': {
      const numeric = numericPair(cell, raw);
      const equal = numeric ? numeric[0] === numeric[1] : String(cell) === raw;
      return filter.operator === '=' ? equal : !equal;
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const numeric = numericPair(cell, raw);
      if (numeric) {
        const [left, right] = numeric;
        return filter.operator === '<' ? left < right : filter.operator === '<=' ? left <= right : filter.operator === '>' ? left > right : left >= right;
      }
      // Case-insensitive, collation-like string comparison.
      const left = String(cell).toLowerCase();
      const right = raw.toLowerCase();
      return filter.operator === '<' ? left < right : filter.operator === '<=' ? left <= right : filter.operator === '>' ? left > right : left >= right;
    }
    case 'LIKE':
    case 'NOT LIKE': {
      // `%` and `_` are wildcards; everything else is literal, case-insensitive.
      const pattern = raw
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
        .replace(/_/g, '.');
      let matched = false;
      try {
        matched = new RegExp(`^${pattern}$`, 'i').test(String(cell));
      } catch {
        matched = String(cell).toLowerCase().includes(raw.toLowerCase());
      }
      return filter.operator === 'LIKE' ? matched : !matched;
    }
    default:
      return true;
  }
}

/** Applies the filter rules row-wise, keeping the original row order. */
export function applyGridFilters(
  rows: readonly GridCell[][],
  columns: readonly GridColumn[],
  filters: readonly GridFilter[],
): GridCell[][] {
  if (filters.length === 0) {
    return [...rows];
  }
  const indexByColumn = new Map(columns.map((column, index) => [column.name, index]));
  const active = filters
    .map((filter) => ({ filter, index: indexByColumn.get(filter.column) }))
    .filter((entry): entry is { filter: GridFilter; index: number } => entry.index !== undefined);
  if (active.length === 0) {
    return [...rows];
  }
  return rows.filter((row) => active.every(({ filter, index }) => matchesGridFilter(row[index] ?? null, filter)));
}

/** Free-text search across every column, case-insensitive. */
export function applyGridSearch(rows: readonly GridCell[][], search: string): GridCell[][] {
  const needle = search.trim().toLowerCase();
  if (needle === '') {
    return [...rows];
  }
  return rows.filter((row) => row.some((cell) => cell !== null && String(cell).toLowerCase().includes(needle)));
}

/** Orders nulls first, numbers numerically and everything else by string. */
export function compareGridCells(a: GridCell, b: GridCell): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return -1;
  }
  if (b === null) {
    return 1;
  }
  const left = typeof a === 'number' ? a : Number(a);
  const right = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(left) && Number.isFinite(right)) {
    return left - right;
  }
  return String(a).localeCompare(String(b));
}

/** Sorts rows by one column; the input rows are not mutated. */
export function sortGridRows(
  rows: readonly GridCell[][],
  columns: readonly GridColumn[],
  sort: GridSort | undefined,
): GridCell[][] {
  if (!sort) {
    return [...rows];
  }
  const index = columns.findIndex((column) => column.name === sort.column);
  if (index < 0) {
    return [...rows];
  }
  const factor = sort.direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => factor * compareGridCells(a[index] ?? null, b[index] ?? null));
}

function csvField(value: GridCell): string {
  if (value === null) {
    return '';
  }
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC-4180-style CSV with a header row; `NULL` exports as an empty field. */
export function gridToCsv(columns: readonly GridColumn[], rows: readonly GridCell[][]): string {
  const lines = [columns.map((column) => csvField(column.name)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((_column, index) => csvField(row[index] ?? null)).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** JSON array of row objects; `null` cells are kept explicitly. */
export function gridToJson(columns: readonly GridColumn[], rows: readonly GridCell[][]): string {
  const records = rows.map((row) => {
    const record: Record<string, GridCell> = {};
    columns.forEach((column, index) => {
      record[column.name] = row[index] ?? null;
    });
    return record;
  });
  return `${JSON.stringify(records, null, 2)}\n`;
}

/** Escapes a SQL string literal portably (doubled single quotes). */
export function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValueLiteral(cell: GridCell): string {
  if (cell === null) {
    return 'NULL';
  }
  return typeof cell === 'number' ? String(cell) : sqlStringLiteral(String(cell));
}

/** Quotes an identifier with backticks (MySQL and SQLite both accept them). */
export function sqlIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/** One `INSERT INTO … VALUES …;` statement per row. */
export function gridToSqlInserts(table: string, columns: readonly GridColumn[], rows: readonly GridCell[][]): string {
  if (table.trim() === '' || columns.length === 0) {
    return '';
  }
  const target = sqlIdentifier(table);
  const names = columns.map((column) => sqlIdentifier(column.name)).join(', ');
  const lines = rows.map((row) => {
    const values = columns.map((_column, index) => sqlValueLiteral(row[index] ?? null)).join(', ');
    return `INSERT INTO ${target} (${names}) VALUES (${values});`;
  });
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function markdownField(value: GridCell): string {
  if (value === null) {
    return '';
  }
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/** GitHub-flavoured Markdown table with a header row. */
export function gridToMarkdown(columns: readonly GridColumn[], rows: readonly GridCell[][]): string {
  const header = `| ${columns.map((column) => markdownField(column.name)).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((_column, index) => markdownField(row[index] ?? null)).join(' | ')} |`);
  return [header, divider, ...body].join('\n') + '\n';
}

/** Renders one result set with the requested export format. */
export function renderGridExport(
  format: GridExportFormat,
  table: string,
  columns: readonly GridColumn[],
  rows: readonly GridCell[][],
): string {
  switch (format) {
    case 'csv':
      return gridToCsv(columns, rows);
    case 'json':
      return gridToJson(columns, rows);
    case 'sql':
      return gridToSqlInserts(table, columns, rows);
    case 'markdown':
      return gridToMarkdown(columns, rows);
  }
}

/** Suggested file name for an export (file extension included). */
export function exportFileName(base: string, format: GridExportFormat): string {
  const safeBase = base.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'datadock-export';
  const extension = format === 'markdown' ? 'md' : format;
  return `${safeBase}.${extension}`;
}
