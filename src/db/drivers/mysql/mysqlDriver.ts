/**
 * MySQL / MariaDB driver on top of `mysql2/promise`.
 *
 * Scope of this milestone: connect, execute SQL, browse metadata, and read
 * table data. Row editing and schema mutations through the table viewer stay
 * disabled until their own persistence/identity milestone.
 */

import { createConnection, type Connection, type FieldPacket, type ResultSetHeader } from 'mysql2/promise';
import { readFileSync } from 'node:fs';
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
  MYSQL_SQL,
  filterSystemSchemas,
  mysqlScope,
  toColumnInfos,
  toDatabaseNames,
  toRoutineInfos,
  toTableInfos,
  type MysqlRow,
} from './mysqlCatalog';
import { buildMysqlConnectionOptions } from './mysqlConnectionOptions';
import { toMysqlError } from './mysqlErrors';
import {
  buildTableCountSql,
  buildTableDataSql,
  type TableDataSqlOptions,
} from '../tableDataQuery';
// Capabilities live in the driver, not in the factory: the factory imports this
// module, so a module-scope read of a factory export here runs during the
// circular evaluation and captures `undefined` in the esbuild bundle.
export const MYSQL_CAPABILITIES: DriverCapabilities = {
  // A MySQL schema IS a database: showing both levels would render
  // `app > app > Tables`, so the explorer's schema level stays off.
  schemas: false,
  multipleDatabases: true,
  views: true,
  routines: true,
  // SQL execution and table reads are available; row editing is a later milestone.
  editableData: false,
  serverSidePagination: true,
  // COUNT(*) is a full InnoDB scan, so it must not be issued automatically.
  countRows: false,
  transactions: true,
  ssl: true,
  sshTunnel: true,
  backupTool: 'mysqldump',
};

export const MARIADB_CAPABILITIES: DriverCapabilities = {
  ...MYSQL_CAPABILITIES,
  backupTool: 'mariadb-dump',
};

const ENGINE_CAPABILITIES: Readonly<Record<'mysql' | 'mariadb', DriverCapabilities>> = {
  mysql: MYSQL_CAPABILITIES,
  mariadb: MARIADB_CAPABILITIES,
};

/** The raw mysql2 connection exposes emitter events the promise wrapper hides. */
type ErrorEmitter = { on(event: 'error', listener: (error: unknown) => void): unknown };

const MAX_QUERY_ROWS = 10_000;

/** MySQL identifiers are quoted with backticks; embedded backticks are doubled. */
export function quoteMysqlIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function firstSqlKeyword(sql: string): string {
  const withoutBlockComments = sql.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
  const withoutLineComment = withoutBlockComments.replace(/^\s*--[^\r\n]*(?:\r?\n|$)/, '');
  return withoutLineComment.trim().match(/^([a-z]+)/i)?.[1].toUpperCase() ?? '';
}

/**
 * Parses the database name targeted by a leading `USE` statement, or undefined
 * when the statement does not switch databases. Keeps the driver's active-
 * database tracker in sync when the user writes an explicit `USE` themselves.
 */
export function useDatabaseTargetFrom(sql: string): string | undefined {
  if (firstSqlKeyword(sql) !== 'USE') {
    return undefined;
  }
  const withoutBlockComments = sql.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
  const withoutLineComment = withoutBlockComments.replace(/^\s*--[^\r\n]*(?:\r?\n|$)/, '');
  const rest = withoutLineComment.trim().replace(/^USE\s+/i, '').trim();
  if (rest === '') {
    return undefined;
  }
  // "USE" alone (no whitespace after the keyword) means no switch; never
  // misread the keyword itself as a database name.
  if (firstSqlKeyword(rest) === 'USE') {
    return undefined;
  }
  const quoted = rest.match(/^`((?:``|[^`])*)`/);
  if (quoted) {
    return quoted[1].replace(/``/g, '`') || undefined;
  }
  const bare = rest.match(/^([^\s;]+)/);
  return bare ? bare[1] : undefined;
}

/** Conservative guard used only for a profile explicitly marked read-only. */
function isReadOnlySql(sql: string): boolean {
  // Reject mutation keywords anywhere in the submitted batch. This is
  // intentionally conservative for a read-only profile: a false positive is
  // safer than letting a second statement bypass the check.
  if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql) || /\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(sql)) {
    return false;
  }
  const keyword = firstSqlKeyword(sql);
  // `USE` only changes the session's default schema and performs no mutation,
  // so switching the active database stays possible on read-only profiles.
  return ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'USE'].includes(keyword);
}

