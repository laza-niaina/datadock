/**
 * Pure display helpers for engine labels and status bar / CodeLens icons.
 *
 * Free of any `vscode` import so they can be unit tested with `node --test`.
 */

import type { EngineId } from '../db/types';

const ENGINE_LABELS: Readonly<Record<string, string>> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlite: 'SQLite',
  postgresql: 'PostgreSQL',
  mssql: 'SQL Server',
  mongodb: 'MongoDB',
  redis: 'Redis',
};

/** Human-readable engine name, e.g. `mariadb` -> `MariaDB`. */
export function engineLabel(engine: EngineId): string {
  return ENGINE_LABELS[engine] ?? engine;
}

/**
 * VS Code codicon suited to the engine: a server glyph for networked engines,
 * a file glyph for file-based engines (SQLite).
 */
export function engineIcon(engine: EngineId): string {
  switch (engine) {
    case 'mysql':
    case 'mariadb':
    case 'postgresql':
    case 'mssql':
      return '$(server)';
    case 'sqlite':
      return '$(file)';
    default:
      return '$(database)';
  }
}

/** Facts the status bar / CodeLens need to render one SQL file context. */
export interface SqlStatusContext {
  /** Profile name shown next to the database icon; absent means "Connect". */
  readonly connectionName?: string;
  readonly engine?: EngineId;
  /** Effective active database for the file; absent renders "Select DB". */
  readonly database?: string;
}

/**
 * The two label parts of the per-file SQL context, rendered as one visual
 * unit: `[DB] : Connection [engine] : Database`. The connection item doubles
 * as the entry point "Connect" before the file has been configured.
 */
export interface SqlStatusLabels {
  /** Connection item: `$(database) Connect` or `$(database) : <name>`. */
  readonly connection: string;
  /** Engine + database item; absent until a connection is known. */
  readonly database?: string;
}

/** Builds the exact status bar / CodeLens label parts for a SQL file. */
export function sqlStatusLabels(context: SqlStatusContext): SqlStatusLabels {
  if (!context.connectionName) {
    return { connection: '$(database) Connect' };
  }
  const connection = `$(database) : ${context.connectionName}`;
  if (!context.engine) {
    return { connection };
  }
  return {
    connection,
    database: `${engineIcon(context.engine)} ${engineLabel(context.engine)} : ${context.database ?? 'Select DB'}`,
  };
}