import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registerBuiltinDrivers } from '../../src/db/drivers';
import { DriverRegistry } from '../../src/db/driverRegistry';
import { DbError } from '../../src/db/errors';
import { NULL_LOGGER } from '../../src/db/types';
import type { ConnectionConfig, DriverCapabilities } from '../../src/db/types';

function config(engine: 'mysql' | 'mariadb' | 'sqlite' | 'postgresql' | 'mssql'): ConnectionConfig {
  return {
    profile: {
      id: 'p1',
      name: 'p1',
      engine,
      host: 'localhost',
      port: engine === 'postgresql' ? 5432 : engine === 'mssql' ? 1433 : 3306,
      user: 'root',
      database: 'app',
      options: { filePath: '/tmp/x.db' },
      createdAt: 0,
      updatedAt: 0,
    },
    secrets: {},
  };
}

describe('registerBuiltinDrivers', () => {
  it('registers exactly mysql, mariadb, sqlite, postgresql and mssql on its own registry', () => {
    const registry = new DriverRegistry('test');
    registerBuiltinDrivers(registry);

    assert.equal(registry.size, 5);
    assert.deepEqual(
      registry.available().map((factory) => factory.engine),
      ['mysql', 'mariadb', 'sqlite', 'postgresql', 'mssql'],
    );
  });

  it('offers every factory to the wizard (none is planned)', () => {
    const registry = new DriverRegistry('test');
    registerBuiltinDrivers(registry);
    for (const factory of registry.all()) {
      assert.notEqual(factory.status, 'planned');
      assert.ok(factory.label.length > 0);
    }
  });

  it('gives MySQL, MariaDB, PostgreSQL and SQL Server distinct factories with correct server defaults', () => {
    const registry = new DriverRegistry('test');
    registerBuiltinDrivers(registry);

    const mysql = registry.require('mysql');
    const mariadb = registry.require('mariadb');
    const postgresql = registry.require('postgresql');
    const mssql = registry.require('mssql');
    assert.notEqual(mysql, mariadb);
    assert.equal(mysql.defaultPort, 3306);
    assert.equal(mariadb.defaultPort, 3306);
    assert.equal(mysql.fileBased, undefined);
    assert.equal(mariadb.fileBased, undefined);
    assert.equal(postgresql.engine, 'postgresql');
    assert.equal(postgresql.label, 'PostgreSQL');
    assert.equal(postgresql.defaultPort, 5432);
    assert.equal(postgresql.fileBased, undefined);
    assert.equal(mssql.engine, 'mssql');
    assert.equal(mssql.label, 'SQL Server');
    assert.equal(mssql.defaultPort, 1433);
    assert.equal(mssql.fileBased, undefined);
  });

  it('marks SQLite as file-based with no default port', () => {
    const registry = new DriverRegistry('test');
    registerBuiltinDrivers(registry);

    const sqlite = registry.require('sqlite');
    assert.equal(sqlite.fileBased, true);
    assert.equal(sqlite.defaultPort, undefined);
  });

  it('documents the capabilities the drivers really have', () => {
    const registry = new DriverRegistry('test');
    registerBuiltinDrivers(registry);

    const expectedSqlite: DriverCapabilities = {
      schemas: false,
      multipleDatabases: false,
      views: true,
      routines: false,
      editableData: false,
      serverSidePagination: true,
      countRows: false,
      transactions: false,
      ssl: false,
      sshTunnel: false,
    };
    assert.deepEqual(registry.require('sqlite').capabilities, expectedSqlite);

    const mysql = registry.require('mysql').capabilities;
    assert.equal(mysql.schemas, false, 'a MySQL schema IS a database: the schema level must stay off');
    assert.equal(mysql.multipleDatabases, true);
    assert.equal(mysql.views, true);
    assert.equal(mysql.routines, true);
    assert.equal(mysql.editableData, false);
    assert.equal(mysql.backupTool, 'mysqldump');

    const mariadb = registry.require('mariadb').capabilities;
    assert.equal(mariadb.backupTool, 'mariadb-dump');
    assert.deepEqual(
      { ...mariadb, backupTool: undefined },
      { ...mysql, backupTool: undefined },
    );

    const postgresql = registry.require('postgresql').capabilities;
    assert.equal(postgresql.schemas, true, 'PostgreSQL has real schemas inside a database');
    assert.equal(postgresql.multipleDatabases, true);
    assert.equal(postgresql.serverSidePagination, true);
    assert.equal(postgresql.countRows, false, 'PostgreSQL has no cheap COUNT, like MySQL');
    assert.equal(postgresql.backupTool, 'pg_dump');

    const mssql = registry.require('mssql').capabilities;
    assert.equal(mssql.schemas, true);
    assert.equal(mssql.multipleDatabases, true);
    assert.equal(mssql.serverSidePagination, true);
    assert.equal(mssql.countRows, false);
    assert.equal(mssql.backupTool, 'sqlcmd');
  });

  it('creates connected-state drivers without opening a socket', () => {
    const registry = new DriverRegistry('test');
    registerBuiltinDrivers(registry);

    for (const engine of ['mysql', 'mariadb', 'sqlite', 'postgresql', 'mssql'] as const) {
      const driver = registry.require(engine).create(config(engine), { logger: NULL_LOGGER });
      assert.equal(driver.engine, engine);
      assert.equal(driver.isConnected(), false);
    }
  });

  it('refuses a second registration for the same registry', () => {
    const registry = new DriverRegistry('test');
    registerBuiltinDrivers(registry);
    assert.throws(() => registerBuiltinDrivers(registry), (error: unknown) => {
      return error instanceof DbError && error.code === 'CONFIG_ERROR';
    });
  });
});

