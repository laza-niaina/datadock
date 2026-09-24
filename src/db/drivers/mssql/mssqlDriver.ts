/**
 * SQL Server driver on top of `mssql` (tedious).
 *
 * Scope of this milestone: connect, execute SQL, browse metadata, and read
 * table data. Row editing and schema mutations through the table viewer stay
 * disabled until their own persistence/identity milestone.
 *
 * Cancellation maps to `Request.cancel()`, and results discriminate SELECT
 * statements by the presence of recordset column metadata: an empty `recordset`
 * is `[]` (truthy), so `!recordset` alone cannot tell a zero-row SELECT apart
 * from a mutation.
 */

import { readFileSync } from 'node:fs';
import { ConnectionPool, Request, TYPES, type IResult } from 'mssql';
import { DbError } from '../../errors';
import { NEVER_CANCELLED, NULL_LOGGER } from '../../types';
import type {
  CancelToken,
  ColumnInfo,
  ConnectionConfig,
  DatabaseDriver,
  DriverCapabilities,
  EngineId,
  Logger,
  QueryExecutionResult,
  QueryField,
  QueryResultSet,
  RoutineInfo,
  SchemaRef,
  TableDataPage,
  TableDataRequest,
  TableInfo,
  TableRef,
} from '../../types';
import type { DriverDeps } from '../../driverRegistry';
import {
  MSSQL_SQL,
  filterSystemDatabases,
  filterSystemSchemas,
  mssqlScope,
  quoteMssqlIdentifier,
  toColumnInfos,
  toDatabaseNames,
  toRoutineInfos,
  toTableInfos,
  type MssqlRow,
} from './mssqlCatalog';
import { buildTableCountSql, buildTableDataSql, type TableDataSqlOptions } from '../tableDataQuery';
import { buildMssqlConnectionOptions } from './mssqlConnectionOptions';
import { toMssqlError } from './mssqlErrors';

// Capabilities live in the driver, not in the factory: the factory imports this
// module, so a module-scope read of a factory export here runs during the
// circular evaluation and captures `undefined` in the esbuild bundle.
export const MSSQL_CAPABILITIES: DriverCapabilities = {
  schemas: true,
  multipleDatabases: true,
  views: true,
  routines: true,
  editableData: false,
  serverSidePagination: true,
  // SQL Server has no cheap row-count: `COUNT(*)` reads the whole index, so
  // like MySQL/PostgreSQL it is never issued automatically.
  countRows: false,
  transactions: true,
  ssl: true,
  sshTunnel: true,
  backupTool: 'sqlcmd',
};

const MAX_QUERY_ROWS = 10_000;

function firstSqlKeyword(sql: string): string {
  const withoutBlockComments = sql.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
  const withoutLineComment = withoutBlockComments.replace(/^\s*--[^\r\n]*(?:\r?\n|$)/, '');
  return withoutLineComment.trim().match(/^([a-z]+)/i)?.[1].toUpperCase() ?? '';
}

/** Conservative guard used only for a profile explicitly marked read-only. */
function isReadOnlySql(sql: string): boolean {
  // T-SQL mutations can also hide inside EXEC; any of these keywords anywhere
  // makes the statement ineligible on a read-only profile.
  if (
    /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|EXEC|EXECUTE|MERGE)\b/i.test(sql) ||
    /\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(sql)
  ) {
    return false;
  }
  const keyword = firstSqlKeyword(sql);
  // `USE` and `SET` only change session state and perform no mutation, so
  // read-only profiles can still scope the session.
  return ['SELECT', 'SHOW', 'WITH', 'PRINT', 'USE', 'SET', 'DECLARE'].includes(keyword);
}

/** Shape of the parts of `IResult` the driver consumes (kept local for tests). */
export interface MssqlResultLike {
  readonly recordset:
    | (ReadonlyArray<Record<string, unknown>> & {
        /** Column metadata attached by tedious to the recordset array (non-enumerable). */
        readonly columns?: Readonly<
          Record<string, { readonly name: string; readonly type?: { readonly name?: string; readonly declaration?: string } }>
        >;
      })
    | null
    | undefined;
  readonly rowsAffected: readonly number[];
  readonly command: string;
}

/** Pure result mapping: drives the node --test coverage without a socket. */
export function mssqlResultSet(result: MssqlResultLike, sql: string): QueryResultSet {
  const columnMeta = result.recordset?.columns;
  const hasResultColumns = columnMeta !== undefined && columnMeta !== null && Object.keys(columnMeta).length > 0;

  // Key order is the column order tedious handed over (metadata index order).
  const fields: QueryField[] =
    hasResultColumns && columnMeta
      ? Object.keys(columnMeta).map((name) => ({
          name,
          type: columnMeta[name].type?.declaration ?? columnMeta[name].type?.name,
        }))
      : [];

  const resultSet: QueryResultSet = {
    statementIndex: 0,
    statement: sql,
    fields,
    rows: [],
    isMutation: !hasResultColumns,
    truncated: false,
    durationMs: 0,
  };

  if (!hasResultColumns) {
    const affected = Number(result.rowsAffected?.[0]);
    if (Number.isFinite(affected)) {
      resultSet.rowsAffected = affected;
    }
  } else {
    const recordset = result.recordset ?? [];
    const visible = recordset.slice(0, MAX_QUERY_ROWS);
    resultSet.rows = visible.map((row) => fields.map((field) => row[field.name] ?? null));
    resultSet.truncated = recordset.length > visible.length;
  }
  return resultSet;
}

