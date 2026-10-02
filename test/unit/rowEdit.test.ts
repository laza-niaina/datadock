import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import {
  isBinaryColumnType,
  isBooleanColumnType,
  isIntegerColumnType,
  isNumericColumnType,
  insertIdentity,
  parseEditValue,
  primaryKeyOf,
  rowKeyOf,
} from '../../src/db/rowEdit';
import {
  buildDeleteSql,
  buildInsertSql,
  buildUpdateSql,
  DELETE_KEY_CHUNK,
  deleteKeyChunks,
  type RowEditSqlOptions,
} from '../../src/db/drivers/rowEditSql';
import type { ColumnInfo, TableDataPage } from '../../src/db/types';

function column(
  name: string,
  dataType: string,
  options: Partial<ColumnInfo> = {},
): ColumnInfo {
  return {
    name,
    dataType,
    nullable: false,
    isPrimaryKey: false,
    isForeignKey: false,
    isAutoIncrement: false,
    ordinal: 1,
    ...options,
  };
}

function options(overrides: Partial<RowEditSqlOptions> = {}): RowEditSqlOptions {
  const columns = overrides.columns ?? [
    column('id', 'int', { isPrimaryKey: true, isAutoIncrement: true }),
    column('org_id', 'int'),
    column('label', 'text', { nullable: true }),
  ];
  const quoteIdentifier = overrides.quoteIdentifier ?? ((name: string): string => `\`${name}\``);
  return {
    table: `${quoteIdentifier('app')}.${quoteIdentifier('users')}`,
    columns,
    primaryKey: columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    quoteIdentifier,
    ...overrides,
  };
}

function page(overrides: Partial<TableDataPage> = {}): TableDataPage {
  const columns = [
    column('id', 'int', { isPrimaryKey: true }),
    column('org_id', 'int'),
    column('label', 'text', { nullable: true }),
  ];
  return {
    columns,
    rows: [
      [1, 7, 'Ada'],
      [2, 7, null],
    ],
    offset: 0,
    limit: 100,
    primaryKey: ['id'],
    editable: true,
    ...overrides,
  };
}

describe('column type helpers', () => {
  it('recognises numeric, integer, boolean and binary types', () => {
    assert.equal(isNumericColumnType('int'), true);
    assert.equal(isNumericColumnType('decimal(10,2)'), true);
    assert.equal(isNumericColumnType('numeric(20,0)'), true);
    assert.equal(isNumericColumnType('varchar(255)'), false);
    // `interval` contains "int" but is a duration, never a number column.
    assert.equal(isNumericColumnType('interval'), false);

    assert.equal(isIntegerColumnType('bigint(20)'), true);
    assert.equal(isIntegerColumnType('int4'), true);
    assert.equal(isIntegerColumnType('bigserial'), true);
    assert.equal(isIntegerColumnType('double precision'), false);

    assert.equal(isBooleanColumnType('boolean'), true);
    assert.equal(isBooleanColumnType('bit'), true);
    assert.equal(isBooleanColumnType('bit(8)'), true);
    assert.equal(isBooleanColumnType('tinyint(1)'), false);

    assert.equal(isBinaryColumnType('longblob'), true);
    assert.equal(isBinaryColumnType('bytea'), true);
    assert.equal(isBinaryColumnType('varbinary(64)'), true);
    assert.equal(isBinaryColumnType('varchar(64)'), false);
  });
});

describe('parseEditValue', () => {
  const id = column('id', 'int', { isPrimaryKey: true });
  const label = column('label', 'text', { nullable: true });
  const code = column('code', 'char(3)');
  const active = column('active', 'boolean');
  const price = column('price', 'decimal(10,2)');
  const amount = column('amount', 'bigint');

  it('writes NULL only where the column accepts it', () => {
    assert.equal(parseEditValue(label, null), null);
    assert.throws(() => parseEditValue(code, null), (error: unknown) => {
      assert.ok(error instanceof DbError);
      assert.equal(error.code, 'CONFIG_ERROR');
      assert.match(error.message, /does not accept NULL/);
      return true;
    });
  });

  it('keeps a number a number', () => {
    assert.equal(parseEditValue(id, 42), 42);
    assert.equal(parseEditValue(price, 19.99), 19.99);
  });

  it('turns text into the column type and refuses the wrong shape', () => {
    assert.equal(parseEditValue(id, '42'), 42);
    assert.equal(parseEditValue(price, '19.99'), 19.99);
    assert.throws(() => parseEditValue(id, '42.5'), /not a whole number/);
    assert.throws(() => parseEditValue(id, 'seven'), /not a number/);
    assert.throws(() => parseEditValue(id, ''), /value is empty/);
    assert.throws(() => parseEditValue(id, Number.NaN), /not finite/);
  });

  it('keeps an unsafe integer as text so no digit is lost', () => {
    const huge = '9007199254740993';
    assert.equal(Number.isSafeInteger(Number(huge)), false);
    const parsed = parseEditValue(amount, huge);
    assert.equal(parsed, huge);
    // A safe integer still becomes a number.
    assert.equal(parseEditValue(amount, '7'), 7);
  });

  it('reads boolean spellings and rejects anything else', () => {
    assert.equal(parseEditValue(active, 'true'), true);
    assert.equal(parseEditValue(active, 'FALSE'), false);
    assert.equal(parseEditValue(active, '1'), true);
    assert.equal(parseEditValue(active, '0'), false);
    assert.throws(() => parseEditValue(active, 'maybe'), /not a boolean/);
  });

  it('leaves text alone', () => {
    assert.equal(parseEditValue(label, '  padded  '), '  padded  ');
    assert.equal(parseEditValue(code, 'FR'), 'FR');
  });
});

