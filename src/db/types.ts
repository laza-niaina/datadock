/**
 * Core data-layer contracts shared by every database driver.
 *
 * IMPORTANT: nothing under `src/db` may import `vscode`. The whole subtree is
 * plain Node.js so that drivers, query engines and import/export helpers can be
 * unit-tested with `node --test` outside of the VS Code extension host.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export interface DisposableLike {
  dispose(): void;
}

/**
 * Structural clone of `vscode.CancellationToken`.
 *
 * Declaring it locally keeps this module free of editor dependencies while
 * still allowing a real `vscode.CancellationToken` to be passed in unchanged.
 */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): DisposableLike;
}

/** Token used when a caller does not need cancellation support. */
export const NEVER_CANCELLED: CancelToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Logger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  trace(message: string, ...args: unknown[]): void;
}

/** Logger used by tests and by code paths where no output channel exists yet. */
export const NULL_LOGGER: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

export type EngineId =
  | 'mysql'
  | 'mariadb'
  | 'postgresql'
  | 'sqlite'
  | 'mssql'
  | 'mongodb'
  | 'redis';

/**
 * Implementation status of an engine.
 *
 * `planned` engines are declared for documentation and roadmap purposes only.
 * They are NEVER offered in the connection wizard, so the extension can never
 * advertise support it does not actually have.
 */
export type EngineStatus = 'stable' | 'beta' | 'planned';

// ---------------------------------------------------------------------------
// Connection configuration
// ---------------------------------------------------------------------------

export interface SslConfig {
  enabled: boolean;
  /** `true` (default) validates the server certificate, `false` accepts self-signed. */
  verify?: boolean;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
  /** SNI / certificate name override. */
  serverName?: string;
}

export type SshAuthMethod = 'password' | 'privateKey' | 'agent';

export interface SshConfig {
  enabled: boolean;
  host: string;
  /** Defaults to 22 when omitted. */
  port?: number;
  username: string;
  authMethod?: SshAuthMethod;
  /** Path to a private key file on the local machine. */
  privateKeyPath?: string;
  /**
   * Database host/port *as reachable from the SSH server*.
   * When omitted the driver's own host/port are used.
   */
  remoteHost?: string;
  remotePort?: number;
}

/**
 * Values stored in `vscode.SecretStorage` and NEVER serialised into settings,
 * globalState, logs, exports or documentation.
 */
export interface ConnectionSecrets {
  password?: string;
  sshPassword?: string;
  /** PEM content of the private key when it was pasted instead of referenced. */
  sshPrivateKey?: string;
  sshPassphrase?: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  engine: EngineId;

  host?: string;
  port?: number;
  user?: string;
  /** Default database to open / qualify unqualified queries with. */
  database?: string;
  /** Default schema (PostgreSQL/MSSQL). */
  schema?: string;

  /** Engine specific extra settings, persisted as plain JSON. */
  options?: Record<string, unknown>;

  ssl?: SslConfig;
  ssh?: SshConfig;

  /** Editor accent colour id for the explorer node. */
  color?: string;
  /** When true every write path is refused by the extension. */
  readOnly?: boolean;

  createdAt: number;
  updatedAt: number;
}

/** Profile plus the secrets needed to actually open a socket. */
export interface ConnectionConfig {
  profile: ConnectionProfile;
  secrets: ConnectionSecrets;
}

