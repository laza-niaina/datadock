/**
 * `DriverFactory` for SQL Server.
 *
 * The registry refuses to register the same engine twice, so this module owns
 * the single factory object for `mssql`. The implementation lives in the driver
 * to keep the factory → driver dependency one-way (same pattern as the MySQL
 * factory, avoiding the circular-import bug class).
 */

import type { ConnectionConfig } from '../../types';
import type { DriverFactory } from '../../driverRegistry';
import { MSSQL_CAPABILITIES, MssqlDriver } from './mssqlDriver';
import { DEFAULT_MSSQL_PORT } from './mssqlConnectionOptions';

export { MSSQL_CAPABILITIES } from './mssqlDriver';

/** Socket-free profile validation: the same problems the wizard would report. */
export function validateMssqlConfig(config: ConnectionConfig): string[] {
  const problems: string[] = [];
  const profile = config.profile;
  if (!profile.host || profile.host.trim() === '') {
    problems.push('A host is required.');
  }
  // SQL Server authentication is the only transport this milestone supports
  // (Windows/Integrated auth needs the native msnodesqlv8 connector, which is
  // intentionally not bundled); a user is therefore always required.
  if (!profile.user || profile.user.trim() === '') {
    problems.push('A user name is required for SQL Server.');
  }
  const port = profile.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    problems.push('The port must be between 1 and 65535.');
  }
  return problems;
}

export function createMssqlFactory(): DriverFactory {
  return {
    engine: 'mssql',
    label: 'SQL Server',
    status: 'stable',
    capabilities: MSSQL_CAPABILITIES,
    defaultPort: DEFAULT_MSSQL_PORT,
    validate: validateMssqlConfig,
    create: (config, deps) => new MssqlDriver(config, deps),
  };
}

export const mssqlFactory: DriverFactory = createMssqlFactory();