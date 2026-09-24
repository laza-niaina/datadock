/**
 * `DriverFactory` objects for MySQL and MariaDB.
 *
 * The registry refuses to register the same engine twice, so the shared
 * `MySqlDriver` implementation is exposed through two distinct factory objects
 * built by one parametric function — the two engines differ only in label,
 * capabilities (`backupTool`) and the engine id the driver reports.
 */

import type { ConnectionConfig } from '../../types';
import type { DriverFactory } from '../../driverRegistry';
import { MARIADB_CAPABILITIES, MYSQL_CAPABILITIES, MySqlDriver } from './mysqlDriver';

// Keep the original factory-module exports for callers that imported the
// capability metadata from here; the implementation now lives in the driver to
// keep the factory → driver dependency one-way.
export { MARIADB_CAPABILITIES, MYSQL_CAPABILITIES } from './mysqlDriver';

/** Socket-free profile validation: the same problems the wizard would report. */
export function validateMySqlConfig(config: ConnectionConfig): string[] {
  const problems: string[] = [];
  const profile = config.profile;
  if (!profile.host || profile.host.trim() === '') {
    problems.push('A host is required.');
  }
  if (!profile.user || profile.user.trim() === '') {
    problems.push(`A user name is required for ${profile.engine === 'mariadb' ? 'MariaDB' : 'MySQL'}.`);
  }
  const port = profile.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    problems.push('The port must be between 1 and 65535.');
  }
  return problems;
}

export function createMySqlFactory(engine: 'mysql' | 'mariadb'): DriverFactory {
  return {
    engine,
    label: engine === 'mariadb' ? 'MariaDB' : 'MySQL',
    status: 'stable',
    capabilities: engine === 'mariadb' ? MARIADB_CAPABILITIES : MYSQL_CAPABILITIES,
    defaultPort: 3306,
    validate: validateMySqlConfig,
    create: (config, deps) => new MySqlDriver(engine, config, deps),
  };
}

export const mysqlFactory: DriverFactory = createMySqlFactory('mysql');
export const mariadbFactory: DriverFactory = createMySqlFactory('mariadb');
