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
