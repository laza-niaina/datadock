/**
 * Paginated table viewer built on the shared DataDock result webview (the
 * reference "Result View" chain): toolbar with search, export, refresh, cost
 * and pager, two-line sortable headers (name over SQL type), per-column
 * filters, every column coming straight from the driver. The webview is a
 * Vue 2 + umy-table bundle shipped from dist/webview (see resultHost.ts /
 * renderDataGridPage).
 *
 * Unlike the query result grid (client-side filtering of one fetched batch),
 * the table viewer pushes filters, sort, search and paging down to the driver
 * through `TableDataRequest`, so large tables stay server-side paginated. The
 * webview only sends navigation intents; every page is fetched by the extension
 * host, credentials never cross the webview boundary and identifiers remain
 * validated by the data layer.
 *
 * When the page is writable (primary key + writable profile) the webview can
 * also edit it: `update` / `delete` / `insert` messages carry a row index, a
 * column name and a text value, and this host turns them into
 * `RowChange`s keyed by the primary key. Every write echoes the revision of
 * the document it came from, runs serially, and is answered by a repaint (on
 * success) or a `write` message that leaves the editor open (on refusal).
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/connectionManager';
import { DbError } from '../db/errors';
import type {
  ColumnInfo,
  EngineId,
  Logger,
  TableDataPage,
  TableDataRequest,
  TableFilter,
  TableRef,
  TableSort,
} from '../db/types';
import { globalRedactor } from '../util/redaction';
import { isBinaryColumnType, parseEditValue, rowKeyOf } from '../db/rowEdit';
import type { GridCell, GridColumn, GridExportFormat, GridFilter } from './dataGrid/dataGridModel';
import { GRID_PAGE_SIZE, exportFileName, renderGridExport, serializeGridValue } from './dataGrid/dataGridModel';
import { renderDataGridPage, type GridViewGrid } from './dataGrid/dataGridView';
import { toEditIntent, type EditIntent } from './rowEditMessages';
import { compactGridSetting, writeCompactGridSetting } from './resultGridSettings';
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
  | { type: 'export'; format?: unknown; target?: unknown }
  | { type: 'copy'; text?: unknown }
  | { type: 'setCompact'; compact?: unknown }
  | { type: 'update'; revision?: unknown; row?: unknown; column?: unknown; value?: unknown }
  | { type: 'delete'; revision?: unknown; row?: unknown }
  | { type: 'insert'; revision?: unknown; values?: unknown };

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

/** Banner text for a completed insert, using the identity the driver reported. */
function insertNotice(identity: Record<string, unknown>): string {
  const keys = Object.keys(identity);
  if (keys.length !== 1) {
    return 'Row inserted.';
  }
  return `Row inserted. ${keys[0]} = ${String(identity[keys[0]])}.`;
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
  /** Counts page requests: only the newest answer is allowed to repaint. */
  private sequence = 0;
  /** Echo token for writes: bumped on every repaint, sent back by the webview. */
  private revision = 0;
  /** Writes run one after another, so two edits never race on one page. */
  private writes: Promise<void> = Promise.resolve();
  /** Banner carried by the repaint a successful write triggers, then dropped. */
  private writeNotice?: { kind: 'info' | 'error'; text: string };
  private disposed = false;

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
        // The document asks for content once, before the host ever painted
        // it. Every later boot comes from an html assignment we made (a tab
        // coming back, or an answer that already carries its data), so
        // fetching here again would repaint the page forever.
        if (this.page === undefined && this.error === undefined && !this.disposed) {
          await this.load();
        }
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
      case 'copy': {
        // Copy As payloads are rendered in the webview from displayed cells.
        const text = typeof value.text === 'string' ? value.text : '';
        if (text !== '') {
          await vscode.env.clipboard.writeText(text);
        }
        return;
      }
      case 'setCompact': {
        // Persist the density toggle; the webview already applied it locally.
        if (typeof value.compact === 'boolean') {
          await writeCompactGridSetting(value.compact);
        }
        return;
      }
      case 'update':
      case 'delete':
      case 'insert': {
        const intent = toEditIntent(value);
        if (intent) {
          this.queueWrite(() => this.applyIntent(intent));
        }
        return;
      }
      default:
        return;
    }
  }

  /** Fetches the current page (server-side filters/sort) and repaints. */
  private async load(): Promise<void> {
    const sequence = ++this.sequence;
    let page: TableDataPage | undefined;
    let error: string | undefined;
    try {
      const driver = this.options.manager.requireDriver(this.options.ref.connectionId);
      page = await driver.getTableData(this.options.ref, this.request);
    } catch (err) {
      const dbError = DbError.from(err, 'QUERY_ERROR');
      error = globalRedactor.redact(dbError.message);
      this.options.logger.error('Table viewer query failed.', { code: dbError.code });
    }
    // Two requests can be in flight (a sort that fires while a page loads):
    // the slower one is stale, and painting it would show data nobody asked
    // for any more.
    if (sequence !== this.sequence || this.disposed) {
      return;
    }
    this.page = page;
    this.error = error;
    if (page !== undefined) {
      // Every repaint makes the write token of the previous document stale.
      this.revision += 1;
    }
    this.panel.webview.html = this.render();
    // The notice only rides along with the repaint that carries it.
    this.writeNotice = undefined;
  }

  // --- row editing ------------------------------------------------------------

  /** Writes run one at a time: the next one waits for the previous repaint. */
  private queueWrite(work: () => Promise<void>): void {
    this.writes = this.writes.then(work).catch((error: unknown) => {
      const dbError = DbError.from(error, 'QUERY_ERROR');
      this.options.logger.error('Table row write failed.', { code: dbError.code });
    });
  }

  /**
   * The gate every write passes: the page must still be the one the message
   * came from (revision), and it must be writable at all (primary key plus a
   * profile that allows writes).
   */
  private gate(revision: number): { page: TableDataPage } | { error: string } {
    if (revision !== this.revision) {
      return { error: 'This view is out of date: refresh the table and try the edit again.' };
    }
    const page = this.page;
    if (!page) {
      return { error: 'The table data has not loaded yet.' };
    }
    if (!page.editable || page.primaryKey.length === 0) {
      return {
        error: 'This relation cannot be edited: it needs a primary key, and the connection must allow writes.',
      };
    }
    return { page };
  }

  private requireColumn(page: TableDataPage, name: string): ColumnInfo {
    const column = page.columns.find((candidate) => candidate.name === name);
    if (!column) {
      throw new DbError('CONFIG_ERROR', `Column '${name}' does not exist in this relation.`);
    }
    if (isBinaryColumnType(column.dataType)) {
      throw new DbError(
        'CONFIG_ERROR',
        `Column '${column.name}' stores binary data, which cannot be edited as text.`,
      );
    }
    return column;
  }

  /** Turns webview text into typed bind values, schema-checked one by one. */
  private requireValues(
    page: TableDataPage,
    values: Record<string, string | number | null>,
  ): Record<string, unknown> {
    const typed: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(values)) {
      const column = this.requireColumn(page, name);
      typed[name] = parseEditValue(column, raw);
    }
    return typed;
  }

  private async applyIntent(intent: EditIntent): Promise<void> {
    const gate = this.gate(intent.revision);
    if ('error' in gate) {
      this.postWriteError(new DbError('CONFIG_ERROR', gate.error));
      return;
    }
    const page = gate.page;
    try {
      const driver = this.options.manager.requireDriver(this.options.ref.connectionId);
      if (intent.kind === 'update') {
        if (!driver.updateRows) {
          throw new DbError('UNSUPPORTED_OPERATION', 'This engine does not support updating rows.');
        }
        const column = this.requireColumn(page, intent.column);
        const key = rowKeyOf(page, intent.row);
        const typed = parseEditValue(column, intent.value);
        const affected = await driver.updateRows(this.options.ref, [
          { key, values: { [column.name]: typed } },
        ]);
        // Affected rows counts changed rows on MySQL, so "0" also means the
        // value was already there; the wording covers both readings.
        await this.writeDone(
          affected > 0 ? 'Row updated.' : 'No change was written: the row may have been modified elsewhere.',
        );
        return;
      }
      if (intent.kind === 'delete') {
        if (!driver.deleteRows) {
          throw new DbError('UNSUPPORTED_OPERATION', 'This engine does not support deleting rows.');
        }
        const key = rowKeyOf(page, intent.row);
        const affected = await driver.deleteRows(this.options.ref, [key]);
        await this.writeDone(
          affected > 0 ? 'Row deleted.' : 'No row matched: it may already have been deleted.',
        );
        return;
      }
      if (!driver.insertRow) {
        throw new DbError('UNSUPPORTED_OPERATION', 'This engine does not support inserting rows.');
      }
      const values = this.requireValues(page, intent.values);
      if (Object.keys(values).length === 0) {
        throw new DbError('CONFIG_ERROR', 'Nothing to insert: every column is left to its default.');
      }
      const identity = await driver.insertRow(this.options.ref, values);
      await this.writeDone(insertNotice(identity));
    } catch (error) {
      this.postWriteError(error);
    }
  }

  /** Repaints with a banner that says what the write actually did. */
  private async writeDone(text: string): Promise<void> {
    this.writeNotice = { kind: 'info', text };
    await this.load();
  }

  /** Answers a refused write without repainting, so the editor keeps its text. */
  private postWriteError(error: unknown): void {
    const dbError = DbError.from(error, 'QUERY_ERROR');
    const message = globalRedactor.redact(dbError.message);
    this.options.logger.error('Table row write refused.', { code: dbError.code });
    void this.panel.webview.postMessage({ type: 'write', ok: false, message });
  }

  private grid(): GridViewGrid {
    const page = this.page;
    const columns: GridColumn[] = (page?.columns ?? []).map((column) => ({
      name: column.name,
      type: column.dataType,
      primaryKey: column.isPrimaryKey,
      foreignKey: column.isForeignKey,
      // Only what the insert form and the cell editor need to be honest about
      // NULL, defaults and columns no text box can round-trip.
      nullable: column.nullable || undefined,
      autoIncrement: column.isAutoIncrement || undefined,
      editable: isBinaryColumnType(column.dataType) ? false : undefined,
    }));
    const rows: GridCell[][] = (page?.rows ?? []).map((row) => row.map((value) => serializeGridValue(value)));
    return {
      id: 'table',
      table: this.options.ref.table,
      columns,
      rows,
      label: this.options.ref.table,
      status: this.error !== undefined ? 'error' : 'ok',
      // A failed page keeps the toolbar, the pager and the banner - the
      // message belongs above the grid, not instead of it.
      error: this.error,
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
      compact: compactGridSetting(),
      // Row editing: the token every write echoes back, the flag that arms the
      // editors, and the banner a successful write repaints with.
      revision: this.revision,
      editable: Boolean(this.page?.editable && (this.page?.primaryKey.length ?? 0) > 0),
      writeNotice: this.writeNotice,
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
    this.disposed = true;
    TableViewerPanel.open.delete(this.key);
  }
}
