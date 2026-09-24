import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyGridFilters,
  applyGridSearch,
  compareGridCells,
  exportFileName,
  gridToCsv,
  gridToJson,
  gridToMarkdown,
  gridToSqlInserts,
  matchesGridFilter,
  renderGridExport,
  serializeGridValue,
  sortGridRows,
  sqlIdentifier,
  sqlStringLiteral,
  type GridColumn,
} from '../../src/ui/dataGrid/dataGridModel';

const columns: GridColumn[] = [
  { name: 'id', type: 'int' },
  { name: 'name', type: 'varchar(255)' },
  { name: 'note', type: 'text' },
];

const rows: (string | number | null)[][] = [
  [3, 'alpha', null],
  [111, 'beta', 'x=1,y=2'],
  [12, 'Alpha', 'has "quotes", and, commas\nand newline'],
  [null, 'delta', 'plain'],
];

describe('serializeGridValue', () => {
  it('passes primitives and nulls through', () => {
    assert.equal(serializeGridValue(7), 7);
    assert.equal(serializeGridValue('a'), 'a');
    assert.equal(serializeGridValue(null), null);
    assert.equal(serializeGridValue(undefined), null);
  });

  it('stringifies bigints, booleans, dates, binary and objects', () => {
    assert.equal(serializeGridValue(9007199254740993n), '9007199254740993');
    assert.equal(serializeGridValue(true), 1);
    assert.equal(serializeGridValue(false), 0);
    const date = new Date('2024-01-02T03:04:05.000Z');
    assert.equal(serializeGridValue(date), '2024-01-02T03:04:05.000Z');
    const bytes = new Uint8Array([1, 2, 3]);
    assert.equal(serializeGridValue(bytes), '<binary 3 bytes>');
    assert.equal(serializeGridValue({ a: 1 }), '{"a":1}');
    assert.equal(serializeGridValue(NaN), 'NaN');
  });
});

describe('matchesGridFilter', () => {
  it('handles null operators', () => {
    assert.equal(matchesGridFilter(null, { column: 'c', operator: 'IS NULL' }), true);
    assert.equal(matchesGridFilter(5, { column: 'c', operator: 'IS NULL' }), false);
    assert.equal(matchesGridFilter(null, { column: 'c', operator: 'IS NOT NULL' }), false);
    assert.equal(matchesGridFilter(5, { column: 'c', operator: 'IS NOT NULL' }), true);
  });

  it('compares numerically when both sides are numeric', () => {
    assert.equal(matchesGridFilter(111, { column: 'c', operator: '=', value: '111' }), true);
    assert.equal(matchesGridFilter('111', { column: 'c', operator: '=', value: '111' }), true);
    assert.equal(matchesGridFilter(12, { column: 'c', operator: '>', value: '5' }), true);
    assert.equal(matchesGridFilter(3, { column: 'c', operator: '>=', value: '5' }), false);
    assert.equal(matchesGridFilter(3, { column: 'c', operator: '<=', value: '5' }), true);
    assert.equal(matchesGridFilter(3, { column: 'c', operator: '!=', value: '5' }), true);
    // Non-numeric cells fall back to case-insensitive string comparison.
    assert.equal(matchesGridFilter('b', { column: 'c', operator: '>', value: 'a' }), true);
    assert.equal(matchesGridFilter('B', { column: 'c', operator: '<', value: 'a' }), false);
    assert.equal(matchesGridFilter('Beta', { column: 'c', operator: '<', value: 'alpha' }), false);
  });

  it('filters LIKE patterns case-insensitively with wildcards', () => {
    assert.equal(matchesGridFilter('Alpha', { column: 'c', operator: 'LIKE', value: 'alp%' }), true);
    assert.equal(matchesGridFilter('Alpha', { column: 'c', operator: 'LIKE', value: '_lpha' }), true);
    assert.equal(matchesGridFilter('beta', { column: 'c', operator: 'LIKE', value: 'alp%' }), false);
    assert.equal(matchesGridFilter('beta', { column: 'c', operator: 'NOT LIKE', value: 'alp%' }), true);
  });

  it('checks IN lists across both representations', () => {
    assert.equal(matchesGridFilter(3, { column: 'c', operator: 'IN', value: '1, 3, 5' }), true);
    assert.equal(matchesGridFilter('delta', { column: 'c', operator: 'IN', value: 'alpha, delta' }), true);
    assert.equal(matchesGridFilter(4, { column: 'c', operator: 'IN', value: '1, 3, 5' }), false);
  });
});

