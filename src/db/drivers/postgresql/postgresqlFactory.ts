/**
 * `DriverFactory` for PostgreSQL.
 *
 * The registry refuses to register the same engine twice, so this module owns
 * the single factory object for `postgresql`. The implementation lives in the
 * driver to keep the factory → driver dependency one-way (same pattern as the
 * MySQL factory, avoiding the circular-import bug class).
 */

import type { ConnectionConfig } from '../../types';
import type { DriverFactory } from '../../driverRegistry';
import { POSTGRES_CAPABILITIES, PostgresqlDriver } from './postgresqlDriver';
import { DEFAULT_POSTGRES_PORT } from './postgresqlConnectionOptions';

export { POSTGRES_CAPABILITIES } from './postgresqlDriver';

/** Socket-free profile validation: the same problems the wizard would report. */
export function validatePostgresConfig(config: ConnectionConfig): string[] {
  const problems: string[] = [];
  const profile = config.profile;
  if (!profile.host || profile.host.trim() === '') {
    problems.push('A host is required.');
  }
  if (!profile.user || profile.user.trim() === '') {
    problems.push('A user name is required for PostgreSQL.');
  }
  const port = profile.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    problems.push('The port must be between 1 and 65535.');
  }
  return problems;
}

export function createPostgresqlFactory(): DriverFactory {
  return {
    engine: 'postgresql',
    label: 'PostgreSQL',
    status: 'stable',
    capabilities: POSTGRES_CAPABILITIES,
    defaultPort: DEFAULT_POSTGRES_PORT,
    validate: validatePostgresConfig,
    create: (config, deps) => new PostgresqlDriver(config, deps),
  };
}

export const postgresqlFactory: DriverFactory = createPostgresqlFactory();