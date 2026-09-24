import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PG_SQL,
  filterSystemDatabases,
  filterSystemSchemas,
  postgresScope,
  quotePostgresIdentifier,
  toBool,
  toColumnInfos,
  toDatabaseNames,
  toRoutineInfos,
  toTableInfos,
} from '../../src/db/drivers/postgresql/postgresqlCatalog';
import { DbError } from '../../src/db/errors';

describe('postgresScope', () => {
  it('prefers the schema over the database', () => {
    assert.equal(postgresScope({ connectionId: 'c', database: 'db', schema: 'public' }), 'public');
  });

  it('falls back to the database (browsing while disconnected to a schema)', () => {
    assert.equal(postgresScope({ connectionId: 'c', database: 'app' }), 'app');
  });

  it('throws CONFIG_ERROR when neither is set', () => {
    assert.throws(
      () => postgresScope({ connectionId: 'c', database: '  ' }),
      (error: unknown) => error instanceof DbError && error.code === 'CONFIG_ERROR',
    );
  });
});

describe('toBool', () => {
  it('accepts every shape pg can hand over', () => {
    assert.equal(toBool(1), true);
    assert.equal(toBool('1'), true);
    assert.equal(toBool(true), true);
    assert.equal(toBool('t'), true);
    assert.equal(toBool('true'), true);
    assert.equal(toBool(0), false);
    assert.equal(toBool('0'), false);
    assert.equal(toBool(false), false);
    assert.equal(toBool('f'), false);
    assert.equal(toBool(null), false);
    assert.equal(toBool(undefined), false);
  });
});

describe('toDatabaseNames / filterSystemDatabases / filterSystemSchemas', () => {
  it('trims and skips blank names', () => {
    assert.deepEqual(
      toDatabaseNames([{ schemaName: ' app ' }, { schemaName: '' }, {}, { schemaName: 'analytics' }]),
      ['app', 'analytics'],
    );
  });

  it('drops template and maintenance databases but keeps a configured one', () => {
    assert.deepEqual(
      filterSystemDatabases(['app', 'template0', 'template1', 'postgres']),
      ['app'],
    );
    assert.deepEqual(
      filterSystemDatabases(['app', 'template1'], 'template1'),
      ['app', 'template1'],
    );
  });

  it('drops built-in schemas while keeping public', () => {
    assert.deepEqual(
      filterSystemSchemas(['public', 'pg_catalog', 'information_schema', 'analytics']),
      ['public', 'analytics'],
    );
  });
});

describe('toTableInfos', () => {
  it('maps materialized views and views to view kind', () => {
    assert.deepEqual(
      toTableInfos([
        { tableName: 'users', tableType: 'BASE TABLE' },
        { tableName: 'v_active', tableType: 'VIEW' },
        { tableName: 'm_summary', tableType: 'VIEW' },
      ]),
      [
        { name: 'users', kind: 'table', tableType: 'BASE TABLE', comment: undefined },
        { name: 'v_active', kind: 'view', tableType: 'VIEW', comment: undefined },
        { name: 'm_summary', kind: 'view', tableType: 'VIEW', comment: undefined },
      ],
    );
  });

  it('carries a comment when the driver fetched one', () => {
    assert.deepEqual(toTableInfos([{ tableName: 'users', tableType: 'BASE TABLE', comment: 'Audience' }]), [
      { name: 'users', kind: 'table', tableType: 'BASE TABLE', comment: 'Audience' },
    ]);
  });
});

describe('toColumnInfos', () => {
  it('maps pg rows to the shared shape', () => {
    const columns = toColumnInfos([
      {
        columnName: 'id',
        dataType: 'bigint',
        isNullable: 'NO',
        columnDefault: 'nextval(\'users_id_seq\'::regclass)',
        ordinal: 1,
        isIdentity: '',
        isPrimaryKey: 1,
      },
      {
        columnName: 'email',
        dataType: 'character varying',
        isNullable: 'YES',
        columnDefault: '',
        ordinal: 2,
        isIdentity: 'YES',
        isPrimaryKey: 0,
      },
    ]);

    assert.deepEqual(columns, [
      {
        name: 'id',
        dataType: 'bigint',
        nullable: false,
        isPrimaryKey: true,
        isAutoIncrement: true, // nextval() default
        defaultValue: 'nextval(\'users_id_seq\'::regclass)',
        ordinal: 1,
      },
      {
        name: 'email',
        dataType: 'character varying',
        nullable: true,
        isPrimaryKey: false,
        isAutoIncrement: true, // identity column
        defaultValue: null,
        ordinal: 2,
      },
    ]);
  });

  it('falls back to the array position when the ordinal is missing', () => {
    const [only] = toColumnInfos([{ columnName: 'x', dataType: 'int4', isNullable: 'YES', isPrimaryKey: 0, isIdentity: '' }]);
    assert.equal(only.ordinal, 1);
  });
});

describe('toRoutineInfos', () => {
  it('maps procedures and functions', () => {
    assert.deepEqual(
      toRoutineInfos([
        { routineName: 'refresh_all', routineType: 'PROCEDURE' },
        { routineName: 'total_users', routineType: 'FUNCTION' },
      ]),
      [
        { name: 'refresh_all', kind: 'procedure', routineType: 'PROCEDURE' },
        { name: 'total_users', kind: 'function', routineType: 'FUNCTION' },
      ],
    );
  });
});

describe('quotePostgresIdentifier', () => {
  it('double-quotes and doubles embedded quotes', () => {
    assert.equal(quotePostgresIdentifier('users'), '"users"');
    assert.equal(quotePostgresIdentifier('we"ird'), '"we""ird"');
  });
});

describe('PG_SQL statements', () => {
  it('keeps parameter counts in sync with the driver call sites', () => {
    assert.equal(PG_SQL.databases.match(/\$\d+/g)?.length ?? 0, 0);
    assert.equal(PG_SQL.schemas.match(/\$\d+/g)?.length ?? 0, 0);
    assert.equal(PG_SQL.tables.match(/\$\d+/g)?.length ?? 0, 1);
    assert.equal(PG_SQL.columns.match(/\$\d+/g)?.length ?? 0, 2);
    assert.equal(PG_SQL.routines.match(/\$\d+/g)?.length ?? 0, 1);
  });

  it('filters template databases and pg_% namespaces at the source and in the mapper', () => {
    assert.match(PG_SQL.databases, /datallowconn/);
    assert.doesNotMatch(PG_SQL.databases, /template/i);
    assert.match(PG_SQL.schemas, /NOT LIKE 'pg_%'/);
    assert.match(PG_SQL.tables, /relkind IN \('r', 'p', 'v', 'm', 'f'\)/);
  });
});