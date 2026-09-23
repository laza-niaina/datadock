/**
 * Metadata-only SQLite driver built on sql.js (SQLite compiled to WebAssembly).
 *
 * The whole database file is loaded into memory by the WASM runtime. Nothing is
 * ever written back: this milestone browses only, so the file is untouched by
 * construction. External changes made by other programs stay invisible until the
 * profile is reconnected, because the driver holds a snapshot.
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
  SchemaRef,
  TableDataRequest,
  TableInfo,
  TableRef,
} from '../../types';
import type { DriverDeps } from '../../driverRegistry';
import { SQLITE_SQL, rowsFromExecResult, tableInfoPragma, toSqliteColumnInfos, toSqliteTableInfos } from './sqliteCatalog';
import { toSqliteError } from './sqliteErrors';
import { resolveSqlitePath, DEFAULT_SQLITE_SCHEMA } from './sqlitePath';
import { SQLITE_CAPABILITIES } from './sqliteFactory';

const WASM_FILE = 'sql-wasm.wasm';

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

  async listTables(ref: SchemaRef): Promise<TableInfo[]> {
    // `ref.database` is the explorer's label (the profile name), not a SQLite
    // schema: a file has exactly one catalog, so both are ignored here.
    void ref;
    const database = this.requireDatabase();
    return toSqliteTableInfos(rowsFromExecResult(database.exec(SQLITE_SQL.relations)));
  }

  async listColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const database = this.requireDatabase();
    return toSqliteColumnInfos(rowsFromExecResult(database.exec(tableInfoPragma(ref.table))));
  }

  // -- not in this milestone -------------------------------------------------

  async execute(_sql: string, _token?: CancelToken): Promise<never> {
    throw new DbError('UNSUPPORTED_OPERATION', 'Statement execution is not implemented for SQLite yet.');
  }

  async getTableData(_ref: TableRef, _request: TableDataRequest, _token?: CancelToken): Promise<never> {
    throw new DbError('UNSUPPORTED_OPERATION', 'Table browsing is not implemented for SQLite yet.');
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

