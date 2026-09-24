/**
 * Paginated, read-only table viewer.
 *
 * The webview only sends navigation intents. Every page is fetched by the
 * extension host through the selected driver, so credentials never cross the
 * webview boundary and identifiers remain validated by the data layer.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/connectionManager';
import { DbError } from '../db/errors';
import type { Logger, TableDataPage, TableDataRequest, TableRef, TableSort } from '../db/types';
import { globalRedactor } from '../util/redaction';

interface TableViewerOptions {
  readonly manager: ConnectionManager;
  readonly logger: Logger;
  readonly ref: TableRef;
  readonly title: string;
}

type TableViewerMessage =
  | { type: 'ready' }
  | { type: 'refresh'; search?: unknown }
  | { type: 'page'; offset: unknown }
  | { type: 'sort'; column: unknown };

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function displayValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '';
  if (value instanceof Uint8Array) return `<binary ${value.byteLength} bytes>`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function styles(nonce: string): string {
  return `<style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 14px; }
    h1 { font-size: 1.2rem; margin: 0 0 10px; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
    input { flex: 1 1 220px; min-width: 160px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 5px 7px; }
    button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 5px 9px; cursor: pointer; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { opacity: .5; cursor: default; }
    .status { color: var(--vscode-descriptionForeground); margin: 7px 0; }
    .error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
    .table-wrap { overflow: auto; border: 1px solid var(--vscode-panel-border); }
    table { border-collapse: collapse; min-width: 100%; }
    th, td { border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 9px; text-align: left; vertical-align: top; white-space: pre-wrap; }
    th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); }
    th button { padding: 2px 4px; color: inherit; background: transparent; text-align: left; }
    tr:last-child td { border-bottom: 0; }
    td.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    .empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 18px; }
    .hint { color: var(--vscode-descriptionForeground); margin-top: 10px; }
  </style>`;
}

function renderPage(
  page: TableDataPage | undefined,
  request: TableDataRequest,
  title: string,
  error: string | undefined,
): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  if (error) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="${csp}" /><title>DataDock Table</title>${styles(nonce)}</head><body><h1>${escapeHtml(title)}</h1><p class="error">${escapeHtml(error)}</p></body></html>`;
  }
  if (!page) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="${csp}" /><title>DataDock Table</title>${styles(nonce)}</head><body><h1>${escapeHtml(title)}</h1><p>Loading…</p></body></html>`;
  }

  const headers = page.columns
    .map((column) => {
      const active = request.sort?.some((sort) => sort.column === column.name);
      const direction = request.sort?.find((sort) => sort.column === column.name)?.direction ?? 'asc';
      const marker = active ? ` ${direction === 'asc' ? '▲' : '▼'}` : '';
      return `<th scope="col"><button type="button" data-sort="${escapeHtml(column.name)}">${escapeHtml(column.name)}${marker}</button></th>`;
    })
    .join('');
  const rows = page.rows
    .map((row) =>
      `<tr>${row
        .map((value) => (value === null ? '<td class="null">NULL</td>' : `<td>${escapeHtml(displayValue(value))}</td>`))
        .join('')}</tr>`,
    )
    .join('');
  const body = rows || `<tr><td colspan="${Math.max(1, page.columns.length)}" class="empty">No rows found.</td></tr>`;
  const first = page.rows.length === 0 ? 0 : page.offset + 1;
  const last = page.offset + page.rows.length;
  const total = page.totalRows === undefined ? '' : ` of ${page.totalRows}`;
  const previousDisabled = page.offset <= 0 ? ' disabled' : '';
  const nextDisabled = page.totalRows !== undefined && last >= page.totalRows ? ' disabled' : '';
  const search = escapeHtml(request.search ?? '');
  const script = `
    (function () {
      var vscode = acquireVsCodeApi();
      var search = document.getElementById('search');
      document.getElementById('refresh').addEventListener('click', function () {
        vscode.postMessage({ type: 'refresh', search: search.value });
      });
      search.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') { vscode.postMessage({ type: 'refresh', search: search.value }); }
      });
      document.getElementById('previous').addEventListener('click', function () { vscode.postMessage({ type: 'page', offset: ${Math.max(0, request.offset - request.limit)} }); });
      document.getElementById('next').addEventListener('click', function () { vscode.postMessage({ type: 'page', offset: ${request.offset + request.limit} }); });
      document.querySelectorAll('[data-sort]').forEach(function (button) {
        button.addEventListener('click', function () { vscode.postMessage({ type: 'sort', column: button.getAttribute('data-sort') }); });
      });
    }());
  `;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DataDock Table</title>
  ${styles(nonce)}
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="toolbar">
    <input id="search" type="search" value="${search}" placeholder="Search text columns…" />
    <button id="refresh" type="button">Refresh</button>
    <button id="previous" class="secondary" type="button"${previousDisabled}>Previous</button>
    <button id="next" class="secondary" type="button"${nextDisabled}>Next</button>
  </div>
  <p class="status">Rows ${first}-${last}${total} · page size ${request.limit}</p>
  <div class="table-wrap"><table><thead><tr>${headers}</tr></thead><tbody>${body}</tbody></table></div>
  <p class="hint">Read-only view${page.editable ? '' : ' for this connection'}.</p>
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

export class TableViewerPanel {
  private static readonly open = new Map<string, TableViewerPanel>();

  private request: TableDataRequest = { offset: 0, limit: 100, search: '' };
  private page?: TableDataPage;
  private error?: string;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly options: TableViewerOptions,
    private readonly key: string,
  ) {
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.onMessage(message);
    });
    this.panel.onDidDispose(() => this.dispose());
  }

  static show(options: TableViewerOptions): void {
    const key = `${options.ref.connectionId}/${options.ref.database}/${options.ref.schema ?? ''}/${options.ref.table}`;
    const existing = TableViewerPanel.open.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'dbclient.tableViewer',
      `DataDock - ${options.title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] },
    );
    const instance = new TableViewerPanel(panel, options, key);
    TableViewerPanel.open.set(key, instance);
    void instance.load();
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return;
    }
    const value = message as TableViewerMessage;
    switch (value.type) {
      case 'ready':
        await this.load();
        return;
      case 'refresh':
        this.request = { ...this.request, offset: 0, search: typeof value.search === 'string' ? value.search.slice(0, 200) : '' };
        await this.load();
        return;
      case 'page': {
        const offset = typeof value.offset === 'number' && Number.isFinite(value.offset) ? Math.max(0, Math.floor(value.offset)) : 0;
        this.request = { ...this.request, offset };
        await this.load();
        return;
      }
      case 'sort': {
        if (typeof value.column !== 'string' || !this.page?.columns.some((column) => column.name === value.column)) {
          return;
        }
        const current = this.request.sort?.[0];
        const direction: TableSort['direction'] = current?.column === value.column && current.direction === 'asc' ? 'desc' : 'asc';
        this.request = { ...this.request, offset: 0, sort: [{ column: value.column, direction }] };
        await this.load();
        return;
      }
      default:
        return;
    }
  }

  private async load(): Promise<void> {
    try {
      const driver = this.options.manager.requireDriver(this.options.ref.connectionId);
      this.page = await driver.getTableData(this.options.ref, this.request);
      this.error = undefined;
    } catch (error) {
      this.page = undefined;
      const dbError = DbError.from(error, 'QUERY_ERROR');
      this.error = globalRedactor.redact(dbError.message);
      this.options.logger.error('Table viewer query failed.', { code: dbError.code });
    }
    this.panel.webview.html = renderPage(this.page, this.request, this.options.title, this.error);
  }

  dispose(): void {
    TableViewerPanel.open.delete(this.key);
  }
}
