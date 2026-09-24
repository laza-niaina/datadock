/**
 * PostgreSQL driver on top of `pg` (node-postgres).
 *
 * Scope of this milestone: connect, execute SQL, browse metadata, and read
 * table data. Row editing and schema mutations through the table viewer stay
 * disabled until their own persistence/identity milestone.
 *
 * Note: PostgreSQL cannot switch databases on a live session (there is no
 * `USE`), so `selectDatabase()` reconnects to the target database. SSL is
 * mapped from the shared `SslConfig`; SSH tunnels are owned by the connection
 * manager and rewrite host/port before this driver is constructed.
 */

import { readFileSync } from 'node:fs';
import { Client, types, type QueryResult } from 'pg';
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
  PG_SQL,
  filterSystemDatabases,
  filterSystemSchemas,
  postgresScope,
  quotePostgresIdentifier,
  toColumnInfos,
  toDatabaseNames,
  toRoutineInfos,
  toTableInfos,
  type PostgresRow,
} from './postgresqlCatalog';
import { buildTableCountSql, buildTableDataSql, type TableDataSqlOptions } from '../tableDataQuery';
import { buildPostgresConnectionOptions } from './postgresqlConnectionOptions';
import { toPostgresError } from './postgresqlErrors';

// Capabilities live in the driver, not in the factory: the factory imports this
// module, so a module-scope read of a factory export here runs during the
// circular evaluation and captures `undefined` in the esbuild bundle.
export const POSTGRES_CAPABILITIES: DriverCapabilities = {
  schemas: true,
  multipleDatabases: true,
  views: true,
  routines: true,
  editableData: false,
  serverSidePagination: true,
  // `COUNT(*)` on PostgreSQL scans the table (or its smallest index); like
  // MySQL it is not issued automatically.
  countRows: false,
  transactions: true,
  ssl: true,
  sshTunnel: true,
  backupTool: 'pg_dump',
};

const MAX_QUERY_ROWS = 10_000;

function firstSqlKeyword(sql: string): string {
  const withoutBlockComments = sql.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
  const withoutLineComment = withoutBlockComments.replace(/^\s*--[^\r\n]*(?:\r?\n|$)/, '');
  return withoutLineComment.trim().match(/^([a-z]+)/i)?.[1].toUpperCase() ?? '';
}

/** Conservative guard used only for a profile explicitly marked read-only. */
function isReadOnlySql(sql: string): boolean {
  // Reject mutation keywords anywhere in the submitted batch, plus PostgreSQL's
  // COPY (bulk load) which never appears inside a SELECT.
  if (
    /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(sql) ||
    /\bCOPY\s+\w/i.test(sql)
  ) {
    return false;
  }
  const keyword = firstSqlKeyword(sql);
  // `SET` only changes session state (search_path, timezone, ...) and performs
  // no mutation, so read-only profiles can still scope the session.
  return ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'SET', 'VALUES'].includes(keyword);
}

/** Small OID -> type-name map so column headers carry a readable type. */
const PG_TYPE_NAMES: Readonly<Record<number, string>> = {
  16: 'bool',
  17: 'bytea',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  700: 'float4',
  701: 'float8',
  1042: 'bpchar',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'uuid',
  114: 'json',
  3802: 'jsonb',
  1000: '_bool',
  1005: '_int2',
  1007: '_int4',
  1009: '_text',
  1016: '_int8',
  1021: '_float4',
  1022: '_float8',
  1231: '_numeric',
};

function pgTypeName(oid: number | undefined): string | undefined {
  if (oid === undefined || oid === null) {
    return undefined;
  }
  return PG_TYPE_NAMES[oid] ?? String(oid);
}

/**
 * Keep temporal and JSON columns as the exact text the server sends. pg would
 * otherwise parse them into JS Date / plain objects: timestamps shift into the
 * session-local timezone and JSON gets re-serialized, both of which invent
 * bytes the server never produced. The raw string is the faithful form (the
 * reference Database Client does the same). Module-scope by design: the
 * parsers are process-global in pg and must be installed before any query runs.
 */
types.setTypeParser(1082, (value: string) => value); // date
types.setTypeParser(1114, (value: string) => value); // timestamp
types.setTypeParser(1184, (value: string) => value); // timestamptz
types.setTypeParser(114, (value: string) => value); // json
types.setTypeParser(3802, (value: string) => value); // jsonb

