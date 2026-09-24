import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isRowIdAlias,
  quoteSqliteIdentifier,
  rowsFromExecResult,
  tableInfoPragma,
  toSqliteColumnInfos,
  toSqliteTableInfos,
  type SqliteExecResult,
} from '../../src/db/drivers/sqlite/sqliteCatalog';

describe('quoteSqliteIdentifier / tableInfoPragma', () => {
  it('double-quotes identifiers and doubles embedded quotes', () => {
    assert.equal(quoteSqliteIdentifier('users'), '"users"');
    assert.equal(quoteSqliteIdentifier('we"ird'), '"we""ird"');
    assert.equal(quoteSqliteIdentifier(''), '""');
  });

  it('interpolates the quoted identifier into the pragma', () => {
    assert.equal(tableInfoPragma('users'), 'PRAGMA table_info("users")');
    assert.equal(tableInfoPragma('us"ers'), 'PRAGMA table_info("us""ers")');
  });
});

describe('rowsFromExecResult', () => {
  it('returns an empty list when no result has columns', () => {
    assert.deepEqual(rowsFromExecResult([]), []);
    assert.deepEqual(rowsFromExecResult([{ columns: [], values: [] }]), []);
  });

  it('flattens the first result that has columns', () => {
    const results: readonly SqliteExecResult[] = [
      { columns: [], values: [[1]] },
      { columns: ['name', 'type'], values: [['users', 'table'], ['v', 'view']] },
      { columns: ['ignored'], values: [['x']] },
    ];
    assert.deepEqual(rowsFromExecResult(results), [
      { name: 'users', type: 'table' },
      { name: 'v', type: 'view' },
    ]);
  });
});

describe('toSqliteTableInfos', () => {
  it('maps sqlite_master rows to tables and views, skipping nameless rows', () => {
    const tables = toSqliteTableInfos([
      { name: 'users', type: 'table' },
      { name: 'active', type: 'view' },
      { name: '', type: 'table' },
      {},
    ]);
    assert.deepEqual(tables, [
      { name: 'users', kind: 'table', tableType: 'TABLE' },
      { name: 'active', kind: 'view', tableType: 'VIEW' },
    ]);
  });
});

describe('isRowIdAlias', () => {
  it('detects a single INTEGER primary key', () => {
    assert.equal(
      isRowIdAlias([{ cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 }]),
      'id',
    );
  });

  it('rejects composite keys, non-integer keys and keyless tables', () => {
    assert.equal(
      isRowIdAlias([
        { cid: 0, name: 'k1', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: 'k2', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 2 },
      ]),
      undefined,
    );
    assert.equal(
      isRowIdAlias([{ cid: 0, name: 'code', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 }]),
      undefined,
    );
    assert.equal(isRowIdAlias([{ cid: 0, name: 'x', type: 'INTEGER', pk: 0 }]), undefined);
    assert.equal(isRowIdAlias([]), undefined);
  });
});

describe('toSqliteColumnInfos', () => {
  it('maps a rowid alias with its implicit not-null and auto-increment', () => {
    const columns = toSqliteColumnInfos([
      { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'title', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
    ]);
    assert.deepEqual(columns, [
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
        name: 'title',
        dataType: 'TEXT',
        nullable: false,
        isPrimaryKey: false,
        isAutoIncrement: false,
        defaultValue: "''",
        ordinal: 2,
      },
    ]);
  });

  it('maps a composite primary key without inventing auto-increment', () => {
    const columns = toSqliteColumnInfos([
      { cid: 0, name: 'k1', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: 'k2', type: 'TEXT', notnull: 0, dflt_value: null, pk: 2 },
    ]);
    assert.equal(columns[0].isPrimaryKey, true);
    assert.equal(columns[0].isAutoIncrement, false);
    assert.equal(columns[0].nullable, true);
    assert.equal(columns[1].isPrimaryKey, true);
    assert.equal(columns[1].isAutoIncrement, false);
  });

  it('does not treat a TEXT primary key as a rowid alias', () => {
    const columns = toSqliteColumnInfos([
      { cid: 0, name: 'code', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
    ]);
    assert.equal(columns[0].isPrimaryKey, true);
    assert.equal(columns[0].isAutoIncrement, false);
    assert.equal(columns[0].nullable, true);
  });

  it('fills empty types, maps defaults and ordinals, skips nameless rows', () => {
    const columns = toSqliteColumnInfos([
      { cid: 4, name: 'a', type: '', notnull: 0, dflt_value: '0', pk: 0 },
      { cid: 5, name: '', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'b', type: 'INT', notnull: 0, dflt_value: 5, pk: 0 },
    ]);
    assert.deepEqual(columns, [
      {
        name: 'a',
        dataType: 'ANY',
        nullable: true,
        isPrimaryKey: false,
        isAutoIncrement: false,
        defaultValue: '0',
        ordinal: 5,
      },
      {
        name: 'b',
        dataType: 'INT',
        nullable: true,
        isPrimaryKey: false,
        isAutoIncrement: false,
        defaultValue: '5',
        ordinal: 3,
      },
    ]);
  });
});
