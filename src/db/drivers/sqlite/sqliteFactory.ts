/**
 * `DriverFactory` for SQLite (sql.js / WebAssembly).
 */

import { homedir } from 'node:os';
import type { ConnectionConfig, DriverCapabilities } from '../../types';
import type { DriverFactory } from '../../driverRegistry';
import { SqliteDriver } from './sqliteDriver';
import { resolveSqlitePath } from './sqlitePath';

export const SQLITE_CAPABILITIES: DriverCapabilities = {
  schemas: false,
  // The key flag: makes the explorer skip the database level and show the
  // object folders (Tables/Views) directly under the connection node.
  multipleDatabases: false,
  views: true,
  routines: false, // SQLite has no stored procedures, so no Procedures/Functions folders.
  editableData: false,
  serverSidePagination: true,
  // COUNT(*) scans a local b-tree; keep it out of any automatic path.
  countRows: false,
  transactions: false, // No statement execution path yet; sql.js can do BEGIN/COMMIT later.
  ssl: false,
  sshTunnel: false,
  // backupTool omitted: the database is already fully in memory, no CLI is needed.
};

/** Socket-free profile validation, mirroring `validation.ts` for file engines. */
export function validateSqliteConfig(config: ConnectionConfig): string[] {
  const problems: string[] = [];
  try {
    resolveSqlitePath(config.profile, homedir());
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

export function createSqliteFactory(): DriverFactory {
  return {
    engine: 'sqlite',
    label: 'SQLite',
    status: 'stable',
    capabilities: SQLITE_CAPABILITIES,
    fileBased: true,
    validate: validateSqliteConfig,
    create: (config, deps) => new SqliteDriver(config, deps),
  };
}

export const sqliteFactory: DriverFactory = createSqliteFactory();
