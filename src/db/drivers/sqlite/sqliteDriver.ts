/**
 * SQLite driver built on sql.js (SQLite compiled to WebAssembly).
 *
 * The whole database file is loaded into memory by the WASM runtime. Query
 * execution is intentionally read-only: mutations are rejected because this
 * milestone does not persist an in-memory edit back to the source file.
 * External changes made by other programs stay invisible until the profile is
 * reconnected, because the driver holds a snapshot.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { DbError } from '../../errors';
import { resolveAssetsDir } from '../assets';
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
  QueryResultSet,
  SchemaRef,
  TableDataPage,
  TableDataRequest,
  TableInfo,
  TableRef,
} from '../../types';
import type { DriverDeps } from '../../driverRegistry';
import { SQLITE_SQL, rowsFromExecResult, tableInfoPragma, toSqliteColumnInfos, toSqliteTableInfos, quoteSqliteIdentifier } from './sqliteCatalog';
import { buildTableCountSql, buildTableDataSql, type TableDataSqlOptions } from '../tableDataQuery';
import { toSqliteError } from './sqliteErrors';
import { resolveSqlitePath, DEFAULT_SQLITE_SCHEMA } from './sqlitePath';

// Capabilities live in the driver, not in the factory, so the import stays
// one-way (factory → driver); see mysqlDriver.ts for the cycle they caused.
export const SQLITE_CAPABILITIES: DriverCapabilities = {
  schemas: false,
  // The key flag: makes the explorer skip the database level and show the
  // object folders (Tables/Views) directly under the connection node.
  multipleDatabases: false,
  views: true,
  routines: false, // SQLite has no stored procedures, so no Procedures/Functions folders.
  editableData: false,
  serverSidePagination: true,
  // COUNT(*) is used only for an explicitly requested table page in this
  // milestone; the explorer does not issue it automatically.
  countRows: false,
  transactions: false, // Snapshot execution is read-only until persistence is implemented.
  ssl: false,
  sshTunnel: false,
  // backupTool omitted: the database is already fully in memory, no CLI is needed.
};

const WASM_FILE = 'sql-wasm.wasm';
const MAX_QUERY_ROWS = 10_000;

/** One WASM runtime per asset directory, shared by every SQLite profile. */
const sqlJsByAssetsDir = new Map<string, Promise<SqlJsStatic>>();

function loadSqlJs(assetsDir: string): Promise<SqlJsStatic> {
  const existing = sqlJsByAssetsDir.get(assetsDir);
  if (existing) {
    return existing;
  }
  const pending = initSqlJs({ locateFile: (file: string) => path.join(assetsDir, file) });
  sqlJsByAssetsDir.set(assetsDir, pending);
  return pending;
}

type SqliteBindValue = string | number | Uint8Array | null;

function firstSqlKeyword(sql: string): string {
  const withoutBlockComments = sql.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
  const withoutLineComment = withoutBlockComments.replace(/^\s*--[^\r\n]*(?:\r?\n|$)/, '');
  return withoutLineComment.trim().match(/^([a-z]+)/i)?.[1].toUpperCase() ?? '';
}

/** SQLite execution is deliberately limited to statements that cannot mutate the snapshot. */
function isReadOnlySql(sql: string): boolean {
  // db.exec() accepts several semicolon-separated statements. Check the whole
  // batch so `SELECT 1; DELETE ...` cannot slip through the first-keyword test.
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX)\b/i.test(sql)) {
    return false;
  }
  const keyword = firstSqlKeyword(sql);
  return ['SELECT', 'EXPLAIN', 'PRAGMA'].includes(keyword);
}

function sqliteValue(value: unknown): SqliteBindValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'bigint') {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    throw new DbError('CONFIG_ERROR', 'A SQLite filter value is outside JavaScript\'s safe integer range.');
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  throw new DbError('CONFIG_ERROR', `Unsupported SQLite filter value of type '${typeof value}'.`);
}

export class SqliteDriver implements DatabaseDriver {
  readonly engine: EngineId = 'sqlite';
  readonly capabilities: DriverCapabilities = SQLITE_CAPABILITIES;

  private readonly config: ConnectionConfig;
  private readonly logger: Logger;
  private readonly assetsDir: string;
  private database?: Database;
  private filePath?: string;

  constructor(config: ConnectionConfig, deps: DriverDeps) {
    this.config = config;
    this.logger = deps.logger ?? NULL_LOGGER;
    this.assetsDir = resolveAssetsDir(deps.assetsDir);
  }


  // -- life cycle ----------------------------------------------------------

  async connect(token: CancelToken = NEVER_CANCELLED): Promise<void> {
    if (this.database) {
      return;
    }
    this.throwIfCancelled(token);

    const wasmPath = path.join(this.assetsDir, WASM_FILE);
    if (!existsSync(wasmPath)) {
      throw new DbError(
        'CONFIG_ERROR',
        `The SQLite engine file '${WASM_FILE}' was not found next to the extension bundle (${this.assetsDir}). Reinstall the extension.`,
      );
    }

    const filePath = path.resolve(resolveSqlitePath(this.config.profile, homedir()));
    let bytes: Uint8Array;
    try {
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        throw new DbError('CONFIG_ERROR', `'${filePath}' is a directory, not a database file.`);
      }
      // Copy on purpose: sql.js reads the whole underlying ArrayBuffer, so a
      // pooled Node Buffer (a view into a shared pool) would over-read.
      bytes = new Uint8Array(readFileSync(filePath));
    } catch (error) {
      throw toSqliteError(error);
    }