describe('rowKeyOf', () => {
  it('picks the primary key values of the row', () => {
    assert.deepEqual(rowKeyOf(page(), 1), { id: 2 });
    const composite = page({ primaryKey: ['id', 'org_id'] });
    assert.deepEqual(rowKeyOf(composite, 0), { id: 1, org_id: 7 });
  });

  it('refuses a relation without a primary key', () => {
    assert.throws(() => rowKeyOf(page({ primaryKey: [] }), 0), /no primary key/);
  });

  it('refuses a row that is not on the page', () => {
    assert.throws(() => rowKeyOf(page(), 9), /no longer on this page/);
  });

  it('refuses a primary key column the page does not carry', () => {
    assert.throws(() => rowKeyOf(page({ primaryKey: ['missing'] }), 0), /missing from the page/);
  });
});

describe('buildUpdateSql', () => {
  it('binds the SET values first, then the identity', () => {
    const built = buildUpdateSql(options(), {
      key: { id: 1 },
      values: { label: 'Grace', org_id: 9 },
    });
    assert.equal(built.sql, 'UPDATE `app`.`users` SET `label` = ?, `org_id` = ? WHERE `id` = ?');
    assert.deepEqual(built.params, ['Grace', 9, 1]);
  });

  it('numbers placeholders for PostgreSQL and SQL Server', () => {
    const pg = buildUpdateSql(options({ placeholder: (index) => `$${index}` }), {
      key: { id: 1 },
      values: { label: 'x' },
    });
    assert.equal(pg.sql, 'UPDATE `app`.`users` SET `label` = $1 WHERE `id` = $2');

    const mssql = buildUpdateSql(
      options({ quoteIdentifier: (name) => `[${name}]`, placeholder: (index) => `@p${index}` }),
      { key: { id: 1 }, values: { label: 'x' } },
    );
    assert.equal(mssql.sql, 'UPDATE [app].[users] SET [label] = @p1 WHERE [id] = @p2');
  });

  it('writes NULL literally instead of binding it', () => {
    const built = buildUpdateSql(options(), { key: { id: 1 }, values: { label: null } });
    assert.equal(built.sql, 'UPDATE `app`.`users` SET `label` = NULL WHERE `id` = ?');
    assert.deepEqual(built.params, [1]);
  });

  it('refuses an unknown column, an empty change and a partial key', () => {
    assert.throws(
      () => buildUpdateSql(options(), { key: { id: 1 }, values: { nope: 1 } }),
      /does not exist in this relation/,
    );
    assert.throws(
      () => buildUpdateSql(options(), { key: { id: 1 }, values: {} }),
      /no column to update/,
    );
    assert.throws(
      () => buildUpdateSql(options({ primaryKey: ['id', 'org_id'] }), { key: { id: 1 }, values: { label: 'x' } }),
      /missing the primary key column 'org_id'/,
    );
    assert.throws(
      () => buildUpdateSql(options({ primaryKey: [] }), { key: {}, values: { label: 'x' } }),
      /no primary key/,
    );
  });
});