/** A live SSH tunnel bound to a loopback TCP port. */
export interface TunnelHandle {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Opens an SSH tunnel for a connection profile.
 *
 * Owned by the connection manager rather than by individual drivers, so tunnel
 * support is implemented once and every engine benefits from it identically.
 * The SSH service supplies the implementation; until it is registered, profiles
 * with `ssh.enabled` fail with `UNSUPPORTED_OPERATION` instead of silently
 * connecting in clear text.
 */
export type TunnelOpener = (
  config: ConnectionConfig,
  remoteHost: string,
  remotePort: number,
  token?: CancelToken,
) => Promise<TunnelHandle>;

// ---------------------------------------------------------------------------
// Identifier / reference models
// ---------------------------------------------------------------------------

export interface DatabaseRef {
  connectionId: string;
  database: string;
}

export interface SchemaRef extends DatabaseRef {
  /** Undefined for engines without schemas (MySQL, SQLite). */
  schema?: string;
}

export type RelationKind = 'table' | 'view' | 'collection';

export interface TableRef extends SchemaRef {
  table: string;
  kind: RelationKind;
}

export interface TableInfo {
  name: string;
  kind: RelationKind;
  /** Engine specific: `BASE TABLE`, `SYSTEM TABLE`, `MEMORY`, ... */
  tableType?: string;
  comment?: string;
}

export interface ColumnInfo {
  name: string;
  /** Engine-reported type, e.g. `varchar(255)`, `int4`, `TEXT`. */
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  defaultValue?: string | null;
  comment?: string;
  /** 1-based position inside the relation. */
  ordinal: number;
}

export interface RoutineInfo {
  name: string;
  kind: 'procedure' | 'function';
  /** `PROCEDURE`, `FUNCTION`, `AGGREGATE`, ... as reported by the engine. */
  routineType?: string;
}

// ---------------------------------------------------------------------------
// Query execution models
// ---------------------------------------------------------------------------

export interface QueryField {
  name: string;
  /** Driver-reported type name for the column, when available. */
  type?: string;
}

export interface QueryResultSet {
  /** 0-based index of the statement inside the submitted batch. */
  statementIndex: number;
  /** The single statement that produced this result set. */
  statement: string;
  fields: QueryField[];
  /** Row-major value arrays aligned with `fields`. */
  rows: unknown[][];
  /** `true` when the statement reports affected rows instead of a result set. */
  isMutation: boolean;
  rowsAffected?: number;
  /** `true` when more rows were available but the client cap was reached. */
  truncated: boolean;
  durationMs: number;
}

export interface QueryExecutionResult {
  /** The original SQL exactly as submitted. */
  sql: string;
  results: QueryResultSet[];
  durationMs: number;
  /** Non-fatal server notices (warnings, `SHOW WARNINGS` style messages). */
  notices: string[];
}

// ---------------------------------------------------------------------------
// Table data models
// ---------------------------------------------------------------------------

export type FilterOperator =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'LIKE'
  | 'NOT LIKE'
  | 'IS NULL'
  | 'IS NOT NULL'
  | 'IN';

export interface TableFilter {
  column: string;
  operator: FilterOperator;
  value?: unknown;
  values?: unknown[];
}

export interface TableSort {
  column: string;
  direction: 'asc' | 'desc';
}

export interface TableDataRequest {
  offset: number;
  limit: number;
  sort?: TableSort[];
  filters?: TableFilter[];
  /** Free-text search applied across text-like columns by the driver. */
  search?: string;
}

export interface TableDataPage {
  columns: ColumnInfo[];
  /** Row-major value arrays aligned with `columns`. */
  rows: unknown[][];
  /** Undefined when counting is too expensive for the engine. */
  totalRows?: number;
  offset: number;
  limit: number;
  /** Column names forming the row identity, used for safe updates/deletes. */
  primaryKey: string[];
  /** `false` when the relation cannot be written through this driver. */
  editable: boolean;
}

/** A single cell update addressed by the row's primary key values. */
export interface RowChange {
  /** Primary key column -> original value. */
  key: Record<string, unknown>;
  /** Column -> new value. */
  values: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Driver contract
// ---------------------------------------------------------------------------

export interface DriverCapabilities {
  /** Engine groups objects under schemas. */
  readonly schemas: boolean;
  /** A single connection can reach several databases without reconnecting. */
  readonly multipleDatabases: boolean;
  readonly views: boolean;
  readonly routines: boolean;
  readonly editableData: boolean;
  /** Engine can skip/limit server side instead of client side. */
  readonly serverSidePagination: boolean;
  /** `COUNT(*)` is cheap enough to be issued automatically. */
  readonly countRows: boolean;
  readonly transactions: boolean;
  readonly ssl: boolean;
  readonly sshTunnel: boolean;
  /** Name of the native CLI backup tool, when one exists for this engine. */
  readonly backupTool?: string;
}

export interface DatabaseDriver {
  readonly engine: EngineId;
  readonly capabilities: DriverCapabilities;

  connect(token?: CancelToken): Promise<void>;
  disconnect(): Promise<void>;
  /** Round-trip latency in milliseconds. */
  ping(token?: CancelToken): Promise<number>;
  isConnected(): boolean;

  listDatabases(token?: CancelToken): Promise<string[]>;
  listSchemas(database: string | undefined, token?: CancelToken): Promise<string[]>;
  listTables(ref: SchemaRef, token?: CancelToken): Promise<TableInfo[]>;
  listColumns(ref: TableRef, token?: CancelToken): Promise<ColumnInfo[]>;
  listRoutines?(ref: SchemaRef, token?: CancelToken): Promise<RoutineInfo[]>;

  execute(sql: string, token?: CancelToken): Promise<QueryExecutionResult>;

  /**
   * Scopes the live session to a database without exposing a user-visible
   * statement (multi-database engines). The database chosen for a SQL file
   * becomes the connection's implicit run context: it must never be rendered
   * as an extra statement or counted in a batch result.
   */
  selectDatabase?(database: string, token?: CancelToken): Promise<void>;

  getTableData(ref: TableRef, request: TableDataRequest, token?: CancelToken): Promise<TableDataPage>;
  countRows?(ref: TableRef, token?: CancelToken): Promise<number>;

  updateRows?(ref: TableRef, changes: RowChange[], token?: CancelToken): Promise<number>;
  insertRow?(
    ref: TableRef,
    values: Record<string, unknown>,
    token?: CancelToken,
  ): Promise<Record<string, unknown>>;
  deleteRows?(ref: TableRef, keys: Record<string, unknown>[], token?: CancelToken): Promise<number>;

  /** Drops cached server-side metadata such as prepared statements. */
  onSchemaChanged?(): void;
}
