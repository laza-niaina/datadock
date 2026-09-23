/**
 * Metadata-only MySQL / MariaDB driver on top of `mysql2/promise`.
 *
 * Scope of this milestone: connect, ping, and browse databases, tables, views,
 * columns and routines. `execute()` and `getTableData()` exist because the
 * interface requires them, but throw `UNSUPPORTED_OPERATION` instead of
 * pretending to work.
 */

import { createConnection, type Connection } from 'mysql2/promise';
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
  RoutineInfo,
  SchemaRef,
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
import { MARIADB_CAPABILITIES, MYSQL_CAPABILITIES } from './mysqlFactory';

const ENGINE_CAPABILITIES: Readonly<Record<'mysql' | 'mariadb', DriverCapabilities>> = {
  mysql: MYSQL_CAPABILITIES,
  mariadb: MARIADB_CAPABILITIES,
};

/** The raw mysql2 connection exposes emitter events the promise wrapper hides. */
type ErrorEmitter = { on(event: 'error', listener: (error: unknown) => void): unknown };

export class MySqlDriver implements DatabaseDriver {
  readonly engine: EngineId;
  readonly capabilities: DriverCapabilities;

  private readonly config: ConnectionConfig;
  private readonly logger: Logger;
  private connection?: Connection;

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

    const listener = token.onCancellationRequested(() => {
      this.connection?.destroy();
    });
    let connection: Connection | undefined;
    try {
      connection = await createConnection(options);
      this.attachErrorLogger(connection);
      this.connection = connection;
    } catch (error) {
      connection?.destroy();
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
    const connection = this.requireConnection();
    this.throwIfCancelled(token);
    const started = Date.now();
    await connection.query('SELECT 1');
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

  async listTables(ref: SchemaRef): Promise<TableInfo[]> {
    const rows = await this.query(MYSQL_SQL.tables, [mysqlScope(ref)]);
    return toTableInfos(rows);
  }

  async listColumns(ref: TableRef): Promise<ColumnInfo[]> {
    const rows = await this.query(MYSQL_SQL.columns, [mysqlScope(ref), ref.table]);
    return toColumnInfos(rows);
  }

  async listRoutines(ref: SchemaRef): Promise<RoutineInfo[]> {
    const rows = await this.query(MYSQL_SQL.routines, [mysqlScope(ref)]);
    return toRoutineInfos(rows);
  }

  // -- not in this milestone -------------------------------------------------

  async execute(_sql: string, _token?: CancelToken): Promise<never> {
    throw new DbError('UNSUPPORTED_OPERATION', 'Statement execution is not implemented for MySQL yet.');
  }

  async getTableData(_ref: TableRef, _request: TableDataRequest, _token?: CancelToken): Promise<never> {
    throw new DbError('UNSUPPORTED_OPERATION', 'Table browsing is not implemented for MySQL yet.');
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

  private async query(sql: string, params: readonly unknown[], token?: CancelToken): Promise<MysqlRow[]> {
    const connection = this.requireConnection();
    this.throwIfCancelled(token);
    try {
      const [rows] = await connection.query(sql, [...params]);
      return rows as unknown as MysqlRow[];
    } catch (error) {
      throw toMysqlError(error, 'QUERY_ERROR');
    }
  }
}
