/**
 * Query result panel for the SQL runner, built on the shared DataDock data
 * grid (the "Result View" design): one tab per statement, toolbar with search,
 * transpose and Export dialog, cell context menu with filter/copy actions.
 *
 * The panel is scriptable (navigation/export intents only): each statement
 * carries an "open in SQL file" action resolved by the host, and exports are
 * rendered host-side from serialized cells. Values stay escaped before they
 * reach the webview and no credential ever crosses the webview boundary.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { QueryResultSet } from '../db/types';
import type { GridCell, GridColumn, GridExportFormat } from './dataGrid/dataGridModel';
import { renderGridExport, exportFileName, serializeGridValue } from './dataGrid/dataGridModel';
import {
  renderDataGridBody,
  gridStyles,
  escapeHtml,
  tableFromStatement,
  type GridViewGrid,
  type DataGridViewOptions,
} from './dataGrid/dataGridView';

export interface QueryStatementDisplay {
  /** 1-based position inside the submitted batch. */
  readonly index: number;
  /** Full statement text, exactly as executed. */
  readonly text: string;
  /** Start offset (character) of the statement in the source document. */
  readonly start: number;
  /** End offset (character) of the statement in the source document. */
  readonly end: number;
  /** Result sets produced by a successful run. */
  readonly results: readonly QueryResultSet[];
  /** Redacted error message when the statement failed. */
  readonly error?: string;
  /** True when the statement was never attempted (batch stopped earlier). */
  readonly skipped?: boolean;
  /** Statement-local duration in milliseconds. */
  readonly durationMs: number;
}

export interface QueryDisplayOptions {
  /** Panel reuse key (stable per source document). */
  readonly key: string;
  /** Webview title without the run details. */
  readonly panelTitle: string;
  readonly connectionName: string;
  readonly database?: string;
  readonly durationMs: number;
  /** Non-fatal server notices shown above the grid. */
  readonly notices: readonly string[];
  readonly statements: readonly QueryStatementDisplay[];
  /** True when at least one statement reported an error. */
  readonly hasError: boolean;
}

type ResultMessage =
  | { type: 'reveal'; start?: unknown; end?: unknown }
  | { type: 'export'; format?: unknown; target?: unknown; gridId?: unknown };

function gridFromResultSet(
  statement: QueryStatementDisplay,
  resultSet: QueryResultSet,
  gridIndex: number,
  resultCount: number,
): GridViewGrid {
  const columns: GridColumn[] = resultSet.fields.map((field) => ({ name: field.name, type: field.type }));
  const rows: GridCell[][] = resultSet.rows.map((row) => row.map((value) => serializeGridValue(value)));
  const status: GridViewGrid['status'] = statement.error !== undefined ? 'error' : statement.skipped ? 'skipped' : resultSet.isMutation ? 'mutation' : 'ok';
  const label = resultCount > 1 ? `#${statement.index}.${gridIndex + 1}` : `#${statement.index}`;
  return {
    id: `s${statement.index}r${gridIndex}`,
    table: tableFromStatement(statement.text),
    columns,
    rows,
    label,
    status,
    error: statement.error,
    durationMs: statement.durationMs,
    rowsAffected: resultSet.rowsAffected,
    statementSql: statement.text,
    reveal: { start: statement.start, end: statement.end },
    truncated: resultSet.truncated,
  };
}

function gridsForStatements(statements: readonly QueryStatementDisplay[]): GridViewGrid[] {
  const grids: GridViewGrid[] = [];
  for (const statement of statements) {
    const resultSets = statement.results ?? [];
    if (resultSets.length === 0) {
      grids.push({
        id: `s${statement.index}x`,
        table: tableFromStatement(statement.text),
        columns: [],
        rows: [],
        label: `#${statement.index}`,
        status: statement.error !== undefined ? 'error' : statement.skipped ? 'skipped' : 'mutation',
        error: statement.error,
        durationMs: statement.durationMs,
        statementSql: statement.text,
        reveal: { start: statement.start, end: statement.end },
      });
      continue;
    }
    resultSets.forEach((resultSet, resultSetIndex) => {
      grids.push(gridFromResultSet(statement, resultSet, resultSetIndex, resultSets.length));
    });
  }
  return grids;
}

