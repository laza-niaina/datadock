import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MSSQL_SQL,
  filterSystemDatabases,
  filterSystemSchemas,
  mssqlDataType,
  mssqlScope,
  quoteMssqlIdentifier,
  toBool,
  toColumnInfos,
  toDatabaseNames,
  toRoutineInfos,
  toTableInfos,
} from '../../src/db/drivers/mssql/mssqlCatalog';
import { DbError } from '../../src/db/errors';

describe('mssqlScope', () => {
  it('prefers the schema over the database', () => {
    assert.equal(mssqlScope({ connectionId: 'c', database: 'db', schema: 'dbo' }), 'dbo');
  });

  it('falls back to the database', () => {
    assert.equal(mssqlScope({ connectionId: 'c', database: 'app' }), 'app');
  });

  it('throws CONFIG_ERROR when neither is set', () => {
    assert.throws(
      () => mssqlScope({ connectionId: 'c', database: '  ' }),
      (error: unknown) => error instanceof DbError && error.code === 'CONFIG_ERROR',
    );
  });
});

describe('toBool', () => {
  it('accepts every shape INFORMATION_SCHEMA can hand over', () => {
    assert.equal(toBool(1), true);
    assert.equal(toBool('1'), true);
    assert.equal(toBool(true), true);
    assert.equal(toBool('Y'), true);
    assert.equal(toBool('y'), true);
    assert.equal(toBool(0), false);
    assert.equal(toBool('0'), false);
    assert.equal(toBool(false), false);
    assert.equal(toBool('N'), false);
    assert.equal(toBool(null), false);
    assert.equal(toBool(undefined), false);
  });
});

describe('toDatabaseNames / filterSystemDatabases / filterSystemSchemas', () => {
  it('trims and skips blank names', () => {
    assert.deepEqual(
      toDatabaseNames([{ schemaName: ' app ' }, { schemaName: '' }, {}, { schemaName: 'Warehouse' }]),
      ['app', 'Warehouse'],
    );
  });

  it('drops system databases but keeps a configured one', () => {
    assert.deepEqual(
      filterSystemDatabases(['app', 'master', 'tempdb', 'model', 'msdb']),
      ['app'],
    );
    assert.deepEqual(filterSystemDatabases(['app', 'master'], 'master'), ['app', 'master']);
  });

  it('drops built-in schemas and fixed db roles while keeping dbo', () => {
    assert.deepEqual(
      filterSystemSchemas(['dbo', 'sys', 'INFORMATION_SCHEMA', 'guest', 'db_owner', 'analytics']),
      ['dbo', 'analytics'],
    );
  });
});

describe('toTableInfos', () => {
  it('maps INFORMATION_SCHEMA rows to shared table info', () => {
    assert.deepEqual(
      toTableInfos([
        { tableName: 'users', tableType: 'BASE TABLE' },
        { tableName: 'v_active', tableType: 'VIEW' },
      ]),
      [
        { name: 'users', kind: 'table', tableType: 'BASE TABLE', comment: undefined },
        { name: 'v_active', kind: 'view', tableType: 'VIEW', comment: undefined },
      ],
    );
  });
});

describe('mssqlDataType', () => {
  it('reconstructs displayable types from the split INFORMATION_SCHEMA columns', () => {
    assert.equal(mssqlDataType({ dataType: 'varchar', charLength: 50 }), 'varchar(50)');
    assert.equal(mssqlDataType({ dataType: 'nvarchar', charLength: -1 }), 'nvarchar(max)');
    assert.equal(mssqlDataType({ dataType: 'decimal', numPrecision: 18, numScale: 2 }), 'decimal(18,2)');
    assert.equal(mssqlDataType({ dataType: 'int' }), 'int');
    assert.equal(mssqlDataType({ dataType: '' }), '');
    assert.equal(mssqlDataType({}), '');
  });
});

describe('toColumnInfos', () => {
  it('maps rows including identity and primary key flags', () => {
    const columns = toColumnInfos([
      {
        columnName: 'id',
        dataType: 'int',
        isNullable: 'NO',
        columnDefault: null,
        ordinal: 1,
        isIdentity: '1',
        isPrimaryKey: 1,
      },
      {
        columnName: 'note',
        dataType: 'nvarchar',
        charLength: -1,
        isNullable: 'YES',
        columnDefault: 'N\'x\'',
        ordinal: 2,
        isIdentity: '0',
        isPrimaryKey: 0,
      },
    ]);

    assert.deepEqual(columns, [
      {
        name: 'id',
        dataType: 'int',
        nullable: false,
        isPrimaryKey: true,
        isAutoIncrement: true,
        defaultValue: null,
        ordinal: 1,
      },
      {
        name: 'note',
        dataType: 'nvarchar(max)',
        nullable: true,
        isPrimaryKey: false,
        isAutoIncrement: false,
        defaultValue: 'N\'x\'',
        ordinal: 2,
      },
    ]);
  });

  it('falls back to the array position when the ordinal is missing', () => {
    const [only] = toColumnInfos([{ columnName: 'x', dataType: 'int', isNullable: 'YES', isPrimaryKey: 0, isIdentity: '0' }]);
    assert.equal(only.ordinal, 1);
  });
});

describe('toRoutineInfos', () => {
  it('maps procedures and functions', () => {
    assert.deepEqual(
      toRoutineInfos([
        { routineName: 'sp_refresh', routineType: 'PROCEDURE' },
        { routineName: 'fn_total', routineType: 'FUNCTION' },
      ]),
      [
        { name: 'sp_refresh', kind: 'procedure', routineType: 'PROCEDURE' },
        { name: 'fn_total', kind: 'function', routineType: 'FUNCTION' },
      ],
    );
  });
});

describe('quoteMssqlIdentifier', () => {
  it('brackets and doubles embedded closing brackets', () => {
    assert.equal(quoteMssqlIdentifier('users'), '[users]');
    assert.equal(quoteMssqlIdentifier('we]ird'), '[we]]ird]');
  });
});

describe('MSSQL_SQL statements', () => {
  it('keeps parameter counts in sync with the driver call sites', () => {
    // `@pN` may repeat inside a batch (each statement re-binds it), so count
    // distinct placeholders: that is the number of `.input()` bindings.
    const distinctParams = (sql: string): number => new Set(sql.match(/@p(\d+)/g) ?? []).size;
    assert.equal(distinctParams(MSSQL_SQL.databases), 0);
    assert.equal(distinctParams(MSSQL_SQL.schemas), 0);
    assert.equal(distinctParams(MSSQL_SQL.tables), 1);
    // Regression guard: the columns query binds exactly schema + table. Adding
    // a third parameter here throws at runtime, not at test time.
    assert.equal(distinctParams(MSSQL_SQL.columns), 2);
    assert.equal(distinctParams(MSSQL_SQL.routines), 1);
  });

  it('filters system databases and fixed roles outside the query', () => {
    assert.doesNotMatch(MSSQL_SQL.databases, /master|tempdb|model|msdb/i);
    assert.match(MSSQL_SQL.schemas, /s\.name NOT LIKE 'db_%'/);
    assert.match(MSSQL_SQL.tables, /INFORMATION_SCHEMA\.TABLES/);
  });
});