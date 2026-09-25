/**
 * DataDock result webview application.
 *
 * One Vue 2 + umy-table app serves both panels (query results and the table
 * viewer), mirroring the reference "Database Client" result chain: tabbed
 * batches, compact toolbar (engine mark, search, columns, export, cost, pager),
 * and the reference grid look (35px rows, centered cells, green index column,
 * `(NULL)` cells).
 *
 * The webview receives its data once as a JSON island carved in the page shell
 * (`window.__DATADOCK_RESULT__`), keeps no credentials, and only posts
 * navigation/export intents back to the host:
 *
 *   - query mode: reveal / export
 *   - table mode: ready / refresh / page / apply / export
 *
 * Compiled by the second esbuild entry into dist/webview/resultApp.js (+ .css)
 * and executed under the strict page-shell CSP: no inline handlers, Vue is the
 * runtime build (no template compiler, no eval), and fonts are disabled, so the
 * vendored element-icons @font-face never loads.
 */

import Vue, { type CreateElement, type VNode } from 'vue';
import UmyTable from 'umy-table';
import 'umy-table/lib/theme-chalk/index.css';
import './resultApp.css';
import { getEngineIcon, iconChevron, iconClose, iconFunnel, iconRefresh, iconReveal } from '../icons';
import type { EngineId } from '../../db/types';

declare global {
  interface Window {
    __DATADOCK_RESULT__?: unknown;
    acquireVsCodeApi?: () => { postMessage(message: unknown): void };
  }
}

type GridCellValue = string | number | null;

interface GridColumnInit {
  readonly name: string;
  readonly type?: string;
}

interface GridViewGridInit {
  readonly id: string;
  readonly table: string;
  readonly label: string;
  readonly status: 'ok' | 'error' | 'mutation' | 'skipped';
  readonly error?: string;
  readonly durationMs?: number;
  readonly rowsAffected?: number;
  readonly statementSql?: string;
  readonly reveal?: { start: number; end: number };
  readonly truncated?: boolean;
  readonly columns: readonly GridColumnInit[];
  readonly rows: readonly (readonly GridCellValue[])[];
}