function pageShell(nonce: string, title: string, head: string, body: string, script: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  ${head}
</head>
<body>
${body}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

function renderQueryResultPage(options: QueryDisplayOptions): string {
  const nonce = randomBytes(16).toString('base64');
  const grids = gridsForStatements(options.statements);
  const firstActive = Math.max(0, grids.findIndex((grid) => grid.status === 'error'));
  const viewOptions: DataGridViewOptions = {
    mode: 'query',
    grids,
    activeIndex: firstActive,
    cost: `Cost: ${(options.durationMs / 1000).toFixed(2)}s`,
  };
  const summaryParts = [
    `<strong>${options.statements.length}</strong> statement(s)`,
    `<strong>${options.statements.filter((statement) => !statement.skipped).length}</strong> executed`,
    `<strong>${(options.durationMs / 1000).toFixed(2)} s</strong> total`,
  ].join(' · ');
  const notices =
    options.notices.length > 0
      ? `<ul class="notices">${options.notices.map((notice) => `<li>${escapeHtml(notice)}</li>`).join('')}</ul>`
      : '';
  const errorBanner = options.hasError
    ? '<p class="summary-error">One or more statements failed. The failing statement is marked in its tab.</p>'
    : '';
  const head = `${gridStyles(nonce)}<style nonce="${nonce}">
    .page-head { padding: 10px 14px 0; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .page-head strong { color: var(--vscode-foreground); }
    .summary-error {
      margin: 8px 14px 0; padding: 8px 12px; border-left: 3px solid var(--vscode-errorForeground); border-radius: 4px;
      background: color-mix(in srgb, var(--vscode-errorForeground) 10%, var(--vscode-editorWidget-background));
      font-weight: 600;
    }
    .notices { margin: 8px 14px 0; padding: 8px 12px 8px 30px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-editorWidget-background); }
    .notices li { margin: 2px 0; }
    .sql-strip { position: relative; }
    #reveal-btn { position: absolute; right: 8px; top: 6px; }
    .dialog-backdrop { z-index: 200; }
  </style>`;
  const body = `<div class="page-head">DataDock · ${escapeHtml(options.connectionName)}${options.database ? ` · ${escapeHtml(options.database)}` : ''} · ${summaryParts}</div>
  ${errorBanner}
  ${notices}
  ${renderDataGridBody(viewOptions, nonce)}`;
  return pageShell(nonce, 'DataDock Query Result', head, body, '');
}

export class QueryResultPanel {
  private static readonly open = new Map<string, QueryResultPanel>();

  private reveal?: (start: number, end: number) => void;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly key: string,
    private statements: readonly QueryStatementDisplay[],
  ) {
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      this.onMessage(message);
    });
  }

  static show(options: QueryDisplayOptions, onReveal?: (start: number, end: number) => void): void {
    const existing = QueryResultPanel.open.get(options.key);
    if (existing) {
      existing.reveal = onReveal;
      existing.statements = options.statements;
      existing.panel.webview.html = renderQueryResultPage(options);
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'dbclient.queryResult',
      options.panelTitle,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] },
    );
    const instance = new QueryResultPanel(panel, options.key, options.statements);
    instance.reveal = onReveal;
    QueryResultPanel.open.set(options.key, instance);
    panel.webview.html = renderQueryResultPage(options);
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }
    const value = message as ResultMessage;
    if (value.type === 'reveal' && this.reveal) {
      const start = typeof value.start === 'number' ? value.start : 0;
      const end = typeof value.end === 'number' ? value.end : start;
      this.reveal(Math.max(0, start), Math.max(start, end));
      return;
    }
    if (value.type === 'export') {
      const gridId = typeof value.gridId === 'string' ? value.gridId : '';
      const match = gridId.match(/^s(\d+)/);
      const statement = match ? this.statements[Number(match[1]) - 1] : undefined;
      const format: GridExportFormat =
        value.format === 'json' || value.format === 'sql' || value.format === 'markdown' ? value.format : 'csv';
      if (!statement) {
        return;
      }
      const targetIsEditor = value.target === 'editor';
      void exportStatementResults(statement, format, targetIsEditor);
      return;
    }
  }

  dispose(): void {
    QueryResultPanel.open.delete(this.key);
  }
}

/** Renders every result set of one statement in the requested format. */
async function exportStatementResults(
  statement: QueryStatementDisplay,
  format: GridExportFormat,
  toEditor: boolean,
): Promise<void> {
  const sections: string[] = [];
  const baseName = statement.text.trim().slice(0, 32).replace(/\s+/g, '_') || 'query';
  for (const resultSet of statement.results ?? []) {
    const columns: GridColumn[] = resultSet.fields.map((field) => ({ name: field.name, type: field.type }));
    const rows: GridCell[][] = resultSet.rows.map((row) => row.map((value) => serializeGridValue(value)));
    const table = tableFromStatement(statement.text);
    const content = renderGridExport(format, table, columns, rows);
    if (content.trim() !== '') {
      sections.push(content);
    }
  }
  const content = sections.join('\n');
  if (content.trim() === '') {
    void vscode.window.showInformationMessage('Nothing to export for this statement.');
    return;
  }
  if (toEditor) {
    const document = await vscode.workspace.openTextDocument({ content, language: format === 'json' ? 'json' : format === 'markdown' ? 'markdown' : 'plaintext' });
    await vscode.window.showTextDocument(document, { preview: true });
    return;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(exportFileName(baseName, format)),
    filters: exportFilters(format),
  });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
  void vscode.window.showInformationMessage(`DataDock: exported to ${target.fsPath}.`);
}

function exportFilters(format: GridExportFormat): Record<string, string[]> {
  switch (format) {
    case 'csv':
      return { 'CSV': ['csv'] };
    case 'json':
      return { 'JSON': ['json'] };
    case 'sql':
      return { 'SQL': ['sql'] };
    case 'markdown':
      return { 'Markdown': ['md'] };
  }
}