    this.throwIfCancelled(token);
    const SQL = await loadSqlJs(this.assetsDir);
    const database = new SQL.Database(bytes);
    try {
      // Probe now, so a non-database file fails here with a clear message
      // instead of surprising the user on the first tree expansion.
      database.exec(SQLITE_SQL.schemaVersion);
    } catch (error) {
      database.close();
      throw toSqliteError(error, 'QUERY_ERROR');
    }
    this.database = database;
    this.filePath = filePath;
    this.logger.debug('Opened SQLite database file.', { filePath });
  }

  async disconnect(): Promise<void> {
    const database = this.database;
    this.database = undefined;
    this.filePath = undefined;
    database?.close();
  }

  async ping(token: CancelToken = NEVER_CANCELLED): Promise<number> {
    const database = this.requireDatabase();
    this.throwIfCancelled(token);
    const started = Date.now();
    database.exec('SELECT 1');
    return Date.now() - started;
  }

  isConnected(): boolean {
    return this.database !== undefined;
  }


  // -- metadata ------------------------------------------------------------

  async listDatabases(): Promise<string[]> {
    // The explorer skips this level (multipleDatabases: false); the connection
    // manager only uses the result for its `1 db` badge.
    return [DEFAULT_SQLITE_SCHEMA];
  }

  async listSchemas(database: string | undefined): Promise<string[]> {
    const scope = database?.trim();
    return [scope === undefined || scope === '' ? DEFAULT_SQLITE_SCHEMA : scope];
  }

  async listTables(ref: SchemaRef, token?: CancelToken): Promise<TableInfo[]> {
    // `ref.database` is the explorer's label (the profile name), not a SQLite
    // schema: a file has exactly one catalog, so both are ignored here.
    void ref;
    const results = this.exec(SQLITE_SQL.relations, [], token);
    return toSqliteTableInfos(rowsFromExecResult(results));
  }

  async listColumns(ref: TableRef, token?: CancelToken): Promise<ColumnInfo[]> {
    const results = this.exec(tableInfoPragma(ref.table), [], token);
    return toSqliteColumnInfos(rowsFromExecResult(results));
  }

  // -- query execution and table data ---------------------------------------

  async execute(sql: string, token: CancelToken = NEVER_CANCELLED): Promise<QueryExecutionResult> {
    if (sql.trim() === '') {
      throw new DbError('QUERY_ERROR', 'Enter at least one SQL statement before running the query.');
    }
    if (!isReadOnlySql(sql)) {
      throw new DbError(
        'UNSUPPORTED_OPERATION',
        'SQLite execution is read-only in this milestone; mutations are not persisted to the source file.',
      );
    }

    const started = Date.now();
    const rawResults = this.exec(sql, [], token);
    const results: QueryResultSet[] = rawResults.map((raw, index) => {
      const visible = raw.values.slice(0, MAX_QUERY_ROWS);
      return {
        statementIndex: index,
        statement: sql,
        fields: raw.columns.map((name) => ({ name })),
        rows: visible.map((row) => [...row]),
        isMutation: false,
        truncated: raw.values.length > visible.length,
        durationMs: 0,
      };
    });
    const durationMs = Date.now() - started;
    for (const result of results) {
      result.durationMs = durationMs;
    }
    return { sql, results, durationMs, notices: [] };
  }

  async getTableData(
    ref: TableRef,
    request: TableDataRequest,
    token: CancelToken = NEVER_CANCELLED,
  ): Promise<TableDataPage> {
    const columns = await this.listColumns(ref, token);
    const options = this.tableDataOptions(ref, columns, request);
    const page = buildTableDataSql(options);
    const pageRows = rowsFromExecResult(this.exec(page.sql, page.params.map(sqliteValue), token));
    const count = buildTableCountSql(options);
    const countRows = rowsFromExecResult(this.exec(count.sql, count.params.map(sqliteValue), token));
    const total = Number(countRows[0]?.['total']);
    return {
      columns,
      rows: pageRows.map((row) => columns.map((column) => row[column.name])),
      totalRows: Number.isFinite(total) ? total : undefined,
      offset: page.offset,
      limit: page.limit,
      primaryKey: page.primaryKey,
      editable: false,
    };
  }

  // -- internals -------------------------------------------------------------

  /** The directory sql.js loads `sql-wasm.wasm` from (exposed for tests). */
  getAssetsDir(): string {
    return this.assetsDir;
  }

  /** Absolute path of the open file, or `undefined` while disconnected. */
  getDatabaseFilePath(): string | undefined {
    return this.filePath;
  }

  private tableDataOptions(ref: TableRef, columns: ColumnInfo[], request: TableDataRequest): TableDataSqlOptions {
    return {
      from: quoteSqliteIdentifier(ref.table),
      columns,
      request,
      quoteIdentifier: quoteSqliteIdentifier,
      searchExpression: (identifier) => `CAST(${identifier} AS TEXT)`,
    };
  }

  private exec(sql: string, params: SqliteBindValue[], token?: CancelToken): ReturnType<Database['exec']> {
    const database = this.requireDatabase();
    this.throwIfCancelled(token);
    try {
      const result = params.length > 0 ? database.exec(sql, params) : database.exec(sql);
      this.throwIfCancelled(token);
      return result;
    } catch (error) {
      if (token?.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The SQLite query was cancelled.', error);
      }
      throw toSqliteError(error, 'QUERY_ERROR');
    }
  }

  private requireDatabase(): Database {
    if (!this.database) {
      throw new DbError('CONNECTION_LOST', 'The SQLite database is not open. Connect it first.');
    }
    return this.database;
  }

  private throwIfCancelled(token?: CancelToken): void {
    if (token?.isCancellationRequested) {
      throw new DbError('CANCELLED', 'The operation was cancelled.');
    }
  }
}