/** Shape of the parts of `QueryResult` the driver consumes (kept local for tests). */
export interface PostgresQueryResultLike {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly dataTypeID?: number }>;
  readonly rowCount: number | null;
  readonly command: string;
}

/** Pure result mapping: drives the node --test coverage without a socket. */
export function postgresResultSet(result: PostgresQueryResultLike, sql: string): QueryResultSet {
  const fields: QueryField[] = result.fields.map((field) => ({
    name: field.name,
    type: pgTypeName(field.dataTypeID),
  }));
  const isMutation = result.fields.length === 0;
  const resultSet: QueryResultSet = {
    statementIndex: 0,
    statement: sql,
    fields,
    rows: [],
    isMutation,
    truncated: false,
    durationMs: 0,
  };
  if (isMutation) {
    const affected = result.rowCount;
    if (affected !== null && affected !== undefined && Number.isFinite(Number(affected))) {
      resultSet.rowsAffected = Number(affected);
    }
  } else {
    const rows = result.rows as ReadonlyArray<Record<string, unknown>>;
    const visible = rows.slice(0, MAX_QUERY_ROWS);
    resultSet.rows = visible.map((row) => result.fields.map((field) => row[field.name]));
    resultSet.truncated = rows.length > visible.length;
  }
  return resultSet;
}

export class PostgresqlDriver implements DatabaseDriver {
  readonly engine: EngineId = 'postgresql';
  readonly capabilities: DriverCapabilities = POSTGRES_CAPABILITIES;

  private readonly config: ConnectionConfig;
  private readonly logger: Logger;
  private connection?: Client;
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
    const options = buildPostgresConnectionOptions(this.config, (filePath) => readFileSync(filePath, 'utf8'));

