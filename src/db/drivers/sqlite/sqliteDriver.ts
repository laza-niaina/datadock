/**
 * SQLite driver built on sql.js (SQLite compiled to WebAssembly).
 *
 * The whole database file is loaded into memory by the WASM runtime. Reads and
 * writes both run against that snapshot, and every successful write is flushed
 * back to the source file with `db.export()` (atomic temp-file + rename, only
 * when no other program changed the file meanwhile), so the SQL editor and the
 * table viewer's `updateRows` / `insertRow` / `deleteRows` all persist. Work
 * inside an explicit transaction is held back until it ends, so uncommitted
 * changes can never reach the disk.
 *
 * External changes made by other programs stay invisible until the profile is
 * reconnected, because the driver holds a snapshot: a write that would
 * overwrite them is refused with a message asking for that reconnect.
 */

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
  ForeignKeyInfo,
  Logger,
  QueryExecutionResult,
  QueryResultSet,
  RelationColumns,
  RowChange,
  SchemaRef,
  TableDataPage,
  TableDataRequest,
  TableInfo,
  TableRef,
} from '../../types';
import type { DriverDeps } from '../../driverRegistry';
import { SQLITE_SQL, rowsFromExecResult, tableInfoPragma, foreignKeyPragma, foreignKeyColumns, foreignKeysByTable, toSqliteColumnInfos, toSqliteForeignKeyInfos, toSqliteRelationColumns, toSqliteTableInfos, quoteSqliteIdentifier } from './sqliteCatalog';
import { buildTableCountSql, buildTableDataSql, type TableDataSqlOptions } from '../tableDataQuery';
import { insertIdentity, primaryKeyOf } from '../../rowEdit';
import {
  buildDeleteSql,
  buildInsertSql,
  buildUpdateSql,
  deleteKeyChunks,
  type RowEditSqlOptions,
} from '../rowEditSql';
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
  // Rows are written back to the source file after every successful statement
  // (atomic rename, refused when another program changed the file first).
  editableData: true,
  serverSidePagination: true,
  // COUNT(*) is used only for an explicitly requested table page in this
  // milestone; the explorer does not issue it automatically.
  countRows: false,
  // BEGIN/COMMIT/ROLLBACK run against the snapshot; the file is only rewritten
  // once the transaction ends, so uncommitted work never reaches the disk.
  transactions: true,
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
  return sqlWithoutLiterals(sql).trim().match(/^([a-z]+)/i)?.[1].toUpperCase() ?? '';
}

/**
 * The statement with its data blanked out: string literals, quoted
 * identifiers and comments all become spaces.
 *
 * Classification must never read what the user typed as a value: a row that
 * says `DELETE FROM users` is data, and a comment may mention any keyword it
 * likes. One left-to-right pass keeps the quotes inside a comment from
 * swallowing the statement that follows it.
 */
function sqlWithoutLiterals(sql: string): string {
  return sql.replace(
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|--[^\r\n]*|\/\*[\s\S]*?\*\//g,
    ' ',
  );
}

