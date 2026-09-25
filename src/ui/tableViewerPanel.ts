/**
 * Paginated table viewer built on the shared DataDock result webview (the
 * reference "Result View" chain): toolbar with search, export, refresh, cost
 * and pager, typed sortable headers, per-column filters, green index column.
 * The webview is a Vue 2 + umy-table bundle shipped from dist/webview (see
 * resultHost.ts / renderDataGridPage).
 *
 * Unlike the query result grid (client-side filtering of one fetched batch),
 * the table viewer pushes filters, sort, search and paging down to the driver
 * through `TableDataRequest`, so large tables stay server-side paginated. The
 * webview only sends navigation intents; every page is fetched by the extension
 * host, credentials never cross the webview boundary and identifiers remain
 * validated by the data layer.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/connectionManager';
import { DbError } from '../db/errors';
import type {
  EngineId,
  Logger,
  TableDataPage,
  TableDataRequest,
  TableFilter,
  TableRef,
  TableSort,
} from '../db/types';
import { globalRedactor } from '../util/redaction';
import type { GridCell, GridColumn, GridExportFormat, GridFilter } from './dataGrid/dataGridModel';
import { GRID_PAGE_SIZE, exportFileName, renderGridExport, serializeGridValue } from './dataGrid/dataGridModel';
import { renderDataGridPage, escapeHtml, type GridViewGrid } from './dataGrid/dataGridView';
import { panelIconUri, resultViewAssets, resultViewWebviewOptions } from './resultView/resultHost';

interface TableViewerOptions {
  readonly manager: ConnectionManager;
  readonly logger: Logger;
  readonly ref: TableRef;
  readonly engine?: EngineId;
  readonly title: string;
}

type TableViewerMessage =
  | { type: 'ready' }
  | { type: 'refresh'; search?: unknown }
  | { type: 'page'; offset: unknown }
  | { type: 'apply'; search?: unknown; filters?: unknown; sort?: unknown }
  | { type: 'export'; format?: unknown; target?: unknown };

const VALID_OPERATORS = new Set(['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL']);

/** Narrows untrusted webview filter JSON into `TableFilter`s for the driver. */
function toTableFilters(value: unknown): TableFilter[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const filters: TableFilter[] = [];
  for (const entry of value.slice(0, 10)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as { column?: unknown; operator?: unknown; value?: unknown };
    if (typeof candidate.column !== 'string' || typeof candidate.operator !== 'string') {
      continue;
    }
    if (!VALID_OPERATORS.has(candidate.operator)) {
      continue;
    }
    if (candidate.operator === 'IS NULL' || candidate.operator === 'IS NOT NULL') {
      filters.push({ column: candidate.column, operator: candidate.operator as TableFilter['operator'] });
      continue;
    }
    if (typeof candidate.value === 'string' && candidate.value.length <= 500) {
      filters.push({
        column: candidate.column,
        operator: candidate.operator as TableFilter['operator'],
        value: candidate.value,
      });
    }
  }
  return filters;
}

/** Narrows untrusted webview sort JSON. */
function toTableSort(value: unknown): TableSort[] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const candidate = value as { column?: unknown; direction?: unknown };
  if (typeof candidate.column !== 'string' || (candidate.direction !== 'asc' && candidate.direction !== 'desc')) {
    return undefined;
  }
  return [{ column: candidate.column, direction: candidate.direction }];
}

function toGridFilters(filters: readonly TableFilter[]): GridFilter[] {
  return filters.map((filter) => ({
    column: filter.column,
    operator: filter.operator,
    value: 'value' in filter && typeof filter.value === 'string' ? filter.value : undefined,
  }));
}

