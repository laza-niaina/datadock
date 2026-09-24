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