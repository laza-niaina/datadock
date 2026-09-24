import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import initSqlJs from 'sql.js';
import { DbError } from '../../src/db/errors';
import { SqliteDriver } from '../../src/db/drivers/sqlite/sqliteDriver';
import { NULL_LOGGER } from '../../src/db/types';
import type { ConnectionConfig, ConnectionProfile } from '../../src/db/types';

/**
 * The only test that runs the real WASM engine — against a temporary file, so
 * no server and no fixture repository is needed. It uses the sql.js asset
 * shipped in node_modules (the same file `esbuild.js` copies to dist/), and
 * skips itself when that file is absent.
 */
const ASSETS_DIR = path.resolve('node_modules/sql.js/dist');
const wasmAvailable = existsSync(path.join(ASSETS_DIR, 'sql-wasm.wasm'));

function profile(filePath: string): ConnectionProfile {
  return {
    id: 'p1',
    name: 'p1',
    engine: 'sqlite',
    options: { filePath },
    createdAt: 0,
    updatedAt: 0,
  };
}

function config(filePath: string): ConnectionConfig {
  return { profile: profile(filePath), secrets: {} };
}

const SCHEMA_REF = { connectionId: 'p1', database: 'main' };
const TABLE_REF = { connectionId: 'p1', database: 'main', table: 'users', kind: 'table' as const };

function isDbErrorCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DbError && error.code === code;
}

function newDriver(filePath: string): SqliteDriver {
  return new SqliteDriver(config(filePath), { logger: NULL_LOGGER, assetsDir: ASSETS_DIR });
}

describe('SqliteDriver (integration)', { skip: !wasmAvailable && 'sql-wasm.wasm is not installed' }, () => {
  let tempDir: string;
  let dbFile: string;

  before(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'datadock-sqlite-'));
    dbFile = path.join(tempDir, 'sample.db');
    const SQL = await initSqlJs({ locateFile: (file) => path.join(ASSETS_DIR, file) });
    const database = new SQL.Database();
    try {
      // AUTOINCREMENT on purpose: it creates sqlite_sequence, which the catalog
      // query must hide.
      database.run('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, age INTEGER DEFAULT 0)');
      database.run('CREATE VIEW v_users AS SELECT id, name FROM users');
      writeFileSync(dbFile, Buffer.from(database.export()));
    } finally {
      database.close();
    }
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('connects, pings and reports its identity', async () => {
    const driver = newDriver(dbFile);
    assert.equal(driver.engine, 'sqlite');
    assert.equal(driver.isConnected(), false);
    await driver.connect();
    assert.equal(driver.isConnected(), true);
    assert.equal(driver.getDatabaseFilePath(), dbFile);
    assert.ok((await driver.ping()) >= 0);
    assert.deepEqual(await driver.listDatabases(), ['main']);
    assert.deepEqual(await driver.listSchemas(undefined), ['main']);
    assert.deepEqual(await driver.listSchemas('any'), ['any']);
    await driver.disconnect();
    assert.equal(driver.isConnected(), false);
    assert.equal(driver.getDatabaseFilePath(), undefined);
  });

  it('lists tables and views, hiding sqlite_ internals', async () => {
    const driver = newDriver(dbFile);
    await driver.connect();
    assert.deepEqual(await driver.listTables(SCHEMA_REF), [
      { name: 'users', kind: 'table', tableType: 'TABLE' },
      { name: 'v_users', kind: 'view', tableType: 'VIEW' },
    ]);
    await driver.disconnect();
  });

  it('describes columns with primary key and auto-increment', async () => {
    const driver = newDriver(dbFile);
    await driver.connect();
    assert.deepEqual(await driver.listColumns(TABLE_REF), [
      {
        name: 'id',
        dataType: 'INTEGER',
        nullable: false,
        isPrimaryKey: true,
        isAutoIncrement: true,
        defaultValue: undefined,
        ordinal: 1,
      },
      {
        name: 'name',
        dataType: 'TEXT',
        nullable: false,
        isPrimaryKey: false,
        isAutoIncrement: false,
        defaultValue: undefined,
        ordinal: 2,
      },
      {
        name: 'age',
        dataType: 'INTEGER',
        nullable: true,
        isPrimaryKey: false,
        isAutoIncrement: false,
        defaultValue: '0',
        ordinal: 3,
      },
    ]);
    await driver.disconnect();
  });

  it('rejects execute and getTableData with UNSUPPORTED_OPERATION', async () => {
    const driver = newDriver(dbFile);
    await driver.connect();
    await assert.rejects(driver.execute('SELECT 1'), isDbErrorCode('UNSUPPORTED_OPERATION'));
    await assert.rejects(
      driver.getTableData(TABLE_REF, { offset: 0, limit: 50 }),
      isDbErrorCode('UNSUPPORTED_OPERATION'),
    );
    await driver.disconnect();
  });

  it('rejects catalog calls while disconnected with CONNECTION_LOST', async () => {
    const driver = newDriver(dbFile);
    await assert.rejects(driver.ping(), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listTables(SCHEMA_REF), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listColumns(TABLE_REF), isDbErrorCode('CONNECTION_LOST'));
  });

  it('reconnects to the same file after a disconnect', async () => {
    const driver = newDriver(dbFile);
    await driver.connect();
    await driver.disconnect();
    await driver.connect();
    assert.equal(driver.isConnected(), true);
    assert.deepEqual(await driver.listDatabases(), ['main']);
    await driver.disconnect();
  });

  it('reports a missing file as DATABASE_NOT_FOUND', async () => {
    const driver = newDriver(path.join(tempDir, 'missing.db'));
    await assert.rejects(driver.connect(), isDbErrorCode('DATABASE_NOT_FOUND'));
  });

  it('reports a directory as CONFIG_ERROR', async () => {
    const driver = newDriver(tempDir);
    await assert.rejects(driver.connect(), isDbErrorCode('CONFIG_ERROR'));
  });

  it('reports a non-database file as QUERY_ERROR', async () => {
    const bogus = path.join(tempDir, 'bogus.db');
    writeFileSync(bogus, 'definitely not a sqlite database file');
    const driver = newDriver(bogus);
    await assert.rejects(driver.connect(), isDbErrorCode('QUERY_ERROR'));
  });
});
