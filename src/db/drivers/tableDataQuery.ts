/**
 * Shared, engine-neutral SQL construction for table data pages.
 *
 * Drivers still own identifier quoting and the `FROM` expression because MySQL
 * needs a database qualifier while SQLite must address the attached in-memory
 * file implicitly. Everything involving user values is parameterised; only
 * validated metadata names and fixed operators are interpolated.
 */

import { DbError } from '../errors';
import type { ColumnInfo, TableDataRequest, TableFilter, TableSort } from '../types';

export const DEFAULT_TABLE_PAGE_SIZE = 100;
export const MAX_TABLE_PAGE_SIZE = 1_000;

export interface TableDataSqlOptions {
  /** Already safely quoted and qualified table expression. */
  readonly from: string;
  readonly columns: readonly ColumnInfo[];
  readonly request: TableDataRequest;
  readonly quoteIdentifier: (name: string) => string;
  /** Optional engine-specific text projection used by free-text search. */
  readonly searchExpression?: (quotedIdentifier: string) => string;
}

export interface TableWhere {
  readonly clause: string;
  readonly params: unknown[];
}

export interface TableDataSql {
  readonly sql: string;
  readonly params: unknown[];
  readonly primaryKey: string[];
  readonly limit: number;
  readonly offset: number;
}

function pageInteger(value: number, name: string, fallback: number, allowZero: boolean): number {
  const candidate = value === undefined || value === null || !Number.isFinite(value) ? fallback : Math.floor(value);
  const minimum = allowZero ? 0 : 1;
  if (candidate < minimum) {
    throw new DbError('CONFIG_ERROR', `${name} must be ${allowZero ? 'zero or greater' : 'at least 1'}.`);
  }
  return candidate;
}

function columnMap(columns: readonly ColumnInfo[]): Map<string, ColumnInfo> {
  const result = new Map<string, ColumnInfo>();
  for (const column of columns) {
    const name = column.name.trim();
    if (name === '') {
      continue;
    }
    if (!result.has(name)) {
      result.set(name, column);
    }
  }
  return result;
}

function filterValue(value: unknown): unknown {
  return value === undefined ? null : value;
}

function textColumn(column: ColumnInfo): boolean {
  return /(char|text|clob|json|enum|blob)/i.test(column.dataType);
}

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, '!$&');
}

/** Builds a parameterised WHERE clause shared by the page and count queries. */
export function buildTableWhere(options: TableDataSqlOptions): TableWhere {
  const columns = columnMap(options.columns);
  const clauses: string[] = [];
  const params: unknown[] = [];
  const quote = options.quoteIdentifier;

  for (const filter of options.request.filters ?? []) {
    const column = columns.get(filter.column.trim());
    if (!column) {
      throw new DbError('CONFIG_ERROR', `Unknown filter column '${filter.column}'.`);
    }
    const identifier = quote(column.name);

    switch (filter.operator) {
      case 'IS NULL':
        clauses.push(`${identifier} IS NULL`);
        continue;
      case 'IS NOT NULL':
        clauses.push(`${identifier} IS NOT NULL`);
        continue;
      case 'IN': {
        const values = filter.values ?? [];
        if (values.length === 0) {
          clauses.push('1 = 0');
          continue;
        }
        clauses.push(`${identifier} IN (${values.map(() => '?').join(', ')})`);
        params.push(...values.map(filterValue));
        continue;
      }
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=':
      case 'LIKE':
      case 'NOT LIKE':
        if (filter.value === undefined) {
          throw new DbError('CONFIG_ERROR', `Filter '${filter.column}' needs a value.`);
        }
        clauses.push(`${identifier} ${filter.operator} ?`);
        params.push(filterValue(filter.value));
        continue;
      default:
        throw new DbError('CONFIG_ERROR', `Unsupported filter operator '${String(filter.operator)}'.`);
    }
  }

  const search = options.request.search?.trim();
  if (search) {
    const searchable = options.columns.filter(textColumn);
    if (searchable.length > 0) {
      const projection = options.searchExpression ?? ((identifier: string) => identifier);
      const pattern = `%${escapeLike(search)}%`;
      clauses.push(`(${searchable.map((column) => `${projection(quote(column.name))} LIKE ? ESCAPE '!'`).join(' OR ')})`);
      params.push(...searchable.map(() => pattern));
    }
  }

  return {
    clause: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

/**
 * Validates page/sort/filter input and produces a parameterised SELECT.
 * `MAX_TABLE_PAGE_SIZE` is a result safety cap, not a connection quota.
 */
export function buildTableDataSql(options: TableDataSqlOptions): TableDataSql {
  if (options.columns.length === 0) {
    throw new DbError('CONFIG_ERROR', 'The relation has no columns to read.');
  }
  if (options.from.trim() === '') {
    throw new DbError('CONFIG_ERROR', 'No table was selected for the data query.');
  }

  const limit = Math.min(
    MAX_TABLE_PAGE_SIZE,
    pageInteger(options.request.limit, 'Table data limit', DEFAULT_TABLE_PAGE_SIZE, false),
  );
  const offset = pageInteger(options.request.offset, 'Table data offset', 0, true);
  const where = buildTableWhere(options);
  const columns = columnMap(options.columns);
  const select = options.columns.map((column) => options.quoteIdentifier(column.name)).join(', ');
  const orderBy: string[] = [];

  for (const sort of options.request.sort ?? []) {
    const column = columns.get(sort.column.trim());
    if (!column) {
      throw new DbError('CONFIG_ERROR', `Unknown sort column '${sort.column}'.`);
    }
    if (sort.direction !== 'asc' && sort.direction !== 'desc') {
      throw new DbError('CONFIG_ERROR', `Invalid sort direction for '${sort.column}'.`);
    }
    orderBy.push(`${options.quoteIdentifier(column.name)} ${sort.direction.toUpperCase()}`);
  }

  const orderClause = orderBy.length > 0 ? ` ORDER BY ${orderBy.join(', ')}` : '';
  return {
    sql: `SELECT ${select} FROM ${options.from}${where.clause}${orderClause} LIMIT ? OFFSET ?`,
    params: [...where.params, limit, offset],
    primaryKey: options.columns.filter((column) => column.isPrimaryKey).map((column) => column.name),
    limit,
    offset,
  };
}

/** Builds a COUNT query using the same validated filters as the page query. */
export function buildTableCountSql(options: TableDataSqlOptions): { sql: string; params: unknown[] } {
  const where = buildTableWhere(options);
  return {
    sql: `SELECT COUNT(*) AS total FROM ${options.from}${where.clause}`,
    params: where.params,
  };
}

/** Runtime guard for the sort type used by callers outside TypeScript. */
export function isTableSort(value: unknown): value is TableSort {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<TableSort>;
  return typeof candidate.column === 'string' && (candidate.direction === 'asc' || candidate.direction === 'desc');
}

/** Runtime guard useful to UI adapters before forwarding a filter. */
export function isTableFilter(value: unknown): value is TableFilter {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<TableFilter>;
  return typeof candidate.column === 'string' && typeof candidate.operator === 'string';
}
