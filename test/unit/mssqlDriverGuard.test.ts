import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import {
  MSSQL_CAPABILITIES,
  MssqlDriver,
  mssqlResultSet,
  type MssqlResultLike,
} from '../../src/db/drivers/mssql/mssqlDriver';
import { quoteMssqlIdentifier } from '../../src/db/drivers/mssql/mssqlCatalog';
import { NULL_LOGGER } from '../../src/db/types';
import type { ConnectionConfig, ConnectionProfile } from '../../src/db/types';

/**
 * Guard tests only: no socket is ever opened, they pin the driver's contract
 * for the disconnected state and the milestone-absent operations.
 */
function config(): ConnectionConfig {
  const profile: ConnectionProfile = {
    id: 'p1',
    name: 'p1',
    engine: 'mssql',
    host: 'db.example.com',
    port: 1433,
    user: 'app',
    database: 'app',
    createdAt: 0,
    updatedAt: 0,
  };
  return { profile, secrets: {} };
}

const SCHEMA_REF = { connectionId: 'p1', database: 'app', schema: 'dbo' };
const TABLE_REF = { connectionId: 'p1', database: 'app', schema: 'dbo', table: 'users', kind: 'table' as const };

function isDbErrorCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DbError && error.code === code;
}

describe('MssqlDriver (disconnected guard)', () => {
  it('exposes the mssql identity and capabilities', () => {
    const driver = new MssqlDriver(config(), { logger: NULL_LOGGER });
    assert.equal(driver.engine, 'mssql');
    assert.equal(driver.capabilities, MSSQL_CAPABILITIES);
    assert.equal(driver.capabilities.backupTool, 'sqlcmd');
  });

  it('quotes SQL Server identifiers without allowing delimiter injection', () => {
    assert.equal(quoteMssqlIdentifier('users'), '[users]');
    assert.equal(quoteMssqlIdentifier('we]ird'), '[we]]ird]');
  });

  it('reports disconnected before connect', () => {
    const driver = new MssqlDriver(config(), { logger: NULL_LOGGER });
    assert.equal(driver.isConnected(), false);
  });

  it('rejects connection-bound calls with CONNECTION_LOST', async () => {
    const driver = new MssqlDriver(config(), { logger: NULL_LOGGER });
    await assert.rejects(driver.ping(), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listDatabases(), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listSchemas('app'), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listTables(SCHEMA_REF), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listColumns(TABLE_REF), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listRoutines(SCHEMA_REF), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.selectDatabase('warehouse'), isDbErrorCode('CONNECTION_LOST'));
  });

  it('requires a live connection for execute and getTableData', async () => {
    const driver = new MssqlDriver(config(), { logger: NULL_LOGGER });
    await assert.rejects(driver.execute('SELECT 1'), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(
      driver.getTableData(TABLE_REF, { offset: 0, limit: 50 }),
      isDbErrorCode('CONNECTION_LOST'),
    );
  });

  it('rejects an empty statement and read-only mutations before opening a socket', async () => {
    const driver = new MssqlDriver(config(), { logger: NULL_LOGGER });
    await assert.rejects(driver.execute('  '), isDbErrorCode('QUERY_ERROR'));

    const readOnlyConfig = config();
    readOnlyConfig.profile.readOnly = true;
    const readOnly = new MssqlDriver(readOnlyConfig, { logger: NULL_LOGGER });
    await assert.rejects(readOnly.execute('DELETE FROM users'), isDbErrorCode('PERMISSION_DENIED'));
    await assert.rejects(readOnly.execute('EXEC dbo.purge'), isDbErrorCode('PERMISSION_DENIED'));
    // Session-scoping statements stay allowed on read-only profiles.
    await assert.rejects(readOnly.execute('USE warehouse'), isDbErrorCode('CONNECTION_LOST'));
  });

  it('tolerates disconnect when never connected', async () => {
    const driver = new MssqlDriver(config(), { logger: NULL_LOGGER });
    await driver.disconnect();
    await driver.disconnect();
    assert.equal(driver.isConnected(), false);
  });
});

describe('mssqlResultSet', () => {
  function result(overrides: Partial<MssqlResultLike> = {}): MssqlResultLike {
    return {
      recordset: [],
      rowsAffected: [],
      command: 'SELECT',
      ...overrides,
    };
  }

  /** Builds the recordset the tedious runtime hands over: rows plus non-enumerable `columns`. */
  function recordset(
    rows: ReadonlyArray<Record<string, unknown>>,
    columns?: Record<string, { name: string; type?: { name?: string; declaration?: string } }>,
  ): NonNullable<MssqlResultLike['recordset']> {
    const set = [...rows];
    if (columns) {
      Object.defineProperty(set, 'columns', { value: columns, enumerable: false, configurable: true });
    }
    return set as NonNullable<MssqlResultLike['recordset']>;
  }

  it('distinguishes a zero-row SELECT from a mutation via column metadata', () => {
    const mapped = mssqlResultSet(
      result({
        recordset: recordset([], { id: { name: 'id', type: { name: 'IntN', declaration: 'int' } } }),
        rowsAffected: [0],
      }),
      'SELECT id FROM users WHERE 1 = 0',
    );
    assert.equal(mapped.isMutation, false);
    assert.deepEqual(mapped.fields, [{ name: 'id', type: 'int' }]);
    assert.deepEqual(mapped.rows, []);
  });

  it('marks statements without columns as mutations and reports rowsAffected', () => {
    // Mutations never receive column metadata, so `recordset` stays undefined.
    const mapped = mssqlResultSet(result({ recordset: undefined, rowsAffected: [3] }), 'DELETE FROM users');
    assert.equal(mapped.isMutation, true);
    assert.equal(mapped.rowsAffected, 3);
    assert.deepEqual(mapped.fields, []);
  });

  it('falls back to the type name when no declaration is present', () => {
    const mapped = mssqlResultSet(
      result({ recordset: recordset([], { note: { name: 'note', type: { name: 'NVarChar' } } }) }),
      'SELECT note FROM users',
    );
    assert.deepEqual(mapped.fields, [{ name: 'note', type: 'NVarChar' }]);
  });

  it('fills missing values with null and truncates oversized sets', () => {
    const rows = Array.from({ length: 10_003 }, (_, index) => ({ id: index, note: null }));
    const mapped = mssqlResultSet(
      result({
        recordset: recordset(rows, {
          id: { name: 'id', type: { declaration: 'int' } },
          note: { name: 'note', type: { declaration: 'nvarchar(max)' } },
        }),
        rowsAffected: [rows.length],
      }),
      'SELECT id, note FROM big',
    );
    assert.equal(mapped.truncated, true);
    assert.equal(mapped.rows.length, 10_000);
    assert.deepEqual(mapped.rows[9999], [9999, null]);
  });
});