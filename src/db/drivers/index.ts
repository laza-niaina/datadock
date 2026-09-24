/**
 * Registration entry point for the engines this build implements.
 *
 * The registry is the single source of truth for what the connection wizard may
 * offer, so this is the only place drivers meet the rest of the extension.
 *
 * Call it once per registry: `DriverRegistry.register()` deliberately rejects a
 * duplicate engine.
 */

import type { DriverRegistry } from '../driverRegistry';
import { mariadbFactory, mysqlFactory } from './mysql/mysqlFactory';
import { sqliteFactory } from './sqlite/sqliteFactory';
import { postgresqlFactory } from './postgresql/postgresqlFactory';
import { mssqlFactory } from './mssql/mssqlFactory';

export { mariadbFactory, mysqlFactory, sqliteFactory, postgresqlFactory, mssqlFactory };

export function registerBuiltinDrivers(registry: DriverRegistry): void {
  registry.register(mysqlFactory);
  registry.register(mariadbFactory);
  registry.register(sqliteFactory);
  registry.register(postgresqlFactory);
  registry.register(mssqlFactory);
}