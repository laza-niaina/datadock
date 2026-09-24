import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import { MARIADB_CAPABILITIES, MYSQL_CAPABILITIES, MySqlDriver, quoteMysqlIdentifier, useDatabaseTargetFrom } from '../../src/db/drivers/mysql/mysqlDriver';
import { NULL_LOGGER } from '../../src/db/types';
import type { ConnectionConfig, ConnectionProfile } from '../../src/db/types';

/**
 * Guard tests only: no socket is ever opened, they pin the driver's contract
 * for the disconnected state and the milestone-absent operations.
 */
function profile(engine: 'mysql' | 'mariadb'): ConnectionProfile {
  return {
    id: 'p1',
    name: 'p1',
    engine,
    host: 'db.example.com',
    port: 3306,
    user: 'app',
    database: 'app',
    createdAt: 0,
    updatedAt: 0,
  };
}

function config(engine: 'mysql' | 'mariadb'): ConnectionConfig {
  return { profile: profile(engine), secrets: {} };
}

const SCHEMA_REF = { connectionId: 'p1', database: 'app' };
const TABLE_REF = { connectionId: 'p1', database: 'app', table: 'users', kind: 'table' as const };

function isDbErrorCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DbError && error.code === code;
}

describe('MySqlDriver (disconnected guard)', () => {
  it('exposes the mysql identity and capabilities', () => {
    const driver = new MySqlDriver('mysql', config('mysql'), { logger: NULL_LOGGER });
    assert.equal(driver.engine, 'mysql');
    assert.equal(driver.capabilities, MYSQL_CAPABILITIES);
  });

  it('exposes the mariadb identity and capabilities', () => {
    const driver = new MySqlDriver('mariadb', config('mariadb'), { logger: NULL_LOGGER });
    assert.equal(driver.engine, 'mariadb');
    assert.equal(driver.capabilities, MARIADB_CAPABILITIES);
  });

  it('quotes MySQL identifiers without allowing delimiter injection', () => {
    assert.equal(quoteMysqlIdentifier('users'), '`users`');
    assert.equal(quoteMysqlIdentifier('we`ird'), '`we``ird`');
  });

  it('reports disconnected before connect', () => {
    const driver = new MySqlDriver('mysql', config('mysql'), { logger: NULL_LOGGER });
    assert.equal(driver.isConnected(), false);
  });

  it('rejects connection-bound calls with CONNECTION_LOST', async () => {
    const driver = new MySqlDriver('mysql', config('mysql'), { logger: NULL_LOGGER });
    await assert.rejects(driver.ping(), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listDatabases(), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listTables(SCHEMA_REF), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listColumns(TABLE_REF), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listRoutines(SCHEMA_REF), isDbErrorCode('CONNECTION_LOST'));
  });

  it('answers listSchemas truthfully without a socket', async () => {
    const driver = new MySqlDriver('mysql', config('mysql'), { logger: NULL_LOGGER });
    assert.deepEqual(await driver.listSchemas(' app '), ['app']);
    assert.deepEqual(await driver.listSchemas(undefined), []);
    assert.deepEqual(await driver.listSchemas('   '), []);
  });

  it('requires a live connection for execute and getTableData', async () => {
    const driver = new MySqlDriver('mysql', config('mysql'), { logger: NULL_LOGGER });
    await assert.rejects(driver.execute('SELECT 1'), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(
      driver.getTableData(TABLE_REF, { offset: 0, limit: 50 }),
      isDbErrorCode('CONNECTION_LOST'),
    );
  });

  it('refuses mutations on a read-only profile before opening a socket', async () => {
    const readOnlyConfig = config('mysql');
    readOnlyConfig.profile.readOnly = true;
    const driver = new MySqlDriver('mysql', readOnlyConfig, { logger: NULL_LOGGER });
    await assert.rejects(driver.execute('DELETE FROM users'), isDbErrorCode('PERMISSION_DENIED'));
  });

  it('tolerates disconnect when never connected', async () => {
    const driver = new MySqlDriver('mysql', config('mysql'), { logger: NULL_LOGGER });
    await driver.disconnect();
    await driver.disconnect();
    assert.equal(driver.isConnected(), false);
  });
});

describe('useDatabaseTargetFrom', () => {
  it('parses a bare USE target', () => {
    assert.equal(useDatabaseTargetFrom('USE learn'), 'learn');
    assert.equal(useDatabaseTargetFrom('use learn;'), 'learn');
    assert.equal(useDatabaseTargetFrom('USE  learn;'), 'learn');
  });

  it('parses a backtick-quoted target and unescapes embedded backticks', () => {
    assert.equal(useDatabaseTargetFrom('USE `learn`'), 'learn');
    assert.equal(useDatabaseTargetFrom('USE `my db`;'), 'my db');
    assert.equal(useDatabaseTargetFrom('USE `we``ird`'), 'we`ird');
  });

  it('skips leading comments before the keyword', () => {
    assert.equal(useDatabaseTargetFrom('-- switch\nUSE learn'), 'learn');
    assert.equal(useDatabaseTargetFrom('/* c */ USE learn; SELECT 1'), 'learn');
  });

  it('ignores trailing clauses after the identifier', () => {
    assert.equal(useDatabaseTargetFrom('USE learn WITH READ REPLICA'), 'learn');
  });

  it('returns undefined when the statement does not target a database', () => {
    assert.equal(useDatabaseTargetFrom('SELECT 1'), undefined);
    assert.equal(useDatabaseTargetFrom('USERS'), undefined);
    assert.equal(useDatabaseTargetFrom('USE'), undefined);
    assert.equal(useDatabaseTargetFrom('USE ;'), undefined);
    assert.equal(useDatabaseTargetFrom(''), undefined);
  });
});
