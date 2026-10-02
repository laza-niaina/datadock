import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import initSqlJs from 'sql.js';
import { DbError } from '../../src/db/errors';
import { SqliteDriver } from '../../src/db/drivers/sqlite/sqliteDriver';
import { NULL_LOGGER } from '../../src/db/types';
import type { ConnectionConfig, ConnectionProfile } from '../../src/db/types';

/**
 * The only test that runs the real WASM engine - against a temporary file, so
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
/** Table of the write tests, which seed a file of their own. */
const NOTES_REF = { connectionId: 'p1', database: 'main', table: 'notes', kind: 'table' as const };

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
      database.run("INSERT INTO users (name, age) VALUES ('Ada', 36), ('Bob', 24)");
      // A real declared foreign key: SQLite keeps it in its own catalog, which
      // is why `listColumns` has to read `PRAGMA foreign_key_list` as well.
      database.run(
        'CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT, ' +
          'CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id))',
      );
      database.run("INSERT INTO posts (user_id, title) VALUES (1, 'Hello')");
      // The ER diagram shape: two roots and a join table with two foreign keys.
      database.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, ' +
        'total INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id))');
      database.run('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL)');
      database.run('CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, ' +
        'product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, ' +
        'FOREIGN KEY (order_id) REFERENCES orders(id), FOREIGN KEY (product_id) REFERENCES products(id))');
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
      { name: 'order_items', kind: 'table', tableType: 'TABLE' },
      { name: 'orders', kind: 'table', tableType: 'TABLE' },
      { name: 'posts', kind: 'table', tableType: 'TABLE' },
      { name: 'products', kind: 'table', tableType: 'TABLE' },
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
        isForeignKey: false,
        isAutoIncrement: true,
        defaultValue: undefined,
        ordinal: 1,
      },
      {
        name: 'name',
        dataType: 'TEXT',
        nullable: false,
        isPrimaryKey: false,
        isForeignKey: false,
        isAutoIncrement: false,
        defaultValue: undefined,
        ordinal: 2,
      },
      {
        name: 'age',
        dataType: 'INTEGER',
        nullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
        isAutoIncrement: false,
        defaultValue: '0',
        ordinal: 3,
      },
    ]);
    await driver.disconnect();
  });

  it('reads declared foreign keys from the SQLite catalog', async () => {
    const driver = newDriver(dbFile);
    await driver.connect();
    const ref = { connectionId: 'p1', database: 'main', table: 'posts', kind: 'table' as const };
    const columns = await driver.listColumns(ref);
    assert.deepEqual(
      columns.map((column) => [column.name, column.isPrimaryKey, column.isForeignKey]),
      [
        ['id', true, false],
        ['user_id', false, true],
        ['title', false, false],
      ],
    );
    await driver.disconnect();
  });

  it('reads every foreign key of the file in one catalog-wide call', async () => {
    const driver = newDriver(dbFile);
    await driver.connect();
    const keys = await driver.listForeignKeys(SCHEMA_REF);
    // Sorted here: SQLite assigns constraint ids itself, and the order of a
    // table's constraints is not part of any contract worth depending on.
    const rows = keys
      .map((key) => [key.sourceTable, key.sourceColumn, key.targetTable, key.targetColumn, key.ordinal])
      .sort((a, b) => `${a[0]}.${a[1]}`.localeCompare(`${b[0]}.${b[1]}`));
    assert.deepEqual(rows, [
      ['order_items', 'order_id', 'orders', 'id', 1],
      ['order_items', 'product_id', 'products', 'id', 1],
      ['orders', 'user_id', 'users', 'id', 1],
      ['posts', 'user_id', 'users', 'id', 1],
    ]);
    await driver.disconnect();
  });

  it('describes every relation of the file in one schema-wide call', async () => {
    const driver = newDriver(dbFile);
    await driver.connect();
    const relations = await driver.listSchemaColumns(SCHEMA_REF);
    assert.deepEqual(relations.map((relation) => relation.table), [
      'order_items',
      'orders',
      'posts',
      'products',
      'users',
      'v_users',
    ]);
    const orders = relations.find((relation) => relation.table === 'orders');
    assert.deepEqual(
      orders?.columns.map((column) => [column.name, column.isPrimaryKey, column.isForeignKey]),
      [
        ['id', true, false],
        ['user_id', false, true],
        ['total', false, false],
      ],
    );
    const items = relations.find((relation) => relation.table === 'order_items');
    assert.deepEqual(
      items?.columns.map((column) => [column.name, column.isPrimaryKey, column.isForeignKey]),
      [
        ['id', true, false],
        ['order_id', false, true],
        ['product_id', false, true],
        ['quantity', false, false],
      ],
    );
    // The view is a relation too, and it carries no constraints.
    const view = relations.find((relation) => relation.table === 'v_users');
    assert.deepEqual(view?.columns.map((column) => column.name), ['id', 'name']);
    await driver.disconnect();
  });

  it('executes read-only SQL and pages table data', async () => {
    const driver = newDriver(dbFile);
    await driver.connect();

    const result = await driver.execute("SELECT 1 AS answer UNION ALL SELECT 2");
    assert.equal(result.results.length, 1);
    assert.deepEqual(result.results[0].fields, [{ name: 'answer' }]);
    assert.deepEqual(result.results[0].rows, [[1], [2]]);
    assert.equal(result.results[0].isMutation, false);

    const page = await driver.getTableData(TABLE_REF, {
      offset: 0,
      limit: 1,
      sort: [{ column: 'name', direction: 'desc' }],
    });
    assert.equal(page.totalRows, 2);
    assert.equal(page.rows.length, 1);
    assert.deepEqual(page.rows[0], [2, 'Bob', 24]);
    assert.deepEqual(page.primaryKey, ['id']);
    // The profile is writable, so the page says so and the grid arms its
    // editors on it.
    assert.equal(page.editable, true);

    const searched = await driver.getTableData(TABLE_REF, { offset: 0, limit: 10, search: 'da' });
    assert.equal(searched.totalRows, 1);
    assert.deepEqual(searched.rows[0], [1, 'Ada', 36]);

    // ATTACH is the one statement the engine refuses outright: a second file
    // could never be written back through this connection.
    await assert.rejects(
      driver.execute("ATTACH DATABASE ':memory:' AS other"),
      isDbErrorCode('UNSUPPORTED_OPERATION'),
    );
    // A keyword inside a literal is data, not a statement: the batch stays
    // read-only and still returns its rows.
    const literal = await driver.execute("SELECT 'DELETE FROM users' AS text, 'x' AS other");
    assert.equal(literal.results[0].isMutation, false);
    assert.deepEqual(literal.results[0].rows, [['DELETE FROM users', 'x']]);
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

  // --- writing ---------------------------------------------------------------

  /** Seeds a file of its own, so a write test never disturbs the fixture. */
  async function seedNotes(file: string): Promise<void> {
    const SQL = await initSqlJs({ locateFile: (name: string) => path.join(ASSETS_DIR, name) });
    const database = new SQL.Database();
    try {
      database.run(
        'CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, flag INTEGER)',
      );
      database.run("INSERT INTO notes (body) VALUES ('one'), ('two')");
      writeFileSync(file, Buffer.from(database.export()));
    } finally {
      database.close();
    }
  }

  it('writes rows and persists them into the file', async () => {
    const file = path.join(tempDir, 'writable.db');
    await seedNotes(file);
    const driver = newDriver(file);
    await driver.connect();

    const page = await driver.getTableData(NOTES_REF, { offset: 0, limit: 10 });
    assert.equal(page.editable, true, 'a writable profile reports an editable page');
    assert.deepEqual(page.primaryKey, ['id']);

    // One cell edit: an UPDATE bound by the primary key, with NULL written as
    // NULL rather than as the four letters.
    assert.equal(
      await driver.updateRows(NOTES_REF, [
        { key: { id: 1 }, values: { body: 'edited', flag: null } },
      ]),
      1,
    );
    // A new row: the identity the engine reports comes back with it.
    assert.deepEqual(await driver.insertRow(NOTES_REF, { body: 'three' }), { id: 3 });
    // And a removal, keyed the same way.
    assert.equal(await driver.deleteRows(NOTES_REF, [{ id: 2 }]), 1);

    // The SQL editor writes the same way, and reports what the batch changed.
    const batch = await driver.execute(
      "SELECT 1 AS answer; UPDATE notes SET body = 'batch' WHERE id = 3",
    );
    assert.equal(batch.results[0].isMutation, true);
    assert.equal(batch.results[0].rowsAffected, 1);
    await driver.disconnect();

    // A second connection proves the bytes on disk carry every edit, not just
    // the in-memory snapshot.
    const reopened = newDriver(file);
    await reopened.connect();
    const after = await reopened.getTableData(NOTES_REF, { offset: 0, limit: 10 });
    assert.deepEqual(after.rows, [
      [1, 'edited', null],
      [3, 'batch', null],
    ]);
    await reopened.disconnect();
  });

  it('refuses every write on a read-only profile', async () => {
    const file = path.join(tempDir, 'locked.db');
    await seedNotes(file);
    const locked = new SqliteDriver(
      { profile: { ...profile(file), readOnly: true }, secrets: {} },
      { logger: NULL_LOGGER, assetsDir: ASSETS_DIR },
    );
    await locked.connect();

    const page = await locked.getTableData(NOTES_REF, { offset: 0, limit: 10 });
    assert.equal(page.editable, false, 'a read-only profile never offers an editable page');
    await assert.rejects(locked.execute('DELETE FROM notes'), isDbErrorCode('PERMISSION_DENIED'));
    await assert.rejects(
      locked.updateRows(NOTES_REF, [{ key: { id: 1 }, values: { body: 'nope' } }]),
      isDbErrorCode('PERMISSION_DENIED'),
    );
    await locked.disconnect();

    const check = newDriver(file);
    await check.connect();
    const after = await check.getTableData(NOTES_REF, { offset: 0, limit: 10 });
    assert.equal(after.totalRows, 2, 'nothing reached the file');
    await check.disconnect();
  });

  it('refuses to overwrite a file another program changed', async () => {
    const file = path.join(tempDir, 'contested.db');
    await seedNotes(file);
    const driver = newDriver(file);
    await driver.connect();

    // Another program owns the file now: different bytes, different timestamp.
    const SQL = await initSqlJs({ locateFile: (name: string) => path.join(ASSETS_DIR, name) });
    const other = new SQL.Database();
    try {
      other.run(
        'CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, flag INTEGER)',
      );
      other.run('BEGIN');
      for (let index = 0; index < 200; index += 1) {
        other.run("INSERT INTO notes (body) VALUES ('theirs')");
      }
      other.run('COMMIT');
      writeFileSync(file, Buffer.from(other.export()));
      const stamp = new Date(Date.now() - 60_000);
      utimesSync(file, stamp, stamp);
    } finally {
      other.close();
    }

    await assert.rejects(
      driver.updateRows(NOTES_REF, [{ key: { id: 1 }, values: { body: 'mine' } }]),
      /changed on disk/,
    );
    await driver.disconnect();

    // The foreign version is untouched: DataDock wrote nothing over it.
    const check = newDriver(file);
    await check.connect();
    const after = await check.getTableData(NOTES_REF, { offset: 0, limit: 10 });
    assert.equal(after.totalRows, 200);
    await check.disconnect();
  });
});