export class MssqlDriver implements DatabaseDriver {
  readonly engine: EngineId = 'mssql';
  readonly capabilities: DriverCapabilities = MSSQL_CAPABILITIES;

  private readonly config: ConnectionConfig;
  private readonly logger: Logger;
  private connection?: ConnectionPool;
  /** Database the live session is currently scoped to; drives the implicit-context short-circuit. */
  private activeDatabase: string | undefined;

  constructor(config: ConnectionConfig, deps: DriverDeps) {
    this.config = config;
    this.logger = deps.logger ?? NULL_LOGGER;
  }

  // -- life cycle ----------------------------------------------------------

  async connect(token: CancelToken = NEVER_CANCELLED): Promise<void> {
    if (this.connection) {
      return;
    }
    this.throwIfCancelled(token);
    // Files are read synchronously here: connect() is already async, and the
    // pure option builder stays free of `fs` so tests can inject a fake reader.
    const options = buildMssqlConnectionOptions(this.config, (filePath) => readFileSync(filePath, 'utf8'));

    let cancelled = false;
    const pool = new ConnectionPool(options);
    // A dropped socket emits an 'error' on the pool; with no listener that
    // event would crash the extension host.
    this.attachErrorLogger(pool);
    const listener = token.onCancellationRequested(() => {
      cancelled = true;
      void pool.close().catch(() => undefined);
    });
    try {
      await pool.connect();
      if (cancelled || token.isCancellationRequested) {
        await pool.close().catch(() => undefined);
        throw new DbError('CANCELLED', 'The connection was cancelled.');
      }
      this.connection = pool;
      this.activeDatabase = this.config.profile.database?.trim() || undefined;
    } catch (error) {
      await pool.close().catch(() => undefined);
      if (error instanceof DbError) {
        throw error;
      }
      if (cancelled || token.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The connection was cancelled.', error);
      }
      throw toMssqlError(error, 'CONNECTION_REFUSED');
    } finally {
      listener.dispose();
    }
    this.logger.debug('Connected to SQL Server.', {
      server: this.config.profile.host,
      port: this.config.profile.port,
    });
  }

  async disconnect(): Promise<void> {
    const pool = this.connection;
    this.connection = undefined;
    if (!pool) {
      return;
    }
    try {
      await pool.close();
    } catch (error) {
      this.logger.debug('SQL Server connection close failed.', error);
    }
  }

  async ping(token: CancelToken = NEVER_CANCELLED): Promise<number> {
    const started = Date.now();
    await this.runQuery('SELECT 1', [], token, 'QUERY_ERROR');
    return Date.now() - started;
  }

  isConnected(): boolean {
    return this.connection !== undefined;
  }

  // -- metadata ------------------------------------------------------------

  async listDatabases(token?: CancelToken): Promise<string[]> {
    const rows = await this.query(MSSQL_SQL.databases, [], token);
    return filterSystemDatabases(toDatabaseNames(rows), this.config.profile.database);
  }

  async listSchemas(database: string | undefined, token?: CancelToken): Promise<string[]> {
    // `database` is unused: schemas belong to the connected database, and SQL
    // Server has no cross-database schema catalogue short of master.
    void database;
    const rows = await this.query(MSSQL_SQL.schemas, [], token);
    return filterSystemSchemas(toDatabaseNames(rows));
  }

  async listTables(ref: SchemaRef, token?: CancelToken): Promise<TableInfo[]> {
    const rows = await this.query(MSSQL_SQL.tables, [mssqlScope(ref)], token);
    return toTableInfos(rows);
  }

  async listColumns(ref: TableRef, token?: CancelToken): Promise<ColumnInfo[]> {
    const rows = await this.query(MSSQL_SQL.columns, [mssqlScope(ref), ref.table], token);
    return toColumnInfos(rows);
  }

  async listRoutines(ref: SchemaRef, token?: CancelToken): Promise<RoutineInfo[]> {
    const rows = await this.query(MSSQL_SQL.routines, [mssqlScope(ref)], token);
    return toRoutineInfos(rows);
  }

  // -- query execution and table data ---------------------------------------

  async execute(sql: string, token: CancelToken = NEVER_CANCELLED): Promise<QueryExecutionResult> {
    if (sql.trim() === '') {
      throw new DbError('QUERY_ERROR', 'Enter at least one SQL statement before running the query.');
    }
    if (this.config.profile.readOnly && !isReadOnlySql(sql)) {
      throw new DbError('PERMISSION_DENIED', 'This connection is marked read-only; the statement was not executed.');
    }

    const started = Date.now();
    const result = await this.runQuery(sql, [], token, 'QUERY_ERROR');
    const resultSet = mssqlResultSet(result as unknown as MssqlResultLike, sql);
    resultSet.durationMs = Date.now() - started;
    return {
      sql,
      results: [resultSet],
      durationMs: resultSet.durationMs,
      notices: [],
    };
  }

