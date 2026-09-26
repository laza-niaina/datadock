import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_FORMATS,
  SELECTION_FORMATS,
  copyFormatLabel,
  copyPayload,
} from '../../src/ui/resultView/copyFormats';
import type { GridColumn } from '../../src/ui/dataGrid/dataGridModel';

const columns: GridColumn[] = [
  { name: 'id', type: 'int' },
  { name: 'name', type: 'varchar(255)' },
  { name: 'note', type: 'text' },
];

const rows: (string | number | null)[][] = [
  [3, 'alpha', null],
  [12, 'Alpha', 'has "quotes", and, commas'],
];

describe('copyFormats menu metadata', () => {
  it('offers the DBCode selection-only formats first', () => {
    assert.deepEqual(SELECTION_FORMATS.slice(0, 3), ['plain', 'withHeaders', 'commaList']);
    assert.equal(ALL_FORMATS.includes('plain'), false);
    assert.equal(ALL_FORMATS.includes('csv'), true);
  });

  it('labels every format like the DBCode menu', () => {
    assert.equal(copyFormatLabel('plain'), 'Without Headers');
    assert.equal(copyFormatLabel('withHeaders'), 'With Headers');
    assert.equal(copyFormatLabel('commaList'), 'As Comma List');
    assert.equal(copyFormatLabel('sqlInsert'), 'As SQL Insert Statements');
    assert.equal(copyFormatLabel('sqlIn'), 'As SQL In Clause');
    assert.equal(copyFormatLabel('htmlStyled'), 'As HTML (Styled)');
    for (const format of [...SELECTION_FORMATS, ...ALL_FORMATS]) {
      assert.notEqual(copyFormatLabel(format), '');
    }
  });
});

describe('copyPayload', () => {
  it('copies values without headers as tab separated rows', () => {
    assert.equal(
      copyPayload('plain', 'users', columns, rows),
      '3\talpha\t\n12\tAlpha\thas "quotes", and, commas',
    );
  });

  it('copies values with the header row first', () => {
    assert.equal(
      copyPayload('withHeaders', 'users', columns, rows),
      'id\tname\tnote\n3\talpha\t\n12\tAlpha\thas "quotes", and, commas',
    );
  });

  it('flattens every value into one comma list', () => {
    assert.equal(
      copyPayload('commaList', 'users', columns, rows),
      '3, alpha, , 12, Alpha, has "quotes", and, commas',
    );
  });

  it('renders CSV compatible with the export dialog', () => {
    const csv = copyPayload('csv', 'users', columns, rows);
    assert.match(csv, /^id,name,note\n/);
    assert.match(csv, /"has ""quotes"", and, commas"/);
  });

  it('renders compact JSON with explicit nulls', () => {
    const json = copyPayload('json', 'users', columns, rows);
    assert.equal(json.includes('\n'), false);
    assert.deepEqual(JSON.parse(json), [
      { id: 3, name: 'alpha', note: null },
      { id: 12, name: 'Alpha', note: 'has "quotes", and, commas' },
    ]);
  });

  it('renders pretty JSON as a formatted array', () => {
    const json = copyPayload('jsonPretty', 'users', columns, rows);
    assert.ok(json.includes('\n  {'));
    assert.deepEqual(JSON.parse(json).length, 2);
  });

  it('renders a Markdown table with a divider row', () => {
    const md = copyPayload('markdown', 'users', columns, rows);
    const lines = md.trim().split('\n');
    assert.equal(lines[0], '| id | name | note |');
    assert.equal(lines[1], '| --- | --- | --- |');
    assert.equal(lines[2], '| 3 | alpha |  |');
  });

  it('escapes HTML in both plain and styled tables', () => {
    const html = copyPayload('html', 'users', columns, [[1, '<b>x</b>', null]]);
    assert.ok(html.includes('<td>&lt;b&gt;x&lt;/b&gt;</td>'));
    assert.equal(html.includes('style='), false);

    const styled = copyPayload('htmlStyled', 'users', columns, [[1, '<b>x</b>', null]]);
    assert.ok(styled.includes('border-collapse:collapse'));
    assert.ok(styled.includes('<td style='));
  });

  it('builds a parenthesized SQL IN list with NULL support', () => {
    assert.equal(copyPayload('sqlIn', 'users', columns, rows), "(3, 'alpha', NULL, 12, 'Alpha', 'has \"quotes\", and, commas')");
  });

  it('builds one INSERT per row with backtick identifiers', () => {
    const sql = copyPayload('sqlInsert', 'users', columns, rows);
    const lines = sql.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "INSERT INTO `users` (`id`, `name`, `note`) VALUES (3, 'alpha', NULL);");
  });

  it('escapes XML characters and marks NULL columns', () => {
    const xml = copyPayload('xml', 'users', columns, rows);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes('<column name="name">alpha</column>'));
    assert.ok(xml.includes('<column name="note" xsi:nil="true"/>'));
    assert.equal(xml.includes('<b>'), false);
  });

  it('renders an empty selection as an empty payload without throwing', () => {
    assert.equal(copyPayload('plain', '', columns, []), '');
    assert.equal(copyPayload('csv', '', columns, []), 'id,name,note\n');
    assert.equal(copyPayload('sqlInsert', '', columns, []), '');
  });
});
