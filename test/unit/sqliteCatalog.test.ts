import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SQLITE_SQL,
  foreignKeyColumns,
  foreignKeyPragma,
  foreignKeysByTable,
  isRowIdAlias,
  quoteSqliteIdentifier,
  rowsFromExecResult,
  tableInfoPragma,
  toSqliteColumnInfos,
  toSqliteForeignKeyInfos,
  toSqliteRelationColumns,
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
    // The foreign-key pragma shares table_info's constraint: SQLite refuses a
    // bound parameter here, so the identifier is escaped and interpolated.
    assert.equal(foreignKeyPragma('users'), 'PRAGMA foreign_key_list("users")');
    assert.equal(foreignKeyPragma('us"ers'), 'PRAGMA foreign_key_list("us""ers")');
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
        isForeignKey: false,
        isAutoIncrement: true,
        defaultValue: undefined,
        ordinal: 1,
      },
      {
        name: 'title',
        dataType: 'TEXT',
        nullable: false,
        isPrimaryKey: false,
        isForeignKey: false,
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
        isForeignKey: false,
        isAutoIncrement: false,
        defaultValue: '0',
        ordinal: 5,
      },
      {
        name: 'b',
        dataType: 'INT',
        nullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
        isAutoIncrement: false,
        defaultValue: '5',
        ordinal: 3,
      },
    ]);
  });

  it('marks only the local columns named by PRAGMA foreign_key_list', () => {
    // One constraint produces one row per `(id, seq)`: a composite key lists
    // the same column twice, and the referenced (remote) side is named in `to`.
    const foreignKeys = foreignKeyColumns([
      { id: 1, seq: 0, table: 'customers', from: 'customer_id', to: 'id' },
      { id: 2, seq: 0, table: 'orgs', from: 'org_id', to: 'id' },
      { id: 2, seq: 1, table: 'orgs', from: 'owner_id', to: 'id' },
      { id: 3, seq: 0, table: 'audit', from: 'audited_id', to: null },
      { id: 4, seq: 0, table: 'bad', from: '', to: 'id' },
    ]);
    assert.deepEqual([...foreignKeys].sort(), ['audited_id', 'customer_id', 'org_id', 'owner_id']);

    const columns = toSqliteColumnInfos(
      [
        { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: 'customer_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
        { cid: 2, name: 'label', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      ],
      foreignKeys,
    );
    assert.deepEqual(
      columns.map((column) => [column.name, column.isPrimaryKey, column.isForeignKey]),
      [
        ['id', true, false],
        ['customer_id', false, true],
        ['label', false, false],
      ],
    );
  });
});

describe('SQLITE_SQL ER diagram statements', () => {
  it('are parameter-free catalog-wide passes, never one PRAGMA per table', () => {
    assert.equal(/\?/.test(SQLITE_SQL.foreignKeys), false);
    assert.equal(/\?/.test(SQLITE_SQL.schemaColumns), false);
    assert.match(SQLITE_SQL.foreignKeys, /pragma_foreign_key_list\(m\.name\)/);
    assert.match(SQLITE_SQL.schemaColumns, /pragma_table_info\(m\.name\)/);
    assert.doesNotMatch(SQLITE_SQL.schemaColumns, /foreign_key_list/);
    assert.match(SQLITE_SQL.foreignKeys, /m\.name NOT LIKE 'sqlite_%'/);
  });
});

describe('toSqliteForeignKeyInfos / foreignKeysByTable / toSqliteRelationColumns', () => {
  const fkRows = [
    { sourceTable: 'order_items', sourceColumn: 'order_id', targetTable: 'orders', targetColumn: null, constraintId: 0, seq: 0 },
    { sourceTable: 'order_items', sourceColumn: 'product_id', targetTable: 'products', targetColumn: null, constraintId: 1, seq: 0 },
    { sourceTable: 'orders', sourceColumn: 'user_id', targetTable: 'users', targetColumn: null, constraintId: 0, seq: 0 },
    { sourceTable: 'orders', sourceColumn: '' },
    { targetTable: 'orders' },
  ];

  it('maps both ends and keeps a NULL referenced column undefined', () => {
    const keys = toSqliteForeignKeyInfos(fkRows);
    assert.deepEqual(keys, [
      { sourceTable: 'order_items', sourceColumn: 'order_id', targetTable: 'orders', targetColumn: undefined, ordinal: 1 },
      { sourceTable: 'order_items', sourceColumn: 'product_id', targetTable: 'products', targetColumn: undefined, ordinal: 1 },
      { sourceTable: 'orders', sourceColumn: 'user_id', targetTable: 'users', targetColumn: undefined, ordinal: 1 },
    ]);
  });

  it('numbers composite siblings by seq', () => {
    const keys = toSqliteForeignKeyInfos([
      { sourceTable: 't', sourceColumn: 'a', targetTable: 'p', targetColumn: 'x', seq: 0 },
      { sourceTable: 't', sourceColumn: 'b', targetTable: 'p', targetColumn: 'y', seq: 1 },
    ]);
    assert.deepEqual(keys.map((key) => [key.sourceColumn, key.ordinal]), [
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('indexes foreign keys by referencing table', () => {
    const index = foreignKeysByTable(fkRows);
    assert.deepEqual([...index.keys()].sort(), ['order_items', 'orders']);
    assert.deepEqual([...(index.get('order_items') ?? [])].sort(), ['order_id', 'product_id']);
  });

  it('groups schema-wide column rows per relation and applies the FK index', () => {
    const relations = toSqliteRelationColumns(
      [
        { tableName: 'order_items', cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
        { tableName: 'order_items', cid: 1, name: 'order_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
        { tableName: 'order_items', cid: 2, name: 'product_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
        { tableName: 'users', cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
        { tableName: 'v_users' },
      ],
      foreignKeysByTable(fkRows),
    );
    assert.deepEqual(relations.map((relation) => relation.table), ['order_items', 'users', 'v_users']);
    assert.deepEqual(
      relations[0].columns.map((column) => [column.name, column.isPrimaryKey, column.isForeignKey]),
      [
        ['id', true, false],
        ['order_id', false, true],
        ['product_id', false, true],
      ],
    );
    assert.equal(relations[1].columns.length, 1);
  });
});