describe('applyGridFilters / applyGridSearch', () => {
  it('applies rules row-wise and drops unknown columns silently', () => {
    const filtered = applyGridFilters(rows, columns, [
      { column: 'id', operator: '>=', value: '10' },
      { column: 'name', operator: 'LIKE', value: '%a%' },
    ]);
    assert.deepEqual(filtered, [rows[1], rows[2]]);
    assert.deepEqual(applyGridFilters(rows, columns, [{ column: 'missing', operator: '=', value: 'x' }]), rows);
  });

  it('searches all columns case-insensitively', () => {
    assert.deepEqual(applyGridSearch(rows, 'alpha'), [rows[0], rows[2]]);
    assert.deepEqual(applyGridSearch(rows, ''), rows);
  });
});

describe('sorting', () => {
  it('orders nulls first and numbers numerically', () => {
    const sorted = sortGridRows(rows, columns, { column: 'id', direction: 'asc' });
    assert.deepEqual(
      sorted.map((row) => row[0]),
      [null, 3, 12, 111],
    );
    const desc = sortGridRows(rows, columns, { column: 'id', direction: 'desc' });
    assert.deepEqual(
      desc.map((row) => row[0]),
      [111, 12, 3, null],
    );
  });

  it('sorts strings case-sensitively by locale and ignores unknown columns', () => {
    assert.deepEqual(applyGridSearch(rows, 'DELTA'), [rows[3]]);
    assert.deepEqual(sortGridRows(rows, columns, { column: 'missing', direction: 'asc' }), rows);
    assert.equal(compareGridCells(null, 1), -1);
    assert.equal(compareGridCells(1, null), 1);
  });
});

describe('exports', () => {
  it('renders RFC-4180 CSV with header and quoting', () => {
    const csv = gridToCsv(columns, [rows[2]]);
    assert.equal(csv, 'id,name,note\n12,Alpha,"has ""quotes"", and, commas\nand newline"\n');
  });

  it('exports NULL as empty in CSV and explicit null in JSON', () => {
    assert.equal(gridToCsv(columns, [rows[0]]), 'id,name,note\n3,alpha,\n');
    const json = gridToJson(columns, [rows[0]]);
    assert.deepEqual(JSON.parse(json), [{ id: 3, name: 'alpha', note: null }]);
  });

  it('renders one INSERT per row with portable literals', () => {
    const sql = gridToSqlInserts('users', columns, [rows[0], rows[3]]);
    assert.equal(
      sql,
      "INSERT INTO `users` (`id`, `name`, `note`) VALUES (3, 'alpha', NULL);\n" +
        "INSERT INTO `users` (`id`, `name`, `note`) VALUES (NULL, 'delta', 'plain');\n",
    );
    assert.equal(sqlStringLiteral("o'brien"), "'o''brien'");
    assert.equal(sqlIdentifier('we`ird'), '`we``ird`');
  });

  it('escapes pipes and newlines in Markdown', () => {
    const md = gridToMarkdown(columns, [rows[2]]);
    assert.equal(md, '| id | name | note |\n| --- | --- | --- |\n| 12 | Alpha | has "quotes", and, commas<br>and newline |\n');
  });

  it('renders each format through the dispatcher and names files', () => {
    assert.match(renderGridExport('csv', 't', columns, rows), /^id,name,note/);
    assert.match(renderGridExport('json', 't', columns, rows), /^\[\s*\{/);
    assert.match(renderGridExport('sql', 't', columns, rows), /^INSERT INTO `t`/);
    assert.match(renderGridExport('markdown', 't', columns, rows), /^\| id \| name \| note \|/);
    assert.equal(renderGridExport('sql', '', columns, rows), '');
    assert.equal(exportFileName('my table:v2', 'csv'), 'my table_v2.csv');
    assert.equal(exportFileName('r', 'markdown'), 'r.md');
  });
});