    let cancelled = false;
    let client: Client | undefined;
    const listener = token.onCancellationRequested(() => {
      cancelled = true;
      if (client) {
        this.destroyClient(client);
        if (this.connection === client) {
          this.connection = undefined;
        }
      }
    });
    try {
      client = new Client(options);
      // pg Clients emit an 'error' event on unexpected connection loss; with no
      // listener that event would crash the extension host.
      this.attachErrorLogger(client);
      await client.connect();
      if (cancelled || token.isCancellationRequested) {
        this.destroyClient(client);
        throw new DbError('CANCELLED', 'The connection was cancelled.');
      }
      this.connection = client;
      this.activeDatabase = this.config.profile.database?.trim() || undefined;
    } catch (error) {
      if (client) {
        this.destroyClient(client);
      }
      if (error instanceof DbError) {
        throw error;
      }
      if (cancelled || token.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The connection was cancelled.', error);
      }
      throw toPostgresError(error, 'CONNECTION_REFUSED');
    } finally {
      listener.dispose();
    }
    this.logger.debug(`Connected to PostgreSQL.`, {
      host: this.config.profile.host,
      port: this.config.profile.port,
    });
  }

  async disconnect(): Promise<void> {
    const client = this.connection;
    this.connection = undefined;
    if (!client) {
      return;
    }
    try {
      await client.end();
    } catch (error) {
      this.logger.debug('PostgreSQL connection close failed; destroying the socket.', error);
      this.destroyClient(client);
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
    const rows = await this.query(PG_SQL.databases, [], token);
    return filterSystemDatabases(toDatabaseNames(rows), this.config.profile.database);
  }

  async listSchemas(database: string | undefined, token?: CancelToken): Promise<string[]> {
    // `database` is unused: schemas belong to the connected database, and
    // PostgreSQL has no cross-database schema catalogue.
    void database;
    const rows = await this.query(PG_SQL.schemas, [], token);
    return filterSystemSchemas(toDatabaseNames(rows));
  }

  async listTables(ref: SchemaRef, token?: CancelToken): Promise<TableInfo[]> {
    const rows = await this.query(PG_SQL.tables, [postgresScope(ref)], token);
    return toTableInfos(rows);
  }

  async listColumns(ref: TableRef, token?: CancelToken): Promise<ColumnInfo[]> {
    const rows = await this.query(PG_SQL.columns, [postgresScope(ref), ref.table], token);
    return toColumnInfos(rows);
  }

  async listRoutines(ref: SchemaRef, token?: CancelToken): Promise<RoutineInfo[]> {
    const rows = await this.query(PG_SQL.routines, [postgresScope(ref)], token);
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
    const resultSet = postgresResultSet(result as unknown as PostgresQueryResultLike, sql);
    resultSet.durationMs = Date.now() - started;
    return {
      sql,
      results: [resultSet],
      durationMs: resultSet.durationMs,
      notices: [],
    };
  }

  /**
   * Scopes the session to `database` by reconnecting, since PostgreSQL has no
   * `USE` statement. Never rendered as a statement and never counted in a batch.
   * Skipped when the session already sits on that database.
   */
  async selectDatabase(database: string, token: CancelToken = NEVER_CANCELLED): Promise<void> {
    const target = database?.trim();
    if (!target || target === this.activeDatabase) {
      return;
    }
    this.throwIfCancelled(token);
    const options = buildPostgresConnectionOptions(
      { ...this.config, profile: { ...this.config.profile, database: target } },
      (filePath) => readFileSync(filePath, 'utf8'),
    );

    const next = new Client(options);
    this.attachErrorLogger(next);
    try {
      await next.connect();
    } catch (error) {
      this.destroyClient(next);
      if (token?.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The operation was cancelled.', error);
      }
      throw toPostgresError(error, 'CONNECTION_REFUSED');
    }

    const previous = this.connection;
    this.connection = next;
    this.activeDatabase = target;
    if (previous) {
      try {
        await previous.end();
      } catch (error) {
        this.logger.debug('PostgreSQL database switch closed the old session with an error.', error);
        this.destroyClient(previous);
      }
    }
  }

  async getTableData(
    ref: TableRef,
    request: TableDataRequest,
    token: CancelToken = NEVER_CANCELLED,
  ): Promise<TableDataPage> {
    const columns = await this.listColumns(ref, token);
    const options = this.tableDataOptions(ref, columns, request);
    const page = buildTableDataSql(options);
    const pageRows = await this.query(page.sql, page.params, token);

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
      rows: pageRows.map((row) => columns.map((column) => row[column.name])),
      totalRows,
      offset: page.offset,
      limit: page.limit,
      primaryKey: page.primaryKey,
      editable: !this.config.profile.readOnly && this.capabilities.editableData,
    };
  }

  // -- internals -------------------------------------------------------------

  private requireConnection(): Client {
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

  /** Attach the mandatory pg 'error' listener so a dropped socket cannot crash the host. */
  private attachErrorLogger(client: Client): void {
    client.on('error', (error: Error) => {
      this.logger.debug('PostgreSQL connection error.', error);
      if (this.connection === client) {
        this.connection = undefined;
      }
    });
  }

  /**
   * node-postgres exposes no public abort API; destroying the underlying TLS/TCP
   * stream rejects any in-flight query, which the cancellation path then maps to
   * `CANCELLED`.
   */
  private destroyClient(client: Client): void {
    try {
      (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
    } catch {
      // Best effort: the socket may already be gone.
    }
  }

  private tableDataOptions(ref: TableRef, columns: ColumnInfo[], request: TableDataRequest): TableDataSqlOptions {
    const scope = postgresScope(ref);
    return {
      from: `${quotePostgresIdentifier(scope)}.${quotePostgresIdentifier(ref.table)}`,
      columns,
      request,
      quoteIdentifier: quotePostgresIdentifier,
      placeholder: (index) => `$${index}`,
      searchExpression: (identifier) => `CAST(${identifier} AS TEXT)`,
    };
  }

  private async runQuery(
    sql: string,
    params: readonly unknown[],
    token: CancelToken | undefined,
    fallback: 'QUERY_ERROR' | 'CONNECTION_REFUSED',
  ): Promise<QueryResult> {
    const client = this.requireConnection();
    this.throwIfCancelled(token);
    const listener = token?.onCancellationRequested(() => {
      if (this.connection === client) {
        this.connection = undefined;
      }
      this.destroyClient(client);
    });
    try {
      const result = await client.query({ text: sql, values: [...params] });
      return result;
    } catch (error) {
      if (token?.isCancellationRequested) {
        throw new DbError('CANCELLED', 'The query was cancelled.', error);
      }
      throw toPostgresError(error, fallback);
    } finally {
      listener?.dispose();
    }
  }

  private async query(sql: string, params: readonly unknown[], token?: CancelToken): Promise<PostgresRow[]> {
    const result = await this.runQuery(sql, params, token, 'QUERY_ERROR');
    return (result.rows as unknown as PostgresRow[]) ?? [];
  }
}