/** Statements that leave the snapshot unchanged: no write-back needed for them. */
function isReadOnlySql(sql: string): boolean {
  // db.exec() accepts several semicolon-separated statements. Check the whole
  // batch so `SELECT 1; DELETE ...` cannot slip through the first-keyword test.
  const source = sqlWithoutLiterals(sql);
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX)\b/i.test(source)) {
    return false;
  }
  return ['SELECT', 'EXPLAIN', 'PRAGMA'].includes(firstSqlKeyword(source));
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
  /** Size and mtime of the file as DataDock last read or wrote it. */
  private fileStamp?: { size: number; mtimeMs: number };
  /** An explicit transaction is open, so the file must not be rewritten yet. */
  private transactionOpen = false;

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
    this.fileStamp = this.readStamp();
    this.transactionOpen = false;
    this.logger.debug('Opened SQLite database file.', { filePath });
  }

  async disconnect(): Promise<void> {
    const database = this.database;
    this.database = undefined;
    this.filePath = undefined;
    this.fileStamp = undefined;
    this.transactionOpen = false;
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
    // A second pragma reads the foreign keys: SQLite keeps them in their own
    // catalog, so `table_info` alone can never report them.
    const foreignKeys = this.exec(foreignKeyPragma(ref.table), [], token);
    return toSqliteColumnInfos(
      rowsFromExecResult(results),
      foreignKeyColumns(rowsFromExecResult(foreignKeys)),
    );
  }

  async listForeignKeys(ref: SchemaRef, token?: CancelToken): Promise<ForeignKeyInfo[]> {
    // `ref` is ignored on purpose: one file has exactly one catalog, and the
    // catalog-wide query below already covers every table of it.
    void ref;
    const results = this.exec(SQLITE_SQL.foreignKeys, [], token);
    return toSqliteForeignKeyInfos(rowsFromExecResult(results));
  }

  async listSchemaColumns(ref: SchemaRef, token?: CancelToken): Promise<RelationColumns[]> {
    // `ref` is ignored for the same reason as `listForeignKeys`: both queries
    // below scan the whole file, never one table at a time.
    void ref;
    const columns = rowsFromExecResult(this.exec(SQLITE_SQL.schemaColumns, [], token));
    const foreignKeys = rowsFromExecResult(this.exec(SQLITE_SQL.foreignKeys, [], token));
    return toSqliteRelationColumns(columns, foreignKeysByTable(foreignKeys));
  }

  // -- query execution and table data ---------------------------------------

  async execute(sql: string, token: CancelToken = NEVER_CANCELLED): Promise<QueryExecutionResult> {
    if (sql.trim() === '') {
      throw new DbError('QUERY_ERROR', 'Enter at least one SQL statement before running the query.');
    }
    // One file per connection: attaching another one cannot be persisted, so it
    // is refused rather than silently applied to a snapshot nobody writes back.
    if (/\b(ATTACH|DETACH)\b/i.test(sqlWithoutLiterals(sql))) {
      throw new DbError(
        'UNSUPPORTED_OPERATION',
        'Attaching another database file is not supported: DataDock writes exactly one file per connection.',
      );
    }
    const mutates = !isReadOnlySql(sql);
    if (mutates) {
      this.requireWritable();
    }

    const started = Date.now();
    const rawResults = this.exec(sql, [], token);
    const durationMs = Date.now() - started;

    if (mutates) {
      // A mutation reports affected rows instead of a result set. SQLite's
      // counter covers the statement that ran last in the batch, and the file
      // is only rewritten while no transaction is open.
      const rowsAffected = this.requireDatabase().getRowsModified();
      this.noteTransactionState(sql);
      this.persist();
      return {
        sql,
        results: [
          {
            statementIndex: 0,
            statement: sql,
            fields: [],
            rows: [],
            isMutation: true,
            rowsAffected,
            truncated: false,
            durationMs,
          },
        ],
        durationMs,
        notices: [],
      };
    }

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
      editable: !this.config.profile.readOnly && this.capabilities.editableData,
    };
  }

  // -- row editing ------------------------------------------------------------

  async updateRows(
    ref: TableRef,
    changes: RowChange[],
    token: CancelToken = NEVER_CANCELLED,
  ): Promise<number> {
    if (changes.length === 0) {
      return 0;
    }
    this.requireWritable();
    const columns = await this.listColumns(ref, token);
    const options = this.rowEditOptions(ref, columns);
    let affected = 0;
    for (const change of changes) {
      const built = buildUpdateSql(options, change);
      affected += this.runWrite(built.sql, built.params, token);
    }
    this.persist();
    return affected;
  }

  async insertRow(
    ref: TableRef,
    values: Record<string, unknown>,
    token: CancelToken = NEVER_CANCELLED,
  ): Promise<Record<string, unknown>> {
    this.requireWritable();
    const columns = await this.listColumns(ref, token);
    const built = buildInsertSql(this.rowEditOptions(ref, columns), values);
    this.runWrite(built.sql, built.params, token);
    const rows = rowsFromExecResult(this.exec('SELECT last_insert_rowid() AS id', [], token));
    this.persist();
    return insertIdentity(columns, Number(rows[0]?.['id']));
  }

  async deleteRows(
    ref: TableRef,
    keys: Record<string, unknown>[],
    token: CancelToken = NEVER_CANCELLED,
  ): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    this.requireWritable();
    const columns = await this.listColumns(ref, token);
    const options = this.rowEditOptions(ref, columns);
    let affected = 0;
    for (const chunk of deleteKeyChunks(keys)) {
      const built = buildDeleteSql(options, chunk);
      affected += this.runWrite(built.sql, built.params, token);
    }
    this.persist();
    return affected;
  }

  // -- internals -------------------------------------------------------------

  /** The profile flag that keeps every write off a read-only connection. */
  private requireWritable(): void {
    if (this.config.profile.readOnly) {
      throw new DbError('PERMISSION_DENIED', 'This connection is marked read-only; the row was not written.');
    }
  }

  private rowEditOptions(ref: TableRef, columns: readonly ColumnInfo[]): RowEditSqlOptions {
    return {
      table: quoteSqliteIdentifier(ref.table),
      columns,
      primaryKey: primaryKeyOf(columns),
      quoteIdentifier: quoteSqliteIdentifier,
      // SQLite spells a row made of column defaults as `DEFAULT VALUES`.
      defaultValues: 'default-values',
    };
  }

  /** One write statement against the snapshot, with SQLite's own row count. */
  private runWrite(sql: string, params: readonly unknown[], token?: CancelToken): number {
    const database = this.requireDatabase();
    this.throwIfCancelled(token);
    try {
      database.run(sql, params.map(sqliteValue));
      return database.getRowsModified();
    } catch (error) {
      if (token?.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The SQLite write was cancelled.', error);
      }
      throw toSqliteError(error, 'QUERY_ERROR');
    }
  }

  /** Tracks an explicit transaction, because the file is only safe to rewrite outside one. */
  private noteTransactionState(sql: string): void {
    const keyword = firstSqlKeyword(sql);
    if (keyword === 'BEGIN' || keyword === 'START') {
      this.transactionOpen = true;
    } else if (keyword === 'COMMIT' || keyword === 'END' || keyword === 'ROLLBACK') {
      this.transactionOpen = false;
    }
  }

  private readStamp(): { size: number; mtimeMs: number } | undefined {
    const filePath = this.filePath;
    if (!filePath) {
      return undefined;
    }
    try {
      const stats = statSync(filePath);
      return { size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      return undefined;
    }
  }

  /**
   * Writes the in-memory image back to the source file.
   *
   * Three gates, in order: no open transaction (uncommitted work never reaches
   * the disk), no read-only profile, and no foreign change since DataDock last
   * touched the file. The write itself goes to a temporary file in the same
   * directory and is renamed over the original, so an interrupted write cannot
   * leave a half-written database behind.
   */
  private persist(): void {
    const database = this.database;
    const filePath = this.filePath;
    if (!database || !filePath) {
      return;
    }
    if (this.transactionOpen) {
      this.logger.debug('SQLite write held back until the transaction ends.', { filePath });
      return;
    }
    this.requireWritable();

    const previous = this.fileStamp;
    const current = this.readStamp();
    if (previous && current && (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs)) {
      throw new DbError(
        'QUERY_ERROR',
        `The file '${filePath}' changed on disk while DataDock held it open. Reconnect the profile so the other program's changes are not overwritten.`,
      );
    }

    const tempPath = `${filePath}.datadock-tmp`;
    try {
      writeFileSync(tempPath, Buffer.from(database.export()));
      renameSync(tempPath, filePath);
    } catch (error) {
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch {
        // A leftover temporary file is harmless; the original is untouched.
      }
      throw toSqliteError(error, 'QUERY_ERROR');
    }
    this.fileStamp = this.readStamp();
    this.logger.debug('Persisted SQLite database file.', { filePath });
  }

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

