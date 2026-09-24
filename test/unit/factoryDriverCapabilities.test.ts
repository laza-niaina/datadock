import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mariadbFactory, mysqlFactory } from '../../src/db/drivers/mysql/mysqlFactory';
import { sqliteFactory } from '../../src/db/drivers/sqlite/sqliteFactory';
import { NULL_LOGGER } from '../../src/db/types';
import type { ConnectionConfig, ConnectionProfile, DriverCapabilities, EngineId } from '../../src/db/types';

/**
 * Regression guard for a bug found during the first F5 run: the MySQL driver
 * read `MYSQL_CAPABILITIES` from the factory module at module-evaluation time.
 * The factory imports the driver, so in the esbuild bundle - where the factory
 * evaluates first - the driver captured `undefined` capabilities and every
 * connect failed with "Cannot read properties of undefined (reading
 * 'multipleDatabases')" while all test files stayed green, because their
 * import order evaluated the driver first.
 *
 * This file imports the factories first, i.e. the extension bundle's order,
 * so the bug class cannot come back unnoticed.
 */

const BOOLEAN_KEYS = [
  'schemas',
  'multipleDatabases',
  'views',
  'routines',
  'editableData',
  'serverSidePagination',
  'countRows',
  'transactions',
  'ssl',
  'sshTunnel',
] as const satisfies readonly (keyof DriverCapabilities)[];

function config(engine: EngineId): ConnectionConfig {
  const base: ConnectionProfile = {
    id: 'factory-check',
    name: 'factory-check',
    engine,
    createdAt: 0,
    updatedAt: 0,
  };
  const profile: ConnectionProfile =
    engine === 'sqlite'
      ? { ...base, options: { filePath: 'app.db' } }
      : { ...base, host: 'db.example.com', user: 'app' };
  return { profile, secrets: {} };
}

describe('factory.create wires fully defined capabilities (bundle import order)', () => {
  for (const factory of [mysqlFactory, mariadbFactory, sqliteFactory]) {
    it(`gives ${factory.engine} drivers every boolean capability`, () => {
      const driver = factory.create(config(factory.engine), { logger: NULL_LOGGER });
      assert.equal(driver.engine, factory.engine);
      for (const key of BOOLEAN_KEYS) {
        assert.equal(typeof driver.capabilities[key], 'boolean', `${factory.engine}.capabilities.${key}`);
      }
      assert.equal(driver.capabilities, factory.capabilities);
    });
  }
});
