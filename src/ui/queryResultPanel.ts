/**
 * Read-only result panel for the SQL runner.
 *
 * The panel is scriptable (navigation intents only): each statement section
 * carries a "Open in SQL file" action that hands the host a statement offset
 * range, which the host resolves through `showTextDocument`. Values stay
 * escaped before they reach the webview and no credential ever crosses the
 * webview boundary.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { QueryResultSet } from '../db/types';

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
  /** Non-fatal server notices shown above the statement list. */
  readonly notices: readonly string[];
  readonly statements: readonly QueryStatementDisplay[];
  /** True when at least one statement reported an error. */
  readonly hasError: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Human-readable, HTML-safe representation of one database value. */
export function displayQueryValue(value: unknown): string {
  if (value === null) {
    return 'NULL';
  }
  if (value === undefined) {
    return '';
  }
  if (value instanceof Uint8Array) {
    return `<binary ${value.byteLength} bytes>`;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

interface ColumnModel {
  readonly name: string;
  readonly type?: string;
}

function columnModel(fields: readonly { name: string; type?: string }[]): ColumnModel[] {
  return fields.map((field) => ({ name: field.name, type: field.type }));
}

function renderResultSet(result: QueryResultSet): string {
  const columns = columnModel(result.fields);
  if (result.isMutation) {
    const affected = result.rowsAffected ?? 0;
    return `<p class="result-summary">${escapeHtml(`${affected} row(s) affected.`)}</p>`;
  }
  const headers = columns
    .map(
      (column) =>
        `<th scope="col"><span class="col-name">${escapeHtml(column.name)}</span>${column.type ? `<span class="col-type">${escapeHtml(column.type)}</span>` : ''}</th>`,
    )
    .join('');
  const rows = result.rows
    .map(
      (row) =>
        `<tr>${row
          .map((value) => (value === null ? '<td class="null">NULL</td>' : `<td>${escapeHtml(displayQueryValue(value))}</td>`))
          .join('')}</tr>`,
    )
    .join('');
  const body = rows || `<tr><td colspan="${Math.max(1, columns.length)}" class="empty">No rows returned.</td></tr>`;
  const truncated = result.truncated
    ? `<p class="truncated">Showing the first ${result.rows.length} rows; more rows are available on the server.</p>`
    : '';
  return `<div class="table-wrap"><table><thead><tr>${headers || '<th>Result</th>'}</tr></thead><tbody>${body}</tbody></table></div>${truncated}`;
}

function renderStatement(statement: QueryStatementDisplay): string {
  const status = statement.error
    ? '<span class="badge badge-error">error</span>'
    : statement.skipped
      ? '<span class="badge badge-skipped">skipped</span>'
      : '<span class="badge badge-ok">ok</span>';
  const seconds = (statement.durationMs / 1000).toFixed(2);
  const action = `<button type="button" class="reveal" data-reveal-start="${statement.start}" data-reveal-end="${statement.end}">Open in SQL file</button>`;
  const results = (statement.results ?? []).map(renderResultSet).join('');
  const error =
    statement.error !== undefined
      ? `<div class="error-box"><strong>Statement ${statement.index} failed</strong><pre>${escapeHtml(statement.error)}</pre></div>`
      : '';
  return `<section class="statement-section">
    <header class="statement-head">
      <span class="statement-pill">Statement ${statement.index}</span>
      ${status}
      <span class="statement-time">${seconds} s</span>
      ${statement.skipped ? '' : action}
    </header>
    <pre class="statement-sql">${escapeHtml(statement.text)}</pre>
    ${error}
    ${results}
  </section>`;
}

function styles(nonce: string): string {
  return `<style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 18px 22px 40px;
      line-height: 1.45;
    }
    .header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
    h1 { font-size: 1.2rem; margin: 0; font-weight: 600; }
    .connection { color: var(--vscode-descriptionForeground); font-size: .85rem; }
    .meta { color: var(--vscode-descriptionForeground); font-size: .85rem; margin: 0 0 14px; }
    .meta strong { color: var(--vscode-foreground); font-weight: 600; }
    .notices { margin: 0 0 14px; padding: 8px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-editorWidget-background); }
    .notices li { margin: 2px 0; }
    .summary-error {
      margin: 0 0 14px; padding: 10px 12px; border-left: 3px solid var(--vscode-errorForeground);
      background: var(--vscode-inputValidation-errorBackground, var(--vscode-editorWidget-background));
      color: var(--vscode-errorForeground); font-weight: 600;
    }
    .statement-section { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
    .statement-head {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .statement-pill { font-weight: 600; }
    .badge { padding: 1px 8px; border-radius: 10px; font-size: .75rem; font-weight: 600; }
    .badge-ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); background: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-charts-green)) 12%, transparent); }
    .badge-error { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); background: color-mix(in srgb, var(--vscode-testing-iconFailed, var(--vscode-errorForeground)) 12%, transparent); }
    .badge-skipped { color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background); }
    .statement-time { color: var(--vscode-descriptionForeground); font-size: .8rem; margin-left: auto; }
    .reveal {
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
      border: 0; border-radius: 4px; padding: 3px 9px; cursor: pointer; font-size: .8rem;
    }
    .reveal:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .statement-sql {
      margin: 0; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere;
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--vscode-textPreformat-foreground);
      border-bottom: 1px solid var(--vscode-panel-border);
      max-height: 240px; overflow: auto;
    }
    .error-box { padding: 10px 12px; background: var(--vscode-inputValidation-errorBackground, transparent); }
    .error-box strong { color: var(--vscode-errorForeground); }
    .error-box pre { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--vscode-errorForeground); }
    .result-summary {
      margin: 0; padding: 10px 12px;
      color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); font-weight: 600;
    }
    .table-wrap { overflow: auto; }
    table { border-collapse: collapse; min-width: 100%; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 10px; text-align: left; vertical-align: top; white-space: pre-wrap; }
    th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); font-size: .8rem; }
    .col-name { font-weight: 600; }
    .col-type { display: block; color: var(--vscode-descriptionForeground); font-weight: 400; font-size: .75rem; }
    tr:last-child td { border-bottom: 0; }
    td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    .empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 18px; }
    .truncated { color: var(--vscode-editorWarning-foreground); padding: 8px 12px; margin: 0; border-top: 1px solid var(--vscode-panel-border); }
    .empty-state { color: var(--vscode-descriptionForeground); text-align: center; padding: 40px 0; }
  </style>`;
}

export function renderQueryDisplayHtml(options: QueryDisplayOptions): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const statementsHtml =
    options.statements.length > 0
      ? options.statements.map(renderStatement).join('')
      : '<p class="empty-state">No statements were run.</p>';
  const notices =
    options.notices.length > 0
      ? `<ul class="notices">${options.notices.map((notice) => `<li>${escapeHtml(notice)}</li>`).join('')}</ul>`
      : '';
  const errorBanner = options.hasError
    ? '<p class="summary-error">One or more statements failed. Each failing statement is marked below and keeps its source location.</p>'
    : '';
  const executed = options.statements.filter((statement) => !statement.skipped).length;
  const totalRows = options.statements.reduce(
    (sum, statement) => sum + statement.results.reduce((inner, set) => inner + (set.isMutation ? 0 : set.rows.length), 0),
    0,
  );
  const database = options.database ? `, database ${escapeHtml(options.database)}` : '';
  const script = `
    (function () {
      var vscode = acquireVsCodeApi();
      document.querySelectorAll('[data-reveal-start]').forEach(function (button) {
        button.addEventListener('click', function () {
          vscode.postMessage({
            type: 'reveal',
            start: Number(button.getAttribute('data-reveal-start')),
            end: Number(button.getAttribute('data-reveal-end'))
          });
        });
      });
    }());
  `;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DataDock Query Result</title>
  ${styles(nonce)}
</head>
<body>
  <div class="header">
    <h1>DataDock query result</h1>
    <span class="connection">on ${escapeHtml(options.connectionName)}${database}</span>
  </div>
  <p class="meta">
    <strong>${options.statements.length}</strong> statement(s), <strong>${executed}</strong> executed, <strong>${totalRows}</strong> row(s),
    <strong>${(options.durationMs / 1000).toFixed(2)} s</strong> total
  </p>
  ${errorBanner}
  ${notices}
  ${statementsHtml}
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

export class QueryResultPanel {
  private static readonly open = new Map<string, QueryResultPanel>();

  private reveal?: (start: number, end: number) => void;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly key: string,
  ) {
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message) || !this.reveal) {
        return;
      }
      const value = message as { type: string; start?: unknown; end?: unknown };
      if (value.type !== 'reveal') {
        return;
      }
      const start = typeof value.start === 'number' ? value.start : 0;
      const end = typeof value.end === 'number' ? value.end : start;
      this.reveal(Math.max(0, start), Math.max(start, end));
    });
  }

  static show(options: QueryDisplayOptions, onReveal?: (start: number, end: number) => void): void {
    const existing = QueryResultPanel.open.get(options.key);
    if (existing) {
      existing.reveal = onReveal;
      existing.panel.webview.html = renderQueryDisplayHtml(options);
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'dbclient.queryResult',
      options.panelTitle,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] },
    );
    const instance = new QueryResultPanel(panel, options.key);
    instance.reveal = onReveal;
    QueryResultPanel.open.set(options.key, instance);
    panel.webview.html = renderQueryDisplayHtml(options);
  }

  dispose(): void {
    QueryResultPanel.open.delete(this.key);
  }
}