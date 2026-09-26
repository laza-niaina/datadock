/**
 * Pure serializers for the result view's "Copy As" context menu.
 *
 * The menu mirrors DBCode's grid right-click ("Copy As > Selection / All"):
 * quick tab-separated copies, plus CSV, HTML, JSON, Markdown, SQL and XML
 * payloads for the selection (the row(s) under the cursor) or for every
 * visible row.
 *
 * No `vscode` and no DOM here: the webview posts the rendered text to the
 * host, which writes it to the system clipboard, and `node --test` can lock
 * every format. The CSV / JSON / INSERT / Markdown renderers are reused from
 * the shared pure grid model so the Copy As payloads stay byte-compatible
 * with the Export dialog.
 */

import {
  gridToCsv,
  gridToJson,
  gridToMarkdown,
  gridToSqlInserts,
  sqlStringLiteral,
  type GridCell,
  type GridColumn,
} from '../dataGrid/dataGridModel';

/** Every payload the Copy As menu can produce. */
export type CopyFormat =
  | 'plain'
  | 'withHeaders'
  | 'commaList'
  | 'csv'
  | 'html'
  | 'htmlStyled'
  | 'json'
  | 'jsonPretty'
  | 'markdown'
  | 'sqlIn'
  | 'sqlInsert'
  | 'xml';

/** Formats offered for "Selection" (the row(s) picked by the right-click). */
export const SELECTION_FORMATS: readonly CopyFormat[] = [
  'plain',
  'withHeaders',
  'commaList',
  'csv',
  'html',
  'htmlStyled',
  'json',
  'jsonPretty',
  'markdown',
  'sqlIn',
  'sqlInsert',
  'xml',
];

/** Formats offered for "All" (every visible row). */
export const ALL_FORMATS: readonly CopyFormat[] = [
  'csv',
  'html',
  'htmlStyled',
  'json',
  'jsonPretty',
  'markdown',
  'sqlIn',
  'sqlInsert',
  'xml',
];

/** Human label shown in the menu, exactly as DBCode names the formats. */
export function copyFormatLabel(format: CopyFormat): string {
  switch (format) {
    case 'plain':
      return 'Without Headers';
    case 'withHeaders':
      return 'With Headers';
    case 'commaList':
      return 'As Comma List';
    case 'csv':
      return 'As CSV';
    case 'html':
      return 'As HTML';
    case 'htmlStyled':
      return 'As HTML (Styled)';
    case 'json':
      return 'As JSON';
    case 'jsonPretty':
      return 'As JSON Pretty';
    case 'markdown':
      return 'As Markdown';
    case 'sqlIn':
      return 'As SQL In Clause';
    case 'sqlInsert':
      return 'As SQL Insert Statements';
    case 'xml':
      return 'As XML';
  }
}

function cellText(cell: GridCell): string {
  return cell === null ? '' : String(cell);
}

function tsvRows(columns: readonly GridColumn[], rows: readonly GridCell[][], withHeader: boolean): string {
  const lines: string[] = [];
  if (withHeader) {
    lines.push(columns.map((column) => column.name).join('\t'));
  }
  for (const row of rows) {
    lines.push(columns.map((_column, index) => cellText(row[index] ?? null)).join('\t'));
  }
  return lines.join('\n');
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlTable(columns: readonly GridColumn[], rows: readonly GridCell[][], styled: boolean): string {
  const open = styled
    ? '<table style="border-collapse:collapse;border:1px solid #ccc;font-family:sans-serif;font-size:13px">'
    : '<table>';
  const cellStyle = styled ? ' style="border:1px solid #ccc;padding:4px 8px;text-align:left"' : '';
  const th = styled ? `<th${cellStyle}>` : '<th>';
  const td = styled ? `<td${cellStyle}>` : '<td>';
  const parts: string[] = [open, '<thead><tr>'];
  for (const column of columns) {
    parts.push(`${th}${htmlEscape(column.name)}</th>`);
  }
  parts.push('</tr></thead><tbody>');
  for (const row of rows) {
    parts.push('<tr>');
    columns.forEach((_column, index) => {
      parts.push(`${td}${htmlEscape(cellText(row[index] ?? null))}</td>`);
    });
    parts.push('</tr>');
  }
  parts.push('</tbody></table>');
  return parts.join('');
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlRows(columns: readonly GridColumn[], rows: readonly GridCell[][]): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rows xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
  ];
  for (const row of rows) {
    parts.push('  <row>');
    columns.forEach((column, index) => {
      const value = row[index] ?? null;
      const name = xmlEscape(column.name);
      parts.push(value === null ? `    <column name="${name}" xsi:nil="true"/>` : `    <column name="${name}">${xmlEscape(String(value))}</column>`);
    });
    parts.push('  </row>');
  }
  parts.push('</rows>');
  return parts.join('\n');
}

function sqlInClause(rows: readonly GridCell[][]): string {
  const values: string[] = [];
  for (const row of rows) {
    for (const cell of row) {
      values.push(cell === null ? 'NULL' : typeof cell === 'number' ? String(cell) : sqlStringLiteral(String(cell)));
    }
  }
  return `(${values.join(', ')})`;
}

/**
 * Renders `rows` (already narrowed to the menu scope) in the requested
 * format. `table` is only used by the INSERT statements payload.
 */
export function copyPayload(
  format: CopyFormat,
  table: string,
  columns: readonly GridColumn[],
  rows: readonly GridCell[][],
): string {
  switch (format) {
    case 'plain':
      return tsvRows(columns, rows, false);
    case 'withHeaders':
      return tsvRows(columns, rows, true);
    case 'commaList':
      return rows
        .map((row) => columns.map((_column, index) => cellText(row[index] ?? null)).join(', '))
        .join(', ');
    case 'csv':
      return gridToCsv(columns, rows);
    case 'json':
      return JSON.stringify(rowsToRecords(columns, rows));
    case 'jsonPretty':
      return gridToJson(columns, rows);
    case 'html':
      return htmlTable(columns, rows, false);
    case 'htmlStyled':
      return htmlTable(columns, rows, true);
    case 'markdown':
      return gridToMarkdown(columns, rows);
    case 'sqlIn':
      return sqlInClause(rows);
    case 'sqlInsert':
      return gridToSqlInserts(table, columns, rows);
    case 'xml':
      return xmlRows(columns, rows);
  }
}

function rowsToRecords(columns: readonly GridColumn[], rows: readonly GridCell[][]): Record<string, GridCell>[] {
  return rows.map((row) => {
    const record: Record<string, GridCell> = {};
    columns.forEach((column, index) => {
      record[column.name] = row[index] ?? null;
    });
    return record;
  });
}