describe('buildInsertSql', () => {
  it('lists columns and placeholders in the same order', () => {
    const built = buildInsertSql(options(), { org_id: 7, label: 'Ada', id: null });
    assert.equal(built.sql, 'INSERT INTO `app`.`users` (`org_id`, `label`, `id`) VALUES (?, ?, NULL)');
    assert.deepEqual(built.params, [7, 'Ada']);
  });

  it('emits the dialect default-values clause', () => {
    assert.equal(
      buildInsertSql(options(), {}).sql,
      'INSERT INTO `app`.`users` DEFAULT VALUES',
    );
    assert.equal(
      buildInsertSql(options({ defaultValues: 'empty-columns' }), {}).sql,
      'INSERT INTO `app`.`users` () VALUES ()',
    );
  });

  it('appends the identity clause of the dialect', () => {
    const pg = buildInsertSql(
      options({
        placeholder: (index) => `$${index}`,
        insertReturning: (key) => `RETURNING ${key.join(', ')}`,
      }),
      { label: 'Ada' },
    );
    assert.equal(
      pg.sql,
      'INSERT INTO `app`.`users` (`label`) VALUES ($1) RETURNING `id`',
    );

    const mssql = buildInsertSql(
      options({ insertOutput: (key) => `OUTPUT ${key.map((k) => `INSERTED.${k}`).join(', ')}` }),
      { label: 'Ada' },
    );
    assert.equal(
      mssql.sql,
      'INSERT INTO `app`.`users` (`label`) OUTPUT INSERTED.`id` VALUES (?)',
    );
  });

  it('refuses an unknown column', () => {
    assert.throws(
      () => buildInsertSql(options(), { ghost: 1 }),
      /does not exist in this relation/,
    );
  });
});

describe('buildDeleteSql', () => {
  it('joins identity groups with OR', () => {
    const built = buildDeleteSql(options(), [{ id: 1 }, { id: 2 }]);
    assert.equal(built.sql, 'DELETE FROM `app`.`users` WHERE (`id` = ?) OR (`id` = ?)');
    assert.deepEqual(built.params, [1, 2]);
  });

  it('handles a composite key and a NULL identity value', () => {
    const opts = options({
      columns: [
        column('a', 'int', { isPrimaryKey: true }),
        column('b', 'int', { isPrimaryKey: true, nullable: true }),
      ],
      primaryKey: ['a', 'b'],
    });
    const built = buildDeleteSql(opts, [{ a: 1, b: null }]);
    assert.equal(built.sql, 'DELETE FROM `app`.`users` WHERE (`a` = ? AND `b` IS NULL)');
    assert.deepEqual(built.params, [1]);
  });

  it('refuses an empty batch and an incomplete identity', () => {
    assert.throws(() => buildDeleteSql(options(), []), /no row to delete/);
    assert.throws(() => buildDeleteSql(options(), [{}]), /missing the primary key column 'id'/);
  });

  it('chunks large batches at a fixed size', () => {
    assert.equal(typeof DELETE_KEY_CHUNK, 'number');
    assert.ok(DELETE_KEY_CHUNK > 0 && DELETE_KEY_CHUNK <= 1000);
  });
});

describe('primaryKeyOf', () => {
  it('keeps the schema order and drops every other column', () => {
    const columns = [
      column('org_id', 'int', { isPrimaryKey: true, ordinal: 1 }),
      column('label', 'text', { nullable: true, ordinal: 2 }),
      column('id', 'bigint', { isPrimaryKey: true, isAutoIncrement: true, ordinal: 3 }),
    ];
    assert.deepEqual(primaryKeyOf(columns), ['org_id', 'id']);
  });

  it('is empty for a relation with no key', () => {
    assert.deepEqual(primaryKeyOf([column('label', 'text')]), []);
  });
});

describe('insertIdentity', () => {
  const generated = [
    column('id', 'bigint', { isPrimaryKey: true, isAutoIncrement: true }),
    column('label', 'text', { nullable: true }),
  ];

  it('reports the single auto-increment column it can know', () => {
    assert.deepEqual(insertIdentity(generated, 42), { id: 42 });
  });

  it('reports nothing when there is no usable identity', () => {
    assert.deepEqual(insertIdentity(generated, 0), {});
    assert.deepEqual(insertIdentity(generated, Number.NaN), {});
    assert.deepEqual(insertIdentity(generated, undefined), {});
    assert.deepEqual(insertIdentity([column('label', 'text')], 42), {});
    assert.deepEqual(
      insertIdentity(
        [
          column('a', 'bigint', { isAutoIncrement: true }),
          column('b', 'bigint', { isAutoIncrement: true }),
        ],
        42,
      ),
      {},
    );
  });
});

describe('deleteKeyChunks', () => {
  it('splits a batch at the limit and keeps the key order', () => {
    const keys = Array.from({ length: DELETE_KEY_CHUNK + 3 }, (_, index) => ({ id: index }));
    const chunks = deleteKeyChunks(keys);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, DELETE_KEY_CHUNK);
    assert.equal(chunks[1].length, 3);
    assert.deepEqual(chunks[1][0], { id: DELETE_KEY_CHUNK });
    assert.deepEqual(chunks.flat(), keys);
  });

  it('is empty for an empty batch and never splits what already fits', () => {
    assert.deepEqual(deleteKeyChunks([]), []);
    const single = [{ id: 1 }];
    assert.deepEqual(deleteKeyChunks(single), [single]);
  });
});
