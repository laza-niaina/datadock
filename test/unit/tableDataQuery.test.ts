import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTableCountSql,
  buildTableDataSql,
  type TableDataSqlOptions,
} from '../../src/db/drivers/tableDataQuery';
import type { ColumnInfo } from '../../src/db/types';

const COLUMNS: ColumnInfo[] = [
  { name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true, isAutoIncrement: true, ordinal: 1 },
  { name: 'name', dataType: 'VARCHAR(255)', nullable: false, isPrimaryKey: false, isAutoIncrement: false, ordinal: 2 },
  { name: 'note', dataType: 'TEXT', nullable: true, isPrimaryKey: false, isAutoIncrement: false, ordinal: 3 },
];

function options(request: TableDataSqlOptions['request']): TableDataSqlOptions {
  return {
    from: '`app`.`users`',
    columns: COLUMNS,
    request,
    quoteIdentifier: (name) => `\`${name.replace(/`/g, '``')}\``,
    searchExpression: (identifier) => `CAST(${identifier} AS CHAR)`,
  };
}

describe('table data SQL builder', () => {
  it('builds a parameterised page with filters, search and sorting', () => {
    const page = buildTableDataSql(
      options({
        offset: 20,
        limit: 10,
        sort: [{ column: 'name', direction: 'asc' }],
        filters: [
          { column: 'id', operator: '>=', value: 4 },
          { column: 'name', operator: 'IN', values: ['Ada', 'Bob'] },
          { column: 'note', operator: 'IS NULL' },
        ],
        search: '50%_done',
      }),
    );

    assert.match(page.sql, /SELECT `id`, `name`, `note` FROM `app`\.`users`/);
    assert.match(page.sql, /`id` >= \?/);
    assert.match(page.sql, /`name` IN \(\?, \?\)/);
    assert.match(page.sql, /`note` IS NULL/);
    assert.match(page.sql, /CAST\(`name` AS CHAR\) LIKE \? ESCAPE '!'/);
    assert.match(page.sql, /ORDER BY `name` ASC LIMIT \? OFFSET \?/);
    const escapedPattern = '%50!%!_done%';
    assert.deepEqual(page.params, [4, 'Ada', 'Bob', escapedPattern, escapedPattern, 10, 20]);
    assert.deepEqual(page.primaryKey, ['id']);
  });

  it('builds a count query with the same predicates', () => {
    const count = buildTableCountSql(
      options({ offset: 0, limit: 10, filters: [{ column: 'id', operator: '=', value: 7 }] }),
    );
    assert.equal(count.sql, 'SELECT COUNT(*) AS total FROM `app`.`users` WHERE `id` = ?');
    assert.deepEqual(count.params, [7]);
  });

  it('rejects unknown columns and invalid page values', () => {
    assert.throws(
      () => buildTableDataSql(options({ offset: 0, limit: 10, filters: [{ column: 'missing', operator: '=', value: 1 }] })),
      (error: unknown) => error instanceof Error && error.message.includes("Unknown filter column 'missing'"),
    );
    assert.throws(
      () => buildTableDataSql(options({ offset: 0, limit: 0 })),
      (error: unknown) => error instanceof Error && error.message.includes('limit must be at least 1'),
    );
  });
});

describe('table data SQL builder, PostgreSQL placeholders', () => {
  const pgOptions = (request: TableDataSqlOptions['request']): TableDataSqlOptions => ({
    from: '"app"."users"',
    columns: COLUMNS,
    request,
    quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
    placeholder: (index) => `$${index}`,
    searchExpression: (identifier) => `CAST(${identifier} AS TEXT)`,
  });

  it('uses positional $n placeholders that follow the WHERE parameters', () => {
    const page = buildTableDataSql(
      pgOptions({
        offset: 40,
        limit: 25,
        filters: [{ column: 'id', operator: '>', value: 3 }],
        sort: [{ column: 'name', direction: 'desc' }],
      }),
    );
    assert.equal(
      page.sql,
      'SELECT "id", "name", "note" FROM "app"."users" WHERE "id" > $1 ORDER BY "name" DESC LIMIT $2 OFFSET $3',
    );
    assert.deepEqual(page.params, [3, 25, 40]);
  });

  it('builds a count query with the same numbering', () => {
    const count = buildTableCountSql(pgOptions({ offset: 0, limit: 10, filters: [{ column: 'id', operator: '=', value: 7 }] }));
    assert.equal(count.sql, 'SELECT COUNT(*) AS total FROM "app"."users" WHERE "id" = $1');
    assert.deepEqual(count.params, [7]);
  });
});

describe('table data SQL builder, SQL Server placeholders and pagination', () => {
  const mssqlOptions = (request: TableDataSqlOptions['request']): TableDataSqlOptions => ({
    from: '[app].[users]',
    columns: COLUMNS,
    request,
    quoteIdentifier: (name) => `[${name.replace(/\]/g, ']]')}]`,
    placeholder: (index) => `@p${index}`,
    pagination: (limit, offset) => `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
    requireOrderBy: true,
    searchExpression: (identifier) => `CAST(${identifier} AS NVARCHAR(MAX))`,
  });

  it('uses @pN placeholders and an inline OFFSET/FETCH clause', () => {
    const page = buildTableDataSql(
      mssqlOptions({
        offset: 60,
        limit: 50,
        filters: [{ column: 'id', operator: '>=', value: 5 }],
        search: 'needle',
      }),
    );
    // OFFSET/FETCH requires an ORDER BY; with no user sort a constant is used.
    assert.equal(
      page.sql,
      'SELECT [id], [name], [note] FROM [app].[users] WHERE [id] >= @p1 AND (CAST([name] AS NVARCHAR(MAX)) LIKE @p2 ESCAPE \'!\' OR CAST([note] AS NVARCHAR(MAX)) LIKE @p3 ESCAPE \'!\') ORDER BY (SELECT NULL) OFFSET 60 ROWS FETCH NEXT 50 ROWS ONLY',
    );
    // No page parameters: offset/limit are inlined into the clause.
    assert.deepEqual(page.params, [5, '%needle%', '%needle%']);
  });

  it('keeps the user ORDER BY when sorting and still pages with OFFSET/FETCH', () => {
    const page = buildTableDataSql(
      mssqlOptions({ offset: 0, limit: 10, sort: [{ column: 'name', direction: 'asc' }] }),
    );
    assert.equal(
      page.sql,
      'SELECT [id], [name], [note] FROM [app].[users] ORDER BY [name] ASC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY',
    );
    assert.deepEqual(page.params, []);
  });
});