function exportFiltersFor(format: GridExportFormat): Record<string, string[]> {
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

export class TableViewerPanel {
  private static readonly open = new Map<string, TableViewerPanel>();

  private request: TableDataRequest = { offset: 0, limit: GRID_PAGE_SIZE, search: '' };
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
      resultViewWebviewOptions(),
    );
    panel.iconPath = panelIconUri();
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
        this.request = {
          ...this.request,
          offset: 0,
          search: typeof value.search === 'string' ? value.search.slice(0, 200) : this.request.search,
        };
        await this.load();
        return;
      case 'page': {
        const offset = typeof value.offset === 'number' && Number.isFinite(value.offset) ? Math.max(0, Math.floor(value.offset)) : 0;
        this.request = { ...this.request, offset };
        await this.load();
        return;
      }
      case 'apply': {
        const search = typeof value.search === 'string' ? value.search.slice(0, 200) : '';
        this.request = {
          ...this.request,
          offset: 0,
          search,
          filters: toTableFilters(value.filters),
          sort: toTableSort(value.sort),
        };
        await this.load();
        return;
      }
      case 'export': {
        const format: GridExportFormat =
          value.format === 'json' || value.format === 'sql' || value.format === 'markdown' ? value.format : 'csv';
        await this.export(value.target === 'editor', format);
        return;
      }
      default:
        return;
    }
  }

  /** Fetches the current page (server-side filters/sort) and repaints. */
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
    this.panel.webview.html = this.render();
  }

  private grid(): GridViewGrid {
    const page = this.page;
    const columns: GridColumn[] = (page?.columns ?? []).map((column) => ({ name: column.name, type: column.dataType }));
    const rows: GridCell[][] = (page?.rows ?? []).map((row) => row.map((value) => serializeGridValue(value)));
    return {
      id: 'table',
      table: this.options.ref.table,
      columns,
      rows,
      label: this.options.ref.table,
      status: this.error !== undefined ? 'error' : 'ok',
    };
  }

  private pageCount(): number {
    const page = this.page;
    if (!page) {
      return 1;
    }
    if (page.totalRows !== undefined) {
      return Math.max(1, Math.ceil(page.totalRows / Math.max(1, page.limit)));
    }
    return Math.floor(page.offset / Math.max(1, page.limit)) + (page.rows.length === page.limit ? 2 : 1);
  }

  private render(): string {
    if (this.error !== undefined && !this.page) {
      const nonce = randomBytes(16).toString('base64');
      const csp = [
        "default-src 'none'",
        `style-src 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`,
        "font-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ');
      return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="${csp}" /><title>DataDock Table</title></head><body><h1>${escapeHtml(this.options.title)}</h1><p class="error">${escapeHtml(this.error)}</p></body></html>`;
    }
    const view = {
      mode: 'table' as const,
      grids: [this.grid()],
      activeIndex: 0,
      engine: this.options.engine,
      filters: toGridFilters(this.request.filters ?? []),
      sort: this.request.sort?.[0],
      search: this.request.search,
      pageIndex: Math.floor(this.request.offset / Math.max(1, this.request.limit)),
      pageSize: this.request.limit,
      pageCount: this.pageCount(),
      totalRows: this.page?.totalRows,
      cost: `Page size ${this.request.limit}`,
    };
    return renderDataGridPage(resultViewAssets(this.panel.webview), view, this.options.title);
  }

  /** Exports the currently fetched page (host-side rendering). */
  private async export(toEditor: boolean, format: GridExportFormat): Promise<void> {
    const grid = this.grid();
    if (grid.rows.length === 0) {
      void vscode.window.showInformationMessage('Nothing to export: the current page has no rows.');
      return;
    }
    const content = renderGridExport(format, this.options.ref.table, grid.columns, grid.rows.map((row) => [...row]));
    if (content.trim() === '') {
      void vscode.window.showInformationMessage('Nothing to export.');
      return;
    }
    if (toEditor) {
      const document = await vscode.workspace.openTextDocument({
        content,
        language: format === 'json' ? 'json' : format === 'markdown' ? 'markdown' : 'plaintext',
      });
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(exportFileName(this.options.ref.table, format)),
      filters: exportFiltersFor(format),
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    void vscode.window.showInformationMessage(`DataDock: exported to ${target.fsPath}.`);
  }

  dispose(): void {
    TableViewerPanel.open.delete(this.key);
  }
}