function isResultSetHeader(value: unknown): value is ResultSetHeader {
  return (
    typeof value === 'object' &&
    value !== null &&
    'affectedRows' in value &&
    'fieldCount' in value &&
    ('warningStatus' in value || 'warningCount' in value)
  );
}

function queryFields(fields: readonly FieldPacket[] | undefined): QueryField[] {
  return (fields ?? []).map((field) => ({
    name: field.name,
    type: field.typeName ?? (field.type === undefined ? undefined : String(field.type)),
  }));
}

function queryRows(rows: readonly MysqlRow[], fields: readonly FieldPacket[]): { values: unknown[][]; truncated: boolean } {
  const visible = rows.slice(0, MAX_QUERY_ROWS);
  return {
    values: visible.map((row) => fields.map((field) => row[field.name])),
    truncated: rows.length > visible.length,
  };
}

export class MySqlDriver implements DatabaseDriver {
  readonly engine: EngineId;
  readonly capabilities: DriverCapabilities;

  private readonly config: ConnectionConfig;
  private readonly logger: Logger;
  private connection?: Connection;
  /** Database the live session is currently scoped to; drives the implicit-context short-circuit. */
  private activeDatabase: string | undefined;

  constructor(engine: 'mysql' | 'mariadb', config: ConnectionConfig, deps: DriverDeps) {
    this.engine = engine;
    this.capabilities = ENGINE_CAPABILITIES[engine];
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
    const options = buildMysqlConnectionOptions(this.config, (filePath) => readFileSync(filePath, 'utf8'));

    let cancelled = false;
    let connection: Connection | undefined;
    const listener = token.onCancellationRequested(() => {
      cancelled = true;
      this.connection?.destroy();
      connection?.destroy();
    });
    try {
      connection = await createConnection(options);
      if (cancelled || token.isCancellationRequested) {
        connection.destroy();
        throw new DbError('CANCELLED', 'The connection was cancelled.');
      }
      this.attachErrorLogger(connection);
      this.connection = connection;
      this.activeDatabase = this.config.profile.database?.trim() || undefined;
    } catch (error) {
      connection?.destroy();
      if (error instanceof DbError) {
        throw error;
      }
      if (cancelled || token.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The connection was cancelled.', error);
      }
      throw toMysqlError(error, 'CONNECTION_REFUSED');
    } finally {
      listener.dispose();
    }
    this.logger.debug(`Connected to ${this.engine}.`, {
      host: this.config.profile.host,
      port: this.config.profile.port,
    });
  }