interface GridSortInit {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

interface QueryMetaInit {
  readonly connectionName: string;
  readonly database?: string;
  readonly statementCount: number;
  readonly executedCount: number;
  readonly durationMs: number;
  readonly hasError: boolean;
  readonly notices: readonly string[];
}

interface ResultInit {
  readonly mode: 'query' | 'table';
  readonly grids: readonly GridViewGridInit[];
  readonly activeIndex: number;
  readonly engine?: string;
  readonly filters?: readonly { column: string; operator: string; value?: string }[];
  readonly sort?: GridSortInit;
  readonly search?: string;
  readonly pageIndex?: number;
  readonly pageSize?: number;
  readonly pageCount?: number;
  readonly totalRows?: number;
  readonly cost?: string;
  readonly query?: QueryMetaInit;
}

type GridFormat = 'csv' | 'json' | 'sql' | 'markdown';
const FORMATS: readonly GridFormat[] = ['csv', 'json', 'sql', 'markdown'];
const OPERATORS = ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL'] as const;

// --- vscode bridge -----------------------------------------------------------

function postMessage(message: unknown): void {
  window.acquireVsCodeApi?.()?.postMessage(message);
}

// --- local SVGs (geometric, currentColor, no glyph icons) ----------------------
const SEARCH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.6 10.6 14 14"/></svg>';
const DOWNLOAD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v7"/><path d="M5 6.5l3 3 3-3"/><path d="M3.5 12.5h9"/></svg>';
const COLUMNS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="3.2" height="10" rx="0.7"/><rect x="6.4" y="3" width="3.2" height="10" rx="0.7"/><rect x="9.8" y="3" width="3.2" height="10" rx="0.7"/></svg>';

/** Geometric icon wrapper: a span carrying the inline SVG (never an icon font). */
function iconVNode(h: CreateElement, svg: string, className?: string): VNode {
  const classes = className ? ['dd-icon', className] : 'dd-icon';
  return h('span', { class: classes, domProps: { innerHTML: svg } });
}

// --- data helpers --------------------------------------------------------------

/** Column metadata with a unique row-key per column (duplicate names → `name__N`). */
interface Field {
  readonly field: string;
  readonly name: string;
  readonly type?: string;
}

function fieldsFor(columns: readonly GridColumnInit[]): Field[] {
  const seen = new Map<string, number>();
  return columns.map((column) => {
    const count = seen.get(column.name) ?? 0;
    seen.set(column.name, count + 1);
    return count === 0
      ? { field: column.name, name: column.name, type: column.type }
      : { field: `${column.name}__${count}`, name: column.name, type: column.type };
  });
}

function rowsFor(grid: GridViewGridInit, fields: readonly Field[]): Record<string, GridCellValue>[] {
  return grid.rows.map((cells) => {
    const row: Record<string, GridCellValue> = {};
    fields.forEach((field, index) => {
      row[field.field] = cells[index] ?? null;
    });
    return row;
  });
}

function compareCells(a: GridCellValue, b: GridCellValue): number {
  if (a == null) {
    return b == null ? 0 : 1;
  }
  if (b == null) {
    return -1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Reference computeWidth: max(name, first rows, type) x10, clamped [70, 150]. */
function computeWidth(field: Field, rows: readonly Record<string, GridCellValue>[]): number {
  let longest = field.name.length;
  if (field.type) {
    longest = Math.max(longest, field.type.length);
  }
  const limit = Math.min(rows.length, 10);
  for (let index = 0; index < limit; index += 1) {
    const value = rows[index][field.field];
    if (value != null) {
      longest = Math.max(longest, String(value).length);
    }
  }
  return Math.min(150, Math.max(70, longest * 10));
}

/** Extracts the cell value from the umy-table default slot scope. */
function readScopeValue(scope: unknown): GridCellValue {
  if (!scope || typeof scope !== 'object') {
    return null;
  }
  const candidate = scope as { row?: Record<string, unknown>; column?: { property?: unknown; field?: unknown; title?: unknown } };
  const column = candidate.column;
  if (!candidate.row || !column) {
    return null;
  }
  const rawKey =
    typeof column.property === 'string'
      ? column.property
      : typeof column.field === 'string'
        ? column.field
        : typeof column.title === 'string'
          ? column.title
          : undefined;
  if (!rawKey) {
    return null;
  }
  const value = candidate.row[rawKey];
  return value === null || value === undefined || typeof value === 'string' || typeof value === 'number' ? (value as GridCellValue) : null;
}

// --- init ----------------------------------------------------------------------

const initial = window.__DATADOCK_RESULT__;
const init: ResultInit =
  initial && typeof initial === 'object' ? (initial as ResultInit) : { mode: 'query', grids: [], activeIndex: 0 };
const isTableMode = init.mode === 'table';

// --- component types ------------------------------------------------------------

interface ClientSort {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

interface FilterRow {
  readonly column: string;
  readonly operator: string;
  readonly value: string;
}

interface FilterDraft {
  readonly column: string;
  operator: string;
  value: string;
}

interface PopoverRect {
  readonly left: number;
  readonly top: number;
}

interface DdData {
  active: number;
  search: string;
  hidden: string[];
  columnsOpen: boolean;
  exportOpen: boolean;
  exportFormat: GridFormat;
  filters: FilterRow[];
  sort?: GridSortInit;
  clientSort?: ClientSort;
  pageIndex: number;
  filterDraft?: FilterDraft;
  popoverRect?: PopoverRect;
  gridHostHeight: number;
}

interface DdMethods {
  remeasure(): void;
  onSearchInput(value: string): void;
  onSearchKeyup(event: KeyboardEvent): void;
  clearSearch(): void;
  toggleColumns(): void;
  toggleExport(): void;
  closePopovers(): void;
  toggleColumn(name: string, checked: boolean): void;
  chooseFormat(format: GridFormat): void;
  doExport(target: 'editor' | 'file'): void;
  revealSql(): void;
  refresh(): void;
  page(delta: number): void;
  openFilter(name: string, event: MouseEvent): void;
  setFilterOperator(operator: string): void;
  setFilterValue(value: string): void;
  applyFilter(): void;
  clearFilter(): void;
  applyQuery(): void;
  onSortChange(event: unknown): void;
  cellVNode(h: CreateElement, scope: unknown): VNode;
  renderHead(h: CreateElement): VNode | null;
  renderTabs(h: CreateElement): VNode | null;
  renderToolbar(h: CreateElement): VNode;
  renderBanner(h: CreateElement): VNode | null;
  renderGridHost(h: CreateElement): VNode;
  renderGrid(h: CreateElement): VNode;
  renderColumnHeader(h: CreateElement, field: Field): VNode;
  renderColumnsPopover(h: CreateElement): VNode;
  renderExportPopover(h: CreateElement): VNode;
  renderFilterPopover(h: CreateElement): VNode;
  renderPopovers(h: CreateElement): VNode;
}

interface DdComputed {
  grid: GridViewGridInit | null;
  fields: Field[];
  allRows: Record<string, GridCellValue>[];
  activeFields: Field[];
  displayRows: Record<string, GridCellValue>[];
  engineMark: string;
  banner: { kind: 'error' | 'info'; text: string } | null;
  canExportSql: boolean;
  showReveal: boolean;
  pagerLabel: string;
}

// --- component ------------------------------------------------------------------

const ResultApp = Vue.extend<DdData, DdMethods, DdComputed>({
  el: '#app',

  data(): DdData {
    return {
      active: Math.min(Math.max(0, init.activeIndex), Math.max(0, init.grids.length - 1)),
      search: init.search ?? '',
      hidden: [],
      columnsOpen: false,
      exportOpen: false,
      exportFormat: 'csv',
      filters: (init.filters ?? []).map((filter) => ({ column: filter.column, operator: filter.operator, value: filter.value ?? '' })),
      sort: init.sort,
      clientSort: undefined,
      pageIndex: init.pageIndex ?? 0,
      filterDraft: undefined,
      popoverRect: undefined,
      gridHostHeight: 300,
    };
  },

  mounted(): void {
    this.$nextTick(() => this.remeasure());
    window.addEventListener('resize', () => this.remeasure());
    if (isTableMode) {
      postMessage({ type: 'ready' });
    }
  },

  methods: {
    remeasure(): void {
      const host = this.$refs.gridHost;
      if (host instanceof HTMLElement) {
        this.gridHostHeight = Math.max(120, host.clientHeight);
      }
    },
    onSearchInput(value: string): void {
      this.search = value;
    },
    onSearchKeyup(event: KeyboardEvent): void {
      if (isTableMode && (event.key === 'Enter' || event.key === 'NumpadEnter')) {
        this.applyQuery();
      }
    },
    clearSearch(): void {
      this.search = '';
      if (isTableMode) {
        this.applyQuery();
      }
    },
    toggleColumns(): void {
      this.columnsOpen = !this.columnsOpen;
      this.exportOpen = false;
    },
    toggleExport(): void {
      this.exportOpen = !this.exportOpen;
      this.columnsOpen = false;
    },
    closePopovers(): void {
      this.columnsOpen = false;
      this.exportOpen = false;
      this.filterDraft = undefined;
      this.popoverRect = undefined;
    },
    toggleColumn(name: string, checked: boolean): void {
      this.hidden = checked ? this.hidden.filter((n) => n !== name) : [...this.hidden, name];
    },
    chooseFormat(format: GridFormat): void {
      this.exportFormat = format;
    },
    doExport(target: 'editor' | 'file'): void {
      const grid = this.grid;
      if (!grid) {
        return;
      }
      const message: Record<string, unknown> = { type: 'export', format: this.exportFormat, target };
      if (!isTableMode) {
        message.gridId = grid.id;
      }
      postMessage(message);
      this.exportOpen = false;
    },
    revealSql(): void {
      const reveal = this.grid?.reveal;
      if (reveal) {
        postMessage({ type: 'reveal', start: reveal.start, end: reveal.end });
      }
    },
    refresh(): void {
      postMessage({ type: 'refresh', search: this.search });
    },
    page(delta: number): void {
      const total = Math.max(0, (init.pageCount ?? 1) - 1);
      const next = Math.min(Math.max(0, this.pageIndex + delta), total);
      if (next === this.pageIndex) {
        return;
      }
      this.pageIndex = next;
      postMessage({ type: 'page', offset: next * (init.pageSize ?? 100) });
    },
    openFilter(name: string, event: MouseEvent): void {
      let left = 20;
      let top = 60;
      if (event.currentTarget instanceof HTMLElement) {
        const rect = event.currentTarget.getBoundingClientRect();
        left = rect.left;
        top = rect.bottom + 4;
      }
      const existing = this.filters.find((filter) => filter.column === name);
      this.filterDraft = { column: name, operator: existing?.operator ?? '=', value: existing?.value ?? '' };
      this.popoverRect = { left: Math.min(left, window.innerWidth - 260), top };
      this.columnsOpen = false;
      this.exportOpen = false;
    },
    setFilterOperator(operator: string): void {
      if (this.filterDraft) {
        this.filterDraft.operator = operator;
      }
    },
    setFilterValue(value: string): void {
      if (this.filterDraft) {
        this.filterDraft.value = value;
      }
    },
    applyFilter(): void {
      const draft = this.filterDraft;
      if (!draft) {
        return;
      }
      const rest = this.filters.filter((filter) => filter.column !== draft.column);
      const value = draft.value.trim();
      if (draft.operator === 'IS NULL' || draft.operator === 'IS NOT NULL') {
        this.filters = [...rest, { column: draft.column, operator: draft.operator, value: '' }];
      } else if (value !== '') {
        this.filters = [...rest, { column: draft.column, operator: draft.operator, value }];
      } else {
        this.filters = rest;
      }
      this.closePopovers();
      this.applyQuery();
    },
    clearFilter(): void {
      const draft = this.filterDraft;
      if (!draft) {
        return;
      }
      this.filters = this.filters.filter((filter) => filter.column !== draft.column);
      this.closePopovers();
      this.applyQuery();
    },
    applyQuery(): void {
      if (!isTableMode) {
        return;
      }
      this.pageIndex = 0;
      const filters = this.filters.map((filter) => ({
        column: filter.column,
        operator: filter.operator,
        value: filter.operator === 'IS NULL' || filter.operator === 'IS NOT NULL' ? undefined : filter.value,
      }));
      const sort = this.sort ? { column: this.sort.column, direction: this.sort.direction } : undefined;
      const message: Record<string, unknown> = { type: 'apply', search: this.search };
      if (filters.length > 0) {
        message.filters = filters;
      }
      if (sort) {
        message.sort = sort;
      }
      postMessage(message);
    },
    onSortChange(event: unknown): void {
      if (!event || typeof event !== 'object') {
        return;
      }
      const candidate = event as { prop?: unknown; column?: { property?: unknown; title?: unknown }; order?: unknown };
      const rawProp =
        typeof candidate.prop === 'string'
          ? candidate.prop
          : typeof candidate.column?.property === 'string'
            ? candidate.column.property
            : typeof candidate.column?.title === 'string'
              ? candidate.column.title
              : undefined;
      const order = candidate.order === 'asc' || candidate.order === 'desc' ? candidate.order : undefined;
      if (!rawProp) {
        return;
      }
      const field = this.fields.find((f) => f.field === rawProp);
      if (!field) {
        return;
      }
      if (isTableMode) {
        this.sort = order ? { column: field.name, direction: order } : undefined;
        this.applyQuery();
      } else {
        this.clientSort = order ? { column: field.field, direction: order } : undefined;
      }
    },
    cellVNode(h: CreateElement, scope: unknown): VNode {
      const value = readScopeValue(scope);
      const content: VNode =
        value == null ? h('span', { class: 'dd-null' }, '(NULL)') : h('span', {}, String(value));
      return h('div', { class: 'dd-cell' }, [content]);
    },

    renderHead(h: CreateElement): VNode | null {
      const query = init.query;
      if (init.mode !== 'query' || !query) {
        return null;
      }
      const parts: VNode[] = [];
      const push = (key: string, text: string, kind?: 'db' | 'error'): void => {
        if (parts.length > 0) {
          parts.push(h('span', { key: `sep-${key}`, class: 'dd-head-sep' }, '·'));
        }
        const data = kind === 'db' ? { key, class: 'dd-head-db' } : kind === 'error' ? { key, class: 'dd-head-error' } : { key };
        parts.push(h('span', data, text));
      };
      push('conn', query.connectionName, 'db');
      push('stmts', `${query.statementCount} statement(s)`);
      push('exec', `${query.executedCount} executed`);
      push('time', `${(query.durationMs / 1000).toFixed(2)} s total`);
      if (query.hasError) {
        push('err', 'one or more statements failed', 'error');
      }
      const out: VNode[] = [h('div', { class: 'dd-head-row' }, parts)];
      if (query.notices.length > 0) {
        out.push(h('ul', { class: 'dd-notices' }, query.notices.map((notice, index) => h('li', { key: String(index) }, notice))));
      }
      return h('div', { class: 'dd-head' }, out);
    },

    renderTabs(h: CreateElement): VNode | null {
      if (init.mode !== 'query' || init.grids.length <= 1) {
        return null;
      }
      const tabs: VNode[] = init.grids.map((grid, index) => {
        const statusClass =
          grid.status === 'error' ? 'is-error' : grid.status === 'mutation' ? 'is-mutation' : grid.status === 'skipped' ? 'is-skipped' : '';
        const inner: VNode[] = [];
        if (statusClass !== '') {
          inner.push(h('span', { key: 'mark', class: ['dd-tab-mark', statusClass] }));
        }
        inner.push(h('span', { key: 'label' }, grid.label));
        return h(
          'button',
          {
            key: grid.id,
            class: ['dd-tab', this.active === index ? 'is-active' : ''],
            attrs: {
              role: 'tab',
              'aria-selected': this.active === index ? 'true' : 'false',
              title: grid.statementSql ?? grid.label,
            },
            on: { click: () => { this.active = index; } },
          },
          inner,
        );
      });
      return h('nav', { class: 'dd-tabs', attrs: { role: 'tablist' } }, tabs);
    },

    renderToolbar(h: CreateElement): VNode {
      const parts: VNode[] = [];
      if (this.engineMark !== '') {
        parts.push(
          h('span', {
            class: 'dd-engine',
            attrs: { title: init.engine ?? '' },
            domProps: { innerHTML: this.engineMark },
          }),
        );
      }
      parts.push(
        h('div', { class: 'dd-search' }, [
          iconVNode(h, SEARCH_SVG, 'dd-search-icon'),
          h('input', {
            attrs: { type: 'text', placeholder: 'Input To Search Data', 'aria-label': 'Search data' },
            domProps: { value: this.search },
            on: {
              input: (event: Event) => this.onSearchInput((event.target as HTMLInputElement).value),
              keyup: (event: KeyboardEvent) => this.onSearchKeyup(event),
            },
          }),
          this.search !== ''
            ? h(
                'button',
                {
                  class: 'dd-search-clear',
                  attrs: { type: 'button', title: 'Clear search', 'aria-label': 'Clear search' },
                  on: { click: () => this.clearSearch() },
                },
                [iconVNode(h, iconClose())],
              )
            : null,
        ]),
      );
      if (!isTableMode) {
        parts.push(
          h(
            'button',
            {
              class: ['dd-btn', this.columnsOpen ? 'is-active' : ''],
              attrs: { type: 'button', title: 'Select columns to show', 'aria-label': 'Select columns to show' },
              on: { click: () => this.toggleColumns() },
            },
            [iconVNode(h, COLUMNS_SVG)],
          ),
        );
      }
      parts.push(
        h(
          'button',
          {
            class: ['dd-btn', this.exportOpen ? 'is-active' : ''],
            attrs: { type: 'button', title: 'Export', 'aria-label': 'Export' },
            on: { click: () => this.toggleExport() },
          },
          [iconVNode(h, DOWNLOAD_SVG)],
        ),
      );
      if (this.showReveal) {
        parts.push(
          h(
            'button',
            {
              class: 'dd-btn',
              attrs: { type: 'button', title: 'Open in SQL file', 'aria-label': 'Open in SQL file' },
              on: { click: () => this.revealSql() },
            },
            [iconVNode(h, iconReveal())],
          ),
        );
      }
      if (isTableMode) {
        parts.push(
          h(
            'button',
            {
              class: 'dd-btn',
              attrs: { type: 'button', title: 'Refresh', 'aria-label': 'Refresh' },
              on: { click: () => this.refresh() },
            },
            [iconVNode(h, iconRefresh())],
          ),
        );
      }
      parts.push(h('span', { class: 'dd-spacer' }));
      if (init.cost) {
        parts.push(h('span', { class: 'dd-cost' }, init.cost));
      }
      if (isTableMode) {
        parts.push(
          h('div', { class: 'dd-pager' }, [
            h(
              'button',
              {
                class: 'dd-btn',
                attrs: { type: 'button', title: 'Previous page', 'aria-label': 'Previous page' },
                on: { click: () => this.page(-1) },
              },
              [iconVNode(h, iconChevron('left'))],
            ),
            h('span', {}, this.pagerLabel),
            h(
              'button',
              {
                class: 'dd-btn',
                attrs: { type: 'button', title: 'Next page', 'aria-label': 'Next page' },
                on: { click: () => this.page(1) },
              },
              [iconVNode(h, iconChevron('right'))],
            ),
          ]),
        );
      }
      return h('div', { class: 'dd-toolbar' }, parts);
    },

    renderBanner(h: CreateElement): VNode | null {
      const banner = this.banner;
      if (!banner) {
        return null;
      }
      return h(
        'div',
        { class: ['dd-banner', banner.kind === 'error' ? 'dd-banner-error' : 'dd-banner-info'] },
        banner.text,
      );
    },

    renderGridHost(h: CreateElement): VNode {
      const grid = this.grid;
      const content: VNode = grid
        ? h('transition', { props: { name: 'dd-fade', mode: 'out-in' } }, [
            h('div', { key: grid.id }, [this.renderGrid(h)]),
          ])
        : h('div', { key: 'empty', class: 'dd-empty' }, 'No results.');
      return h('div', { class: 'dd-grid-host', ref: 'gridHost' }, [content]);
    },

    renderGrid(h: CreateElement): VNode {
      const rows = this.allRows;
      const columns: VNode[] = [
        h('ux-table-column', { props: { type: 'index', width: 40, align: 'center', headerAlign: 'center' } }),
      ];
      for (const field of this.activeFields) {
        const header = this.renderColumnHeader(h, field);
        columns.push(
          h('ux-table-column', {
            props: {
              field: field.field,
              title: field.name,
              width: computeWidth(field, rows),
              sortable: true,
              resizable: true,
              align: 'center',
              headerAlign: 'center',
            },
            scopedSlots: {
              header: () => [header],
              default: (scope: unknown) => [this.cellVNode(h, scope)],
            },
          }),
        );
      }
      return h(
        'ux-grid',
        {
          props: {
            data: this.displayRows,
            height: this.gridHostHeight,
            stripe: true,
            size: 'small',
            cellStyle: { height: '35px' },
          },
          on: { 'sort-change': (event: unknown) => this.onSortChange(event) },
        },
        columns,
      );
    },

    renderColumnHeader(h: CreateElement, field: Field): VNode {
      const title = field.type ? `${field.name} (${field.type})` : field.name;
      const parts: VNode[] = [h('span', { class: 'dd-col-name' }, field.name)];
      if (field.type) {
        parts.push(h('span', { class: 'dd-col-type' }, field.type));
      }
      if (isTableMode) {
        parts.push(
          h(
            'button',
            {
              class: ['dd-btn', 'dd-col-filter'],
              attrs: { type: 'button', title: `Filter ${field.name}`, 'aria-label': `Filter ${field.name}` },
              on: { click: (event: MouseEvent) => this.openFilter(field.name, event) },
            },
            [iconVNode(h, iconFunnel())],
          ),
        );
      }
      return h('div', { class: 'dd-col-header', attrs: { title } }, parts);
    },

    renderColumnsPopover(h: CreateElement): VNode {
      const items: VNode[] = this.fields.map((field) => {
        const checked = !this.hidden.includes(field.name);
        return h('label', { key: field.field }, [
          h('input', {
            attrs: { type: 'checkbox' },
            domProps: { checked },
            on: { change: (event: Event) => this.toggleColumn(field.name, (event.target as HTMLInputElement).checked) },
          }),
          h('span', {}, field.name),
        ]);
      });
      return h('div', { class: 'dd-popover', style: { right: '10px', top: '36px' } }, [
        h('p', { class: 'dd-popover-title' }, 'Select columns to show'),
        h('div', { class: 'dd-col-list' }, items),
      ]);
    },

    renderExportPopover(h: CreateElement): VNode {
      const chips: VNode[] = FORMATS.map((format) => {
        const disabled = format === 'sql' && !this.canExportSql;
        return h(
          'button',
          {
            key: format,
            class: ['dd-chip', this.exportFormat === format ? 'is-selected' : ''],
            attrs: { type: 'button', disabled },
            on: { click: () => this.chooseFormat(format) },
          },
          format.toUpperCase(),
        );
      });
      return h('div', { class: 'dd-popover', style: { right: '10px', top: '36px' } }, [
        h('p', { class: 'dd-popover-title' }, 'Export'),
        h('div', { class: 'dd-chips' }, chips),
        h('div', { class: 'dd-popover-actions' }, [
          h('button', { class: 'dd-btn-primary', attrs: { type: 'button' }, on: { click: () => this.doExport('editor') } }, 'Export to Editor'),
          h('button', { class: 'dd-btn-secondary', attrs: { type: 'button' }, on: { click: () => this.doExport('file') } }, 'Save File'),
        ]),
      ]);
    },

    renderFilterPopover(h: CreateElement): VNode {
      const draft = this.filterDraft;
      if (!draft) {
        return h('div', {}, []);
      }
      const rect = this.popoverRect ?? { left: 20, top: 60 };
      const noValue = draft.operator === 'IS NULL' || draft.operator === 'IS NOT NULL';
      const valueField: VNode = noValue
        ? h('p', {}, 'No value needed.')
        : h('input', {
            attrs: { type: 'text', placeholder: 'Value', 'aria-label': 'Value' },
            domProps: { value: draft.value },
            on: {
              input: (event: Event) => this.setFilterValue((event.target as HTMLInputElement).value),
              keyup: (event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === 'NumpadEnter') {
                  this.applyFilter();
                }
              },
            },
          });
      return h('div', { class: 'dd-popover', style: { left: `${rect.left}px`, top: `${rect.top}px` } }, [
        h('p', { class: 'dd-popover-title' }, `Filter ${draft.column}`),
        h('div', { class: 'dd-filter-form' }, [
          h(
            'select',
            {
              attrs: { 'aria-label': 'Operator' },
              domProps: { value: draft.operator },
              on: { change: (event: Event) => this.setFilterOperator((event.target as HTMLSelectElement).value) },
            },
            OPERATORS.map((op) => h('option', { key: op, domProps: { value: op } }, op)),
          ),
          valueField,
          h('div', { class: 'dd-popover-actions' }, [
            h('button', { class: 'dd-btn-secondary', attrs: { type: 'button' }, on: { click: () => this.clearFilter() } }, 'Clear'),
            h('button', { class: 'dd-btn-primary', attrs: { type: 'button' }, on: { click: () => this.applyFilter() } }, 'Apply'),
          ]),
        ]),
      ]);
    },

    renderPopovers(h: CreateElement): VNode {
      const parts: VNode[] = [];
      if (this.columnsOpen || this.exportOpen || this.filterDraft !== undefined) {
        parts.push(
          h('div', { class: 'dd-popover-backdrop', on: { click: () => this.closePopovers() } }),
        );
      }
      if (this.columnsOpen) {
        parts.push(this.renderColumnsPopover(h));
      }
      if (this.exportOpen) {
        parts.push(this.renderExportPopover(h));
      }
      if (this.filterDraft) {
        parts.push(this.renderFilterPopover(h));
      }
      return h('div', {}, parts);
    },
  },

  computed: {
    grid(): GridViewGridInit | null {
      return init.grids[this.active] ?? null;
    },
    fields(): Field[] {
      return this.grid ? fieldsFor(this.grid.columns) : [];
    },
    allRows(): Record<string, GridCellValue>[] {
      const grid = this.grid;
      return grid ? rowsFor(grid, this.fields) : [];
    },
    activeFields(): Field[] {
      return this.fields.filter((field) => !this.hidden.includes(field.name));
    },
    displayRows(): Record<string, GridCellValue>[] {
      if (!isTableMode) {
        const term = this.search.trim().toLowerCase();
        let rows = this.allRows;
        if (term !== '') {
          rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(term));
        }
        const sort = this.clientSort;
        if (sort) {
          rows = rows.slice().sort((a, b) => {
            const cmp = compareCells(a[sort.column], b[sort.column]);
            return sort.direction === 'asc' ? cmp : -cmp;
          });
        }
        return rows;
      }
      return this.allRows;
    },
    engineMark(): string {
      return init.engine ? getEngineIcon(init.engine as EngineId).svg : '';
    },
    banner(): { kind: 'error' | 'info'; text: string } | null {
      const grid = this.grid;
      if (!grid) {
        return null;
      }
      if (grid.status === 'error') {
        return { kind: 'error', text: grid.error || 'Statement failed.' };
      }
      if (grid.status === 'skipped') {
        return { kind: 'info', text: 'Skipped: an earlier statement in the batch failed.' };
      }
      if (grid.status === 'mutation') {
        return {
          kind: 'info',
          text: grid.rowsAffected != null ? `${grid.rowsAffected} row(s) affected.` : 'Statement executed.',
        };
      }
      if (init.mode === 'query' && grid.rows.length === 0) {
        return { kind: 'info', text: 'No data.' };
      }
      if (grid.truncated) {
        return { kind: 'info', text: `Showing the first ${grid.rows.length} rows.` };
      }
      return null;
    },
    canExportSql(): boolean {
      return (this.grid?.table ?? '').length > 0;
    },
    showReveal(): boolean {
      return init.mode === 'query' && this.grid?.reveal !== undefined && this.grid.reveal !== null;
    },
    pagerLabel(): string {
      const pageCount = Math.max(1, init.pageCount ?? 1);
      const label = `Page ${this.pageIndex + 1} of ${pageCount}`;
      return init.totalRows != null ? `${label} · ${init.totalRows} rows` : label;
    },
  },

  render(h: CreateElement): VNode {
    const parts: VNode[] = [];
    const head = this.renderHead(h);
    if (head) {
      parts.push(head);
    }
    const tabs = this.renderTabs(h);
    if (tabs) {
      parts.push(tabs);
    }
    parts.push(this.renderToolbar(h));
    const banner = this.renderBanner(h);
    if (banner) {
      parts.push(banner);
    }
    parts.push(this.renderGridHost(h));
    parts.push(this.renderPopovers(h));
    return h('div', { class: 'dd-root' }, parts);
  },
});

Vue.use(UmyTable);
new ResultApp();