import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MYSQL_SQL,
  filterSystemSchemas,
  isAutoIncrementColumn,
  mysqlScope,
  toBool,
  toColumnInfos,
  toDatabaseNames,
  toRoutineInfos,
  toTableInfos,
} from '../../src/db/drivers/mysql/mysqlCatalog';
import { DbError } from '../../src/db/errors';

describe('mysqlScope', () => {
  it('prefers the schema over the database', () => {
    assert.equal(mysqlScope({ connectionId: 'c', database: 'db', schema: 'schema' }), 'schema');
  });

  it('falls back to the database (a MySQL schema IS a database)', () => {
    assert.equal(mysqlScope({ connectionId: 'c', database: 'app' }), 'app');
  });

  it('throws CONFIG_ERROR when neither is set', () => {
    assert.throws(
      () => mysqlScope({ connectionId: 'c', database: '  ' }),
      (error: unknown) => error instanceof DbError && error.code === 'CONFIG_ERROR',
    );
  });
});

describe('toBool', () => {
  it('accepts every shape mysql2 can hand over', () => {
    assert.equal(toBool(1), true);
    assert.equal(toBool('1'), true);
    assert.equal(toBool(' 1 '), true);
    assert.equal(toBool(true), true);
    assert.equal(toBool(0), false);
    assert.equal(toBool('0'), false);
    assert.equal(toBool(null), false);
    assert.equal(toBool(undefined), false);
  });
});

describe('toDatabaseNames / filterSystemSchemas', () => {
  it('trims and skips blank names', () => {
    assert.deepEqual(
      toDatabaseNames([{ schemaName: ' app ' }, { schemaName: '' }, {}, { schemaName: 'sys' }]),
      ['app', 'sys'],
    );
  });

  it('drops system schemas but keeps a requested one', () => {
    const names = ['app', 'information_schema', 'performance_schema', 'sys', 'mysql'];
    assert.deepEqual(filterSystemSchemas(names), ['app', 'mysql']);
    assert.deepEqual(filterSystemSchemas(names, 'sys'), ['app', 'sys', 'mysql']);
  });
});

describe('toTableInfos', () => {
  it('maps base tables with their engine as the table type', () => {
    const tables = toTableInfos([
      { tableName: 'users', tableType: 'BASE TABLE', engine: 'InnoDB', comment: 'People' },
      { tableName: 'logs', tableType: 'BASE TABLE', engine: 'MEMORY' },
    ]);
    assert.deepEqual(tables, [
      { name: 'users', kind: 'table', tableType: 'InnoDB', comment: 'People' },
      { name: 'logs', kind: 'table', tableType: 'MEMORY', comment: undefined },
    ]);
  });

  it('maps views and system views by TABLE_TYPE', () => {
    const tables = toTableInfos([
      { tableName: 'v', tableType: 'VIEW' },
      { tableName: 'sv', tableType: 'SYSTEM VIEW' },
      { tableName: 'seq', tableType: 'SEQUENCE', engine: 'MyISAM' },
    ]);
    assert.equal(tables[0].kind, 'view');
    assert.equal(tables[0].tableType, 'VIEW');
    assert.equal(tables[1].kind, 'view');
    assert.equal(tables[2].kind, 'table');
    assert.equal(tables[2].tableType, 'MyISAM');
  });
});

describe('isAutoIncrementColumn / toColumnInfos', () => {
  it('detects auto_increment only as a word inside EXTRA', () => {
    assert.equal(isAutoIncrementColumn('auto_increment'), true);
    assert.equal(isAutoIncrementColumn('DEFAULT_GENERATED auto_increment'), true);
    assert.equal(isAutoIncrementColumn('DEFAULT_GENERATED on update CURRENT_TIMESTAMP'), false);
    assert.equal(isAutoIncrementColumn('VIRTUAL GENERATED'), false);
    assert.equal(isAutoIncrementColumn(null), false);
    assert.equal(isAutoIncrementColumn(undefined), false);
  });

  it('maps a full column row', () => {
    const columns = toColumnInfos([
      {
        columnName: ' id ',
        columnType: 'bigint(20) unsigned',
        dataType: 'bigint',
        isNullable: 'NO',
        isPrimaryKey: 1,
        columnDefault: null,
        comment: 'identifier',
        ordinal: '3',
        extra: 'auto_increment',
      },
      {
        columnName: 'name',
        columnType: 'varchar(255)',
        dataType: 'varchar',
        isNullable: 'YES',
        isPrimaryKey: 0,
        columnDefault: 'unknown',
        comment: '',
        ordinal: 1,
        extra: '',
      },
    ]);
    assert.deepEqual(columns[0], {
      name: 'id',
      dataType: 'bigint(20) unsigned',
      nullable: false,
      isPrimaryKey: true,
      isAutoIncrement: true,
      defaultValue: null,
      comment: 'identifier',
      ordinal: 3,
    });
    assert.deepEqual(columns[1], {
      name: 'name',
      dataType: 'varchar(255)',
      nullable: true,
      isPrimaryKey: false,
      isAutoIncrement: false,
      defaultValue: 'unknown',
      comment: undefined,
      ordinal: 1,
    });
  });

  it('falls back to DATA_TYPE and to the row index for a missing ordinal', () => {
    const columns = toColumnInfos([{ columnName: 'a', dataType: 'int', isNullable: 1, isPrimaryKey: '0' }]);
    assert.equal(columns[0].dataType, 'int');
    assert.equal(columns[0].ordinal, 1);
    assert.equal(columns[0].nullable, true);
  });

  it('skips rows without a name', () => {
    assert.equal(toColumnInfos([{}, { columnName: 'a', dataType: 'int' }]).length, 1);
  });
});

describe('toRoutineInfos', () => {
  it('splits procedures from functions and keeps the raw type', () => {
    const routines = toRoutineInfos([
      { routineName: 'do_it', routineType: 'PROCEDURE' },
      { routineName: 'calc', routineType: 'FUNCTION' },
      { routineName: 'weird', routineType: 'AGGREGATE' },
      {},
    ]);
    assert.deepEqual(routines, [
      { name: 'do_it', kind: 'procedure', routineType: 'PROCEDURE' },
      { name: 'calc', kind: 'function', routineType: 'FUNCTION' },
      { name: 'weird', kind: 'function', routineType: 'AGGREGATE' },
    ]);
  });
});

describe('MYSQL_SQL contract', () => {
  it('declares the documented parameter counts', () => {
    const placeholders = (sql: string): number => (sql.match(/\?/g) ?? []).length;
    assert.equal(placeholders(MYSQL_SQL.databases), 0);
    assert.equal(placeholders(MYSQL_SQL.tables), 1);
    assert.equal(placeholders(MYSQL_SQL.columns), 2);
    assert.equal(placeholders(MYSQL_SQL.routines), 1);
  });

  it('queries the information_schema views the mappers expect', () => {
    assert.match(MYSQL_SQL.databases, /information_schema\.SCHEMATA/);
    assert.match(MYSQL_SQL.tables, /information_schema\.TABLES/);
    assert.match(MYSQL_SQL.columns, /information_schema\.COLUMNS/);
    assert.match(MYSQL_SQL.columns, /KEY_COLUMN_USAGE/);
    assert.match(MYSQL_SQL.columns, /CONSTRAINT_NAME = 'PRIMARY'/);
    assert.match(MYSQL_SQL.routines, /information_schema\.ROUTINES/);
  });
});