  /** Scopes the session to `database` with an implicit `USE`. Never rendered as a statement. */
  async selectDatabase(database: string, token: CancelToken = NEVER_CANCELLED): Promise<void> {
    const target = database?.trim();
    if (!target || target === this.activeDatabase) {
      return;
    }
    await this.runQuery(`USE ${quoteMssqlIdentifier(target)}`, [], token, 'QUERY_ERROR');
    this.activeDatabase = target;
  }

  async getTableData(
    ref: TableRef,
    request: TableDataRequest,
    token: CancelToken = NEVER_CANCELLED,
  ): Promise<TableDataPage> {
    const columns = await this.listColumns(ref, token);
    const options = this.tableDataOptions(ref, columns, request);
    const page = buildTableDataSql(options);
    const pageResult = await this.runQuery(page.sql, page.params, token, 'QUERY_ERROR');

    let totalRows: number | undefined;
    if (this.capabilities.countRows) {
      const count = buildTableCountSql(options);
      const countResult = await this.runQuery(count.sql, count.params, token, 'QUERY_ERROR');
      const total = Number(countResult.recordset?.[0]?.['total']);
      if (Number.isFinite(total)) {
        totalRows = total;
      }
    }

    return {
      columns,
      rows: (pageResult.recordset ?? []).map((row) => columns.map((column) => row[column.name] ?? null)),
      totalRows,
      offset: page.offset,
      limit: page.limit,
      primaryKey: page.primaryKey,
      editable: !this.config.profile.readOnly && this.capabilities.editableData,
    };
  }

  // -- internals -------------------------------------------------------------

  private requireConnection(): ConnectionPool {
    if (!this.connection) {
      throw new DbError('CONNECTION_LOST', `The ${this.engine} connection is not open. Connect it first.`);
    }
    return this.connection;
  }

  private throwIfCancelled(token?: CancelToken): void {
    if (token?.isCancellationRequested) {
      throw new DbError('CANCELLED', 'The operation was cancelled.');
    }
  }

  /** Attach the mandatory pool 'error' listener so a dropped socket cannot crash the host. */
  private attachErrorLogger(pool: ConnectionPool): void {
    pool.on('error', (error: Error) => {
      this.logger.debug('SQL Server connection error.', error);
      if (this.connection === pool) {
        this.connection = undefined;
      }
    });
  }

  private tableDataOptions(ref: TableRef, columns: ColumnInfo[], request: TableDataRequest): TableDataSqlOptions {
    const scope = mssqlScope(ref);
    return {
      from: `${quoteMssqlIdentifier(scope)}.${quoteMssqlIdentifier(ref.table)}`,
      columns,
      request,
      quoteIdentifier: quoteMssqlIdentifier,
      placeholder: (index) => `@p${index}`,
      pagination: (limit, offset) => `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
      // SQL Server's OFFSET/FETCH requires an ORDER BY; use a constant when the
      // user did not sort, so browsing stays deterministic.
      requireOrderBy: true,
      searchExpression: (identifier) => `CAST(${identifier} AS NVARCHAR(MAX))`,
    };
  }

  private async runQuery(
    sql: string,
    params: readonly unknown[],
    token: CancelToken | undefined,
    fallback: 'QUERY_ERROR' | 'CONNECTION_REFUSED',
  ): Promise<IResult<Record<string, unknown>>> {
    const pool = this.requireConnection();
    this.throwIfCancelled(token);

    let request: Request | undefined;
    const listener = token?.onCancellationRequested(() => {
      if (this.connection === pool) {
        this.connection = undefined;
      }
      if (request) {
        try {
          request.cancel();
        } catch {
          // Best effort: the request may already be finished.
        }
      }
    });
    try {
      request = pool.request();
      // Bind parameters positionally as @p1..@pN; mssql infers the type from
      // the JS value and needs an explicit type only for SQL NULL.
      const values = [...params];
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (value === null || value === undefined) {
          request.input(`p${index + 1}`, TYPES.NVarChar, null);
        } else {
          request.input(`p${index + 1}`, value);
        }
      }
      const result = await request.query(sql);
      if (token?.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The query was cancelled.');
      }
      return result;
    } catch (error) {
      if (token?.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The query was cancelled.', error);
      }
      throw toMssqlError(error, fallback);
    } finally {
      listener?.dispose();
    }
  }

  private async query(sql: string, params: readonly unknown[], token?: CancelToken): Promise<MssqlRow[]> {
    const result = await this.runQuery(sql, params, token, 'QUERY_ERROR');
    return (result.recordset as unknown as MssqlRow[] | undefined) ?? [];
  }
}