  async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) {
      return;
    }
    try {
      await connection.end();
    } catch (error) {
      this.logger.debug('MySQL connection close failed; destroying the socket.', error);
      connection.destroy();
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
    const rows = await this.query(MYSQL_SQL.databases, [], token);
    return filterSystemSchemas(toDatabaseNames(rows), this.config.profile.database);
  }

  async listSchemas(database: string | undefined): Promise<string[]> {
    // A MySQL schema is a database; the explorer never asks (schemas: false),
    // but the contract still deserves a truthful answer.
    const scope = database?.trim();
    return scope === undefined || scope === '' ? [] : [scope];
  }

  async listTables(ref: SchemaRef, token?: CancelToken): Promise<TableInfo[]> {
    const rows = await this.query(MYSQL_SQL.tables, [mysqlScope(ref)], token);
    return toTableInfos(rows);
  }

  async listColumns(ref: TableRef, token?: CancelToken): Promise<ColumnInfo[]> {
    const rows = await this.query(MYSQL_SQL.columns, [mysqlScope(ref), ref.table], token);
    return toColumnInfos(rows);
  }

  async listRoutines(ref: SchemaRef, token?: CancelToken): Promise<RoutineInfo[]> {
    const rows = await this.query(MYSQL_SQL.routines, [mysqlScope(ref)], token);
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
    const [rawResult, rawFields] = await this.runQuery(sql, [], token, 'QUERY_ERROR');
    // A user-written leading USE changes the session scope; keep the tracker in
    // sync so the next implicit selectDatabase() still lands on the file's base.
    const useTarget = useDatabaseTargetFrom(sql);
    if (useTarget !== undefined) {
      this.activeDatabase = useTarget;
    }
    const fields = queryFields(rawFields);
    const resultSet: QueryResultSet = {
      statementIndex: 0,
      statement: sql,
      fields,
      rows: [],
      isMutation: isResultSetHeader(rawResult),
      truncated: false,
      durationMs: 0,
    };

    if (resultSet.isMutation) {
      const affected = Number((rawResult as ResultSetHeader).affectedRows);
      if (Number.isFinite(affected)) {
        resultSet.rowsAffected = affected;
      }
    } else if (Array.isArray(rawResult)) {
      const mapped = queryRows(rawResult as MysqlRow[], rawFields);
      resultSet.rows = mapped.values;
      resultSet.truncated = mapped.truncated;
    } else if (rawResult !== undefined && rawResult !== null) {
      throw new DbError('QUERY_ERROR', 'The database returned an unsupported query result.');
    }

    const durationMs = Date.now() - started;
    resultSet.durationMs = durationMs;
    return {
      sql,
      results: [resultSet],
      durationMs,
      notices: [],
    };
  }

  /**
   * Scopes the session to `database` with an implicit `USE` that never reaches
   * the result panel and never counts as a statement. Skipped when the session
   * already sits on that database, so repeated runs add no round trip.
   */
  async selectDatabase(database: string, token: CancelToken = NEVER_CANCELLED): Promise<void> {
    const target = database?.trim();
    if (!target || target === this.activeDatabase) {
      return;
    }
    await this.runQuery(`USE ${quoteMysqlIdentifier(target)}`, [], token, 'QUERY_ERROR');
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
    const rows = await this.query(page.sql, page.params, token);

    let totalRows: number | undefined;
    if (this.capabilities.countRows) {
      const count = buildTableCountSql(options);
      const countRows = await this.query(count.sql, count.params, token);
      const total = Number(countRows[0]?.['total']);
      if (Number.isFinite(total)) {
        totalRows = total;
      }
    }

    return {
      columns,
      rows: rows.map((row) => columns.map((column) => row[column.name])),
      totalRows,
      offset: page.offset,
      limit: page.limit,
      primaryKey: page.primaryKey,
      editable: !this.config.profile.readOnly && this.capabilities.editableData,
    };
  }

  // -- internals -------------------------------------------------------------

  private requireConnection(): Connection {
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

  private attachErrorLogger(connection: Connection): void {
    // The promise wrapper hides the emitter, so reach the raw connection if it
    // is there; a fatal drop must never surface as an unhandled 'error' event.
    const emitter =
      (connection as unknown as { connection?: ErrorEmitter }).connection ??
      (connection as unknown as ErrorEmitter);
    emitter?.on?.('error', (error: unknown) => {
      this.logger.debug('MySQL connection error.', error);
      if (this.connection === connection) {
        this.connection = undefined;
      }
    });
  }

  private tableDataOptions(ref: TableRef, columns: ColumnInfo[], request: TableDataRequest): TableDataSqlOptions {
    const scope = mysqlScope(ref);
    return {
      from: `${quoteMysqlIdentifier(scope)}.${quoteMysqlIdentifier(ref.table)}`,
      columns,
      request,
      quoteIdentifier: quoteMysqlIdentifier,
      searchExpression: (identifier) => `CAST(${identifier} AS CHAR)`,
    };
  }

  private async runQuery(
    sql: string,
    params: readonly unknown[],
    token: CancelToken | undefined,
    fallback: 'QUERY_ERROR' | 'CONNECTION_REFUSED',
  ): Promise<[unknown, FieldPacket[]]> {
    const connection = this.requireConnection();
    this.throwIfCancelled(token);
    const listener = token?.onCancellationRequested(() => {
      if (this.connection === connection) {
        this.connection = undefined;
      }
      connection.destroy();
    });
    try {
      const result = (await connection.query(sql, [...params])) as unknown;
      if (!Array.isArray(result) || result.length < 1) {
        return [undefined, []];
      }
      return [result[0], (Array.isArray(result[1]) ? result[1] : []) as FieldPacket[]];
    } catch (error) {
      if (token?.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The query was cancelled.', error);
      }
      throw toMysqlError(error, fallback);
    } finally {
      listener?.dispose();
    }
  }

  private async query(sql: string, params: readonly unknown[], token?: CancelToken): Promise<MysqlRow[]> {
    const [rows] = await this.runQuery(sql, params, token, 'QUERY_ERROR');
    if (rows === undefined || rows === null) {
      return [];
    }
    if (!Array.isArray(rows)) {
      throw new DbError('QUERY_ERROR', 'The database returned no row set for this operation.');
    }
    return rows as MysqlRow[];
  }
}
