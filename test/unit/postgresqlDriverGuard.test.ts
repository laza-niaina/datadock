import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import {
  POSTGRES_CAPABILITIES,
  PostgresqlDriver,
  postgresResultSet,
  type PostgresQueryResultLike,
} from '../../src/db/drivers/postgresql/postgresqlDriver';
import { quotePostgresIdentifier } from '../../src/db/drivers/postgresql/postgresqlCatalog';
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
    engine: 'postgresql',
    host: 'db.example.com',
    port: 5432,
    user: 'app',
    database: 'app',
    createdAt: 0,
    updatedAt: 0,
  };
  return { profile, secrets: {} };
}

const SCHEMA_REF = { connectionId: 'p1', database: 'app', schema: 'public' };
const TABLE_REF = { connectionId: 'p1', database: 'app', schema: 'public', table: 'users', kind: 'table' as const };

function isDbErrorCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DbError && error.code === code;
}

describe('PostgresqlDriver (disconnected guard)', () => {
  it('exposes the postgresql identity and capabilities', () => {
    const driver = new PostgresqlDriver(config(), { logger: NULL_LOGGER });
    assert.equal(driver.engine, 'postgresql');
    assert.equal(driver.capabilities, POSTGRES_CAPABILITIES);
    assert.equal(driver.capabilities.backupTool, 'pg_dump');
  });

  it('quotes PostgreSQL identifiers without allowing delimiter injection', () => {
    assert.equal(quotePostgresIdentifier('users'), '"users"');
    assert.equal(quotePostgresIdentifier('we"ird'), '"we""ird"');
  });

  it('reports disconnected before connect', () => {
    const driver = new PostgresqlDriver(config(), { logger: NULL_LOGGER });
    assert.equal(driver.isConnected(), false);
  });

  it('rejects connection-bound calls with CONNECTION_LOST', async () => {
    const driver = new PostgresqlDriver(config(), { logger: NULL_LOGGER });
    await assert.rejects(driver.ping(), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listDatabases(), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listSchemas('app'), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listTables(SCHEMA_REF), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listColumns(TABLE_REF), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(driver.listRoutines(SCHEMA_REF), isDbErrorCode('CONNECTION_LOST'));
  });

  it('requires a live connection for execute and getTableData', async () => {
    const driver = new PostgresqlDriver(config(), { logger: NULL_LOGGER });
    await assert.rejects(driver.execute('SELECT 1'), isDbErrorCode('CONNECTION_LOST'));
    await assert.rejects(
      driver.getTableData(TABLE_REF, { offset: 0, limit: 50 }),
      isDbErrorCode('CONNECTION_LOST'),
    );
  });

  it('rejects an empty statement and read-only mutations before opening a socket', async () => {
    const driver = new PostgresqlDriver(config(), { logger: NULL_LOGGER });
    await assert.rejects(driver.execute('  '), isDbErrorCode('QUERY_ERROR'));

    const readOnlyConfig = config();
    readOnlyConfig.profile.readOnly = true;
    const readOnly = new PostgresqlDriver(readOnlyConfig, { logger: NULL_LOGGER });
    await assert.rejects(readOnly.execute('DELETE FROM users'), isDbErrorCode('PERMISSION_DENIED'));
    // Session-scoping statements stay allowed on read-only profiles.
    await assert.rejects(readOnly.execute('SET search_path TO public'), isDbErrorCode('CONNECTION_LOST'));
  });

  it('tolerates disconnect when never connected', async () => {
    const driver = new PostgresqlDriver(config(), { logger: NULL_LOGGER });
    await driver.disconnect();
    await driver.disconnect();
    assert.equal(driver.isConnected(), false);
  });
});

describe('postgresResultSet', () => {
  function result(overrides: Partial<PostgresQueryResultLike> = {}): PostgresQueryResultLike {
    return {
      rows: [],
      fields: [],
      rowCount: 0,
      command: 'SELECT',
      ...overrides,
    };
  }

  it('maps field metadata with readable type names', () => {
    const mapped = postgresResultSet(
      result({
        fields: [
          { name: 'id', dataTypeID: 23 },
          { name: 'created_at', dataTypeID: 1114 },
          { name: 'meta', dataTypeID: 114 },
          { name: 'unknown', dataTypeID: 999999 },
        ],
        rows: [{ id: 1, created_at: '2026-09-24 10:00:00', meta: '{}', unknown: null }],
        rowCount: 1,
      }),
      'SELECT ...',
    );
    assert.equal(mapped.isMutation, false);
    assert.deepEqual(mapped.fields, [
      { name: 'id', type: 'int4' },
      { name: 'created_at', type: 'timestamp' },
      { name: 'meta', type: 'json' },
      { name: 'unknown', type: '999999' },
    ]);
    // Temporal and JSON values stay as raw server text (no local-timezone shift).
    assert.deepEqual(mapped.rows[0], [1, '2026-09-24 10:00:00', '{}', null]);
  });

  it('marks statements without fields as mutations and reports rowsAffected', () => {
    const mapped = postgresResultSet(
      result({ fields: [], rows: [], rowCount: 7, command: 'DELETE' }),
      'DELETE FROM users',
    );
    assert.equal(mapped.isMutation, true);
    assert.equal(mapped.rowsAffected, 7);
    assert.deepEqual(mapped.fields, []);
  });

  it('skips rowsAffected when rowCount is absent', () => {
    const mapped = postgresResultSet(result({ fields: [], rows: [], rowCount: null, command: 'INSERT' }), 'INSERT ...');
    assert.equal(mapped.isMutation, true);
    assert.equal(mapped.rowsAffected, undefined);
  });

  it('truncates oversized result sets and flags the truncation', () => {
    const rows = Array.from({ length: 10_005 }, (_, index) => ({ id: index }));
    const mapped = postgresResultSet(
      result({ fields: [{ name: 'id', dataTypeID: 23 }], rows, rowCount: rows.length }),
      'SELECT id FROM big',
    );
    assert.equal(mapped.truncated, true);
    assert.equal(mapped.rows.length, 10_000);
  });
});