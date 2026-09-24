/**
 * `DriverFactory` for SQLite (sql.js / WebAssembly).
 */

import { homedir } from 'node:os';
import type { ConnectionConfig } from '../../types';
import type { DriverFactory } from '../../driverRegistry';
import { SQLITE_CAPABILITIES, SqliteDriver } from './sqliteDriver';

// Preserve the original factory-module export while the implementation lives
// in the driver, avoiding the circular factory/driver evaluation.
export { SQLITE_CAPABILITIES } from './sqliteDriver';
import { resolveSqlitePath } from './sqlitePath';

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
