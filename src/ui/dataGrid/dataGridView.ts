/**
 * Shared HTML/CSS/client-script renderer for the DataDock data grid.
 *
 * Copies the reference "Result View" design: a compact toolbar (search, clear
 * filters, transpose, Export, cost, pager, total), typed column headers with
 * sort arrows and filter buttons, a row-number gutter with expandable row
 * details, a cell context menu (Copy / Copy Row as INSERT / Filter by value),
 * filter chips, and the Export Option dialog (CSV / JSON / SQL / Markdown with
 * Close / Export To Editor / Export).
 *
 * Security notes (both panels share these guarantees):
 *  - every dynamic string is HTML-escaped before it enters the page;
 *  - embedded row data is JSON-serialised `GridCell` values only, with `<`
 *    escaped so no `</script>` sequence can break out of the data island;
 *  - the page keeps a strict CSP with per-render nonces and no remote loads;
 *  - the webview posts navigation/export intents only; the host resolves them.
 */

import { randomBytes } from 'node:crypto';
import type { GridCell, GridColumn, GridFilter, GridSort, GridExportFormat } from './dataGridModel';
import { GRID_PAGE_SIZE } from './dataGridModel';

/** One grid the page can show (query batches have several, tables one). */
export interface GridViewGrid {
  /** Stable id used by the client script and export messages. */
  readonly id: string;
  /** Unqualified table name used for SQL INSERT exports ('' disables SQL). */
  readonly table: string;
  readonly columns: readonly GridColumn[];
  readonly rows: readonly GridCell[][];
  /** Short tab label, e.g. `#1`. */
  readonly label: string;
  /** Tab status: `ok`, `error` or `mutation`. */
  readonly status: 'ok' | 'error' | 'mutation' | 'skipped';
  /** Redacted driver error message shown in the error box. */
  readonly error?: string;
  /** Statement duration for the tab tooltip. */
  readonly durationMs?: number;
  /** Affected-rows count for mutation results. */
  readonly rowsAffected?: number;
  /** Query text shown in the SQL strip above the grid (query mode). */
  readonly statementSql?: string;
  /** Reveal offsets handed back to the host (query mode). */
  readonly reveal?: { start: number; end: number };
  readonly truncated?: boolean;
}

export type DataGridMode = 'query' | 'table';

export interface DataGridViewOptions {
  readonly mode: DataGridMode;
  readonly grids: readonly GridViewGrid[];
  /** Index of the initially visible grid. */
  readonly activeIndex: number;
  /** Filters already applied host-side (table mode) or client-side (query). */
  readonly filters?: readonly GridFilter[];
  readonly sort?: GridSort;
  readonly search?: string;
  /** 0-based page index for the pager display (table mode). */
  readonly pageIndex?: number;
  readonly pageCount?: number;
  /** Total row count across pages when known (table mode `Total`). */
  readonly totalRows?: number;
  /** Static toolbar duration text, e.g. `Cost: 12ms`. */
  readonly cost?: string;
  readonly exportFormats?: readonly GridExportFormat[];
}

/** Extracts a short table name for SQL INSERT exports from a query. */
export function tableFromStatement(sql: string): string {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*\n/g, '\n')
    .replace(/\s+/g, ' ');
  // Accepts `quoted names` (with spaces), schema-qualified names and bare ones.
  const tablePattern = /(?:`([^`]+)`|(?:(?:[\w$]+|`[^`]+`)\.)?(?:`([^`]+)`|([A-Za-z_][\w$]*)))/.source;
  const from = new RegExp(`\\bFROM\\s+${tablePattern}`, 'i').exec(withoutComments);
  if (from) {
    return from[1] ?? from[2] ?? from[3] ?? '';
  }
  const into = new RegExp(`\\bINTO\\s+${tablePattern}`, 'i').exec(withoutComments);
  return into ? into[1] ?? into[2] ?? into[3] ?? '' : '';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON safe for embedding inside a `<script>` island. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, (m) => `\\u${m.charCodeAt(0).toString(16)}`);
}

export function gridStyles(nonce: string): string {
  return `<style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
      line-height: 1.4;
    }
    button { font-family: inherit; font-size: inherit; }
    .sql-strip {
      position: relative;
      padding: 8px 14px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 120px;
      overflow: auto;
    }
    .sql-strip #reveal-btn { position: absolute; right: 8px; top: 6px; }
    .sql-strip .kw { color: var(--vscode-symbolKeywordForeground, #c586c0); }
    .sql-strip .num { color: var(--vscode-symbolConstantForeground, #b5cea8); }
    .sql-strip .str { color: var(--vscode-symbolStringForeground, #ce9178); }
    .toolbar {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 6px 14px;
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      position: sticky; top: 0; z-index: 30;
    }
    .tb { display: inline-flex; align-items: center; gap: 4px; }
    .icon-btn {
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      background: transparent; border: 0; border-radius: 4px;
      padding: 3px 6px; cursor: pointer; line-height: 1;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
    .icon-btn.active { color: var(--vscode-focusBorder); }
    .search-wrap { position: relative; display: inline-flex; align-items: center; }
    .search-wrap::before {
      content: ''; position: absolute; left: 8px; width: 9px; height: 9px; pointer-events: none;
      border: 1.5px solid var(--vscode-descriptionForeground); border-radius: 50%; opacity: .55;
    }
    .search-wrap::after {
      content: ''; position: absolute; left: 16px; top: 13px; width: 4px; height: 1.5px; pointer-events: none;
      background: var(--vscode-descriptionForeground); transform: rotate(45deg); opacity: .55;
    }
    #grid-search {
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
      padding: 4px 8px 4px 28px; min-width: 200px; width: 260px;
    }
    #grid-search:focus { outline: 1px solid var(--vscode-focusBorder); }
    .export-btn {
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer;
    }
    .export-btn:hover { background: var(--vscode-button-hoverBackground); }
    .cost, .total { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    .pager { display: inline-flex; align-items: center; gap: 2px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 6px 14px 0; }
    .chip {
      display: inline-flex; align-items: center; gap: 5px;
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-focusBorder) 18%, var(--vscode-editorWidget-background));
      border: 1px solid var(--vscode-panel-border); border-radius: 12px;
      padding: 1px 4px 1px 9px; font-size: 12px;
    }
    .chip button { background: transparent; border: 0; color: inherit; cursor: pointer; padding: 0 3px; }
    .tabs { display: flex; gap: 2px; padding: 8px 14px 0; flex-wrap: wrap; }
    .tab {
      color: var(--vscode-foreground); background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border); border-bottom: 0;
      border-radius: 6px 6px 0 0; padding: 3px 12px; cursor: pointer; font-size: 12px;
    }
    .tab .dot { font-weight: 700; margin-right: 4px; }
    .tab[data-status="ok"] .dot { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    .tab[data-status="error"] .dot { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
    .tab[data-status="mutation"] .dot { color: var(--vscode-charts-blue, var(--vscode-focusBorder)); }
    .tab[data-status="skipped"] .dot { color: var(--vscode-descriptionForeground); }
    .tab.active { background: var(--vscode-editor-background); font-weight: 600; }
    .grid-scroll { overflow: auto; max-height: calc(100vh - 130px); border-top: 1px solid var(--vscode-panel-border); }
    table.grid { border-collapse: separate; border-spacing: 0; min-width: 100%; }
    .grid th, .grid td {
      border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border);
      padding: 4px 9px; text-align: left; vertical-align: top; white-space: pre-wrap; overflow-wrap: anywhere;
      max-width: 480px;
    }
    .grid th {
      position: sticky; top: 0; z-index: 10;
      background: var(--vscode-editorWidget-background);
      font-weight: 400;
    }
    .grid thead tr { height: 40px; }
    .col-head { display: flex; align-items: flex-start; gap: 3px; }
    .col-text { display: flex; flex-direction: column; cursor: pointer; min-width: 40px; }
    .col-name { font-weight: 600; color: var(--vscode-symbolPropertyForeground, var(--vscode-foreground)); }
    .col-type { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .col-btn {
      background: transparent; border: 0; color: var(--vscode-descriptionForeground);
      cursor: pointer; padding: 1px 2px; border-radius: 3px; font-size: 11px; line-height: 1.2;
    }
    .col-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
    .col-btn.active { color: var(--vscode-focusBorder); }
    .sort-mark { font-size: 10px; }
    .gutter { width: 58px; min-width: 58px; padding: 2px 4px !important; white-space: nowrap !important; }
    .gutter .rownum {
      display: inline-block; min-width: 26px; color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums; font-size: 11px; text-align: right;
    }
    .gutter .exp {
      background: transparent; border: 0; color: var(--vscode-descriptionForeground);
      cursor: pointer; padding: 0 4px; font-size: 11px;
    }
    .gutter .exp:hover { color: var(--vscode-foreground); }
    tr.row-detail > td { background: var(--vscode-editorWidget-background); padding: 6px 12px; }
    .detail-list { display: grid; grid-template-columns: minmax(90px, max-content) 1fr; gap: 2px 14px; margin: 0; }
    .detail-list dt { color: var(--vscode-descriptionForeground); font-weight: 600; }
    .detail-list dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.null, span.null { color: var(--vscode-descriptionForeground); font-style: italic; }
    td.empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 24px; }
    .truncated-note {
      color: var(--vscode-editorWarning-foreground); padding: 6px 14px; margin: 0;
      border-top: 1px solid var(--vscode-panel-border); font-size: 12px;
    }
    .skipped-note {
      color: var(--vscode-descriptionForeground); padding: 10px 14px; margin: 0;
      font-size: 12.5px;
    }
    .error-box {
      margin: 8px 14px; padding: 8px 12px; border-radius: 4px;
      border-left: 3px solid var(--vscode-errorForeground);
      background: color-mix(in srgb, var(--vscode-errorForeground) 8%, var(--vscode-editorWidget-background));
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .result-summary { margin: 0; padding: 10px 14px; color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); font-weight: 600; }
    .popup {
      position: fixed; z-index: 100; display: none;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 5px; box-shadow: 0 4px 14px rgba(0,0,0,.35);
      min-width: 170px; padding: 4px;
    }
    .popup.open { display: block; }
    .popup .mi {
      display: flex; align-items: center; gap: 7px; width: 100%;
      background: transparent; border: 0; color: var(--vscode-foreground);
      padding: 4px 10px; cursor: pointer; text-align: left; border-radius: 4px;
    }
    .popup .mi:hover { background: var(--vscode-menu-selectionBackground, rgba(128,128,128,.25)); }
    .popup .mi .glyph { width: 14px; text-align: center; color: var(--vscode-descriptionForeground); }
    .popup .sep { border-top: 1px solid var(--vscode-panel-border); margin: 4px 2px; }
    .popup .mi.sub { padding-left: 24px; }
    .filter-pop { padding: 8px; min-width: 210px; }
    .filter-pop label { display: block; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 6px 0 2px; }
    .filter-pop select, .filter-pop input {
      width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 3px 6px;
    }
    .filter-pop .row { display: flex; gap: 6px; margin-top: 9px; justify-content: flex-end; }
    .filter-pop .btn {
      border: 0; border-radius: 4px; padding: 3px 10px; cursor: pointer;
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    .filter-pop .btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .dialog-backdrop {
      position: fixed; inset: 0; z-index: 200; display: none;
      background: rgba(0,0,0,.45); align-items: center; justify-content: center;
    }
    .dialog-backdrop.open { display: flex; }
    .dialog {
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px; min-width: 380px; max-width: 520px; padding: 16px 18px;
      box-shadow: 0 8px 30px rgba(0,0,0,.5);
    }
    .dialog h3 { margin: 0 0 14px; font-size: 1rem; text-align: center; }
    .dialog .field-label { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 6px; }
    .seg { display: flex; gap: 0; border-radius: 5px; overflow: hidden; border: 1px solid var(--vscode-panel-border); width: max-content; }
    .seg button {
      border: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground);
      padding: 5px 14px; cursor: pointer; border-right: 1px solid var(--vscode-panel-border);
    }
    .seg button:last-child { border-right: 0; }
    .seg button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .dialog .opt { display: flex; align-items: center; gap: 7px; margin-top: 13px; font-size: 12.5px; }
    .dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .dialog .actions .btn {
      border: 0; border-radius: 4px; padding: 5px 13px; cursor: pointer;
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
    }
    .dialog .actions .btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .dialog .actions .btn:disabled { opacity: .45; cursor: default; }
    table.reverse thead { display: none; }
    table.reverse tbody { display: block; }
    table.reverse tr { display: block; margin-bottom: 10px; }
    table.reverse td { display: flex; border: 0 !important; padding: 1px 9px !important; }
    table.reverse td.gutter { display: none; }
    table.reverse td::before {
      content: attr(data-col); color: var(--vscode-descriptionForeground);
      font-weight: 600; min-width: 110px; flex: none; padding-right: 10px;
    }
    .filter-row {
      background: color-mix(in srgb, var(--vscode-focusBorder) 8%, var(--vscode-editorWidget-background));
    }
    .filter-input {
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 2px 6px;
      font-size: 12px;
      box-sizing: border-box;
    }
    .filter-input:focus { outline: 1px solid var(--vscode-focusBorder); }
  </style>`;
}

function filterButtonTitle(filters: readonly GridFilter[], column: string): string {
  return filters.some((filter) => filter.column === column) ? 'Edit filter (active)' : 'Filter';
}

function renderHeaders(grid: GridViewGrid, filters: readonly GridFilter[], sort: GridSort | undefined): string {
  const cells = grid.columns
    .map((column) => {
      const active = sort?.column === column.name;
      const mark = active ? `<span class="sort-mark">${sort?.direction === 'desc' ? '▼' : '▲'}</span>` : '';
      const filtered = filters.some((filter) => filter.column === column.name);
      return `<th data-col="${escapeHtml(column.name)}">
        <div class="col-head">
          <span class="col-text" data-sort-col="${escapeHtml(column.name)}" title="Sort by ${escapeHtml(column.name)}">
            <span class="col-name">${escapeHtml(column.name)} ${mark}</span>
            ${column.type ? `<span class="col-type">${escapeHtml(column.type)}</span>` : ''}
          </span>
          <button type="button" class="col-btn${filtered ? ' active' : ''}" data-filter-col="${escapeHtml(column.name)}" title="${escapeHtml(filterButtonTitle(filters, column.name))}">▽</button>
        </div>
      </th>`;
    })
    .join('');
  return `<thead><tr><th class="gutter"></th>${cells}</tr></thead>`;
}

function renderRows(grid: GridViewGrid, isQueryMode: boolean = false): string {
  const filterRow = isQueryMode && grid.columns.length > 0
    ? `<tr class="filter-row" data-filter-row="true"><td class="gutter"></td>${grid.columns
        .map((column) => `<td data-col="${escapeHtml(column.name)}"><input type="text" class="filter-input" data-filter-col="${escapeHtml(column.name)}" placeholder="Filter" title="Filter ${escapeHtml(column.name)}" /></td>`)
        .join('')}</tr>`
    : '';
  
  const body = grid.rows
    .map((row, rowIndex) => {
      const cells = grid.columns.map((column, index) => {
        const cell = row[index] ?? null;
        const dataCol = ` data-col="${escapeHtml(column.name)}"`;
        if (cell === null) {
          return `<td class="null"${dataCol}>NULL</td>`;
        }
        if (typeof cell === 'number') {
          return `<td class="num"${dataCol}>${cell}</td>`;
        }
        return `<td${dataCol}>${escapeHtml(cell)}</td>`;
      });
      return `<tr data-row="${rowIndex}"><td class="gutter"><span class="rownum">${rowIndex + 1}</span><button type="button" class="exp" data-expand="${rowIndex}" title="Show row details">›</button></td>${cells.join('')}</tr>`;
    })
    .join('');
  if (grid.rows.length === 0) {
    return `<tbody>${filterRow}<tr><td class="gutter"></td><td class="empty" colspan="${Math.max(1, grid.columns.length)}">No rows returned.</td></tr></tbody>`;
  }
  return `<tbody>${filterRow}${body}</tbody>`;
}

function chipRow(filters: readonly GridFilter[]): string {
  if (filters.length === 0) {
    return '<div class="chips" id="chips" hidden></div>';
  }
  const chips = filters
    .map(
      (filter) =>
        `<span class="chip" data-chip-col="${escapeHtml(filter.column)}">${escapeHtml(filter.column)} ${escapeHtml(filter.operator)}${filter.value !== undefined ? ` ${escapeHtml(filter.value)}` : ''}<button type="button" data-remove-chip="${escapeHtml(filter.column)}" title="Remove filter">✕</button></span>`,
    )
    .join('');
  return `<div class="chips" id="chips">${chips}</div>`;
}

function sqlStrip(grid: GridViewGrid): string {
  if (!grid.statementSql) {
    return '';
  }
  // Light keyword highlight; the text itself stays escaped.
  const highlighted = escapeHtml(grid.statementSql)
    .replace(/\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|LIMIT|OFFSET|AND|OR|NOT|NULL|AS|DISTINCT|HAVING|UNION|USE|SHOW|DESCRIBE|PRAGMA|EXPLAIN)\b/g, '<span class="kw">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="num">$1</span>')
    .replace(/(&#39;([^&]|&(?!#39;))*?&#39;)/g, '<span class="str">$1</span>');
  const revealBtn = grid.reveal
    ? `<button type="button" class="icon-btn" id="reveal-btn" data-reveal-start="${grid.reveal.start}" data-reveal-end="${grid.reveal.end}" title="Open in SQL file">⇱</button>`
    : '';
  return `<div class="sql-strip">${highlighted}${revealBtn}</div>`;
}

function renderToolbar(options: DataGridViewOptions): string {
  const tableMode = options.mode === 'table';
  const hasPager =
    options.mode === 'query' || (options.pageCount !== undefined && options.pageCount > 0);
  const pager = hasPager
    ? `<span class="pager" id="grid-pager"><button type="button" class="icon-btn" id="page-prev" title="Previous page"${(options.pageIndex ?? 0) <= 0 ? ' disabled' : ''}>‹</button><span id="page-indicator">${(options.pageIndex ?? 0) + 1} / ${options.pageCount ?? 1}</span><button type="button" class="icon-btn" id="page-next" title="Next page"${options.pageCount !== undefined && (options.pageIndex ?? 0) + 1 >= options.pageCount ? ' disabled' : ''}>›</button></span>`
    : '';
  const refresh = tableMode ? '<button type="button" class="icon-btn" id="refresh-btn" title="Refresh">⟳</button>' : '';
  const showTotal = tableMode ? options.totalRows !== undefined : true;
  return `<div class="toolbar">
    <span class="search-wrap"><input id="grid-search" type="search" placeholder="Search Results" value="${escapeHtml(options.search ?? '')}" /></span>
    <span class="tb">
      <button type="button" class="icon-btn" id="clear-filters" title="Clear filters">⨯</button>
      ${refresh}
      <button type="button" class="icon-btn" id="transpose-btn" title="Reverse (transposed) view">⇅</button>
      <button type="button" class="export-btn" id="export-open" title="Export">Export ▾</button>
    </span>
    ${options.cost ? `<span class="cost" id="cost">${escapeHtml(options.cost)}</span>` : ''}
    ${pager}
    ${showTotal ? `<span class="total" id="total">${options.totalRows !== undefined ? `Total ${options.totalRows}` : 'Total'}</span>` : ''}
  </div>${chipRow(options.filters ?? [])}`;
}

function renderTabs(options: DataGridViewOptions): string {
  if (options.grids.length <= 1) {
    return '';
  }
  const tabs = options.grids
    .map(
      (grid, index) =>
        `<button type="button" class="tab${index === options.activeIndex ? ' active' : ''}" data-tab="${index}" data-status="${grid.status}" title="${escapeHtml(`${grid.label} · ${grid.status}${grid.durationMs !== undefined ? ` · ${(grid.durationMs / 1000).toFixed(2)}s` : ''}`)}"><span class="dot">●</span>${escapeHtml(grid.label)}</button>`,
    )
    .join('');
  return `<div class="tabs" id="tabs">${tabs}</div>`;
}

function renderExportDialog(formats: readonly GridExportFormat[]): string {
  const list = formats.length > 0 ? formats : (['csv', 'json', 'sql', 'markdown'] as const);
  const buttons = list
    .map((format) => `<button type="button" data-format="${format}"${format === 'csv' ? ' class="active"' : ''}>${format === 'markdown' ? 'Markdown' : format.toUpperCase()}</button>`)
    .join('');
  return `<div class="dialog-backdrop" id="export-dialog">
    <div class="dialog" role="dialog" aria-label="Export Option">
      <h3>Export Option</h3>
      <div class="field-label">Type</div>
      <div class="seg" id="export-formats">${buttons}</div>
      <label class="opt"><input type="checkbox" id="export-all" checked /> Remove Pagination (export all fetched rows)</label>
      <div class="actions">
        <button type="button" class="btn" id="export-close">Close</button>
        <button type="button" class="btn" id="export-editor">Export To Editor</button>
        <button type="button" class="btn primary" id="export-file">Export</button>
      </div>
    </div>
  </div>`;
}

function renderPopups(): string {
  const operators = ['=', '!=', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL'];
  const operatorItems = operators
    .map((operator) => `<option value="${operator}">${operator}</option>`)
    .join('');
  const comparators = ['=', '>', '>=', '!=', '<=', '<', 'IS NULL', 'IS NOT NULL'];
  const comparatorItems = comparators
    .map((operator) => `<button type="button" class="mi" data-cmp="${operator}"><span class="glyph">→</span>Filter by ${operator} <span class="cmp-val"></span></button>`)
    .join('');
  return `<div class="popup" id="ctx-menu">
    <button type="button" class="mi" data-action="copy-cell"><span class="glyph">⧉</span>Copy</button>
    <button type="button" class="mi" data-action="copy-row"><span class="glyph">⧉</span>Copy Row (INSERT)</button>
    <div class="sep"></div>
    <button type="button" class="mi sub" data-action="filter-open"><span class="glyph">▽</span>Filter by …</button>
    ${comparatorItems}
  </div>
  <div class="popup filter-pop" id="filter-pop">
    <label>Column</label>
    <select id="filter-col">${''}</select>
    <label>Operator</label>
    <select id="filter-op">${operatorItems}</select>
    <label>Value</label>
    <input type="text" id="filter-value" />
    <div class="row">
      <button type="button" class="btn" id="filter-remove">Remove</button>
      <button type="button" class="btn primary" id="filter-apply">Apply</button>
    </div>
  </div>`;
}

function clientScript(nonce: string, options: DataGridViewOptions): string {
  const tableMode = options.mode === 'table';
  const pageSize = GRID_PAGE_SIZE;
  const data = {
    mode: options.mode,
    active: options.activeIndex,
    pageSize,
    filters: options.filters ?? [],
    sort: options.sort,
    pageIndex: options.pageIndex ?? 0,
  };
  return `<script nonce="${nonce}">
  (function () {
    // Degrade gracefully when the VS Code API is unavailable (plain browser):
    // rendering, client-side filtering and dialogs keep working, only host
    // intents (paging/export/reveal) become no-ops.
    var vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: function () {} };
    var DATA = ${jsonForScript(data)};
    var GRIDS = ${jsonForScript(options.grids)};
    var state = {
      active: DATA.active,
      filters: DATA.filters.slice(),
      sort: DATA.sort || undefined,
      search: ${jsonForScript(options.search ?? '')},
      reverse: false,
      page: DATA.pageIndex || 0
    };
    var PAGE_SIZE = ${pageSize};
    var TABLE_MODE = ${tableMode ? 'true' : 'false'};

    function activeGrid() { return GRIDS[state.active]; }
    function gridEl() { return document.querySelector('.grid-section[data-grid-index="' + state.active + '"]'); }
    function visibleRows(grid) {
      var rows = grid.rows;
      if (!TABLE_MODE) {
        rows = applySearch(rows);
        rows = applyFilters(rows);
        rows = applySort(rows);
      }
      return rows;
    }
    function applySearch(rows) {
      var needle = state.search.trim().toLowerCase();
      if (!needle) { return rows; }
      return rows.filter(function (row) {
        return row.some(function (cell) { return cell !== null && String(cell).toLowerCase().indexOf(needle) !== -1; });
      });
    }
    function columnIndexOf(name) {
      var grid = activeGrid();
      for (var i = 0; i < grid.columns.length; i++) { if (grid.columns[i].name === name) { return i; } }
      return -1;
    }
    function matches(cell, filter) {
      var raw = filter.value === undefined ? '' : String(filter.value);
      if (filter.operator === 'IS NULL') { return cell === null; }
      if (filter.operator === 'IS NOT NULL') { return cell !== null; }
      if (cell === null) { return false; }
      var asNum = typeof cell === 'number' ? cell : Number(cell);
      var cmpNum = Number(raw);
      var bothNum = isFinite(asNum) && raw.trim() !== '' && isFinite(cmpNum);
      switch (filter.operator) {
        case '=': return bothNum ? asNum === cmpNum : String(cell) === raw;
        case '!=': return bothNum ? asNum !== cmpNum : String(cell) !== raw;
        case '<': return bothNum ? asNum < cmpNum : String(cell) < raw;
        case '<=': return bothNum ? asNum <= cmpNum : String(cell) <= raw;
        case '>': return bothNum ? asNum > cmpNum : String(cell) > raw;
        case '>=': return bothNum ? asNum >= cmpNum : String(cell) >= raw;
        case 'LIKE': return like(cell, raw, false);
        case 'NOT LIKE': return like(cell, raw, true);
        default: return true;
      }
    }
    function like(cell, raw, negate) {
      var pattern = raw.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/%/g, '.*').replace(/_/g, '.');
      var hit = false;
      try { hit = new RegExp('^' + pattern + '$', 'i').test(String(cell)); } catch (e) { hit = String(cell).toLowerCase().indexOf(raw.toLowerCase()) !== -1; }
      return negate ? !hit : hit;
    }
    function applyFilters(rows) {
      if (!state.filters.length) { return rows; }
      return rows.filter(function (row) {
        return state.filters.every(function (filter) {
          var index = columnIndexOf(filter.column);
          return index < 0 ? true : matches(row[index] === undefined ? null : row[index], filter);
        });
      });
    }
    function compareCells(a, b) {
      if (a === null && b === null) { return 0; }
      if (a === null) { return -1; }
      if (b === null) { return 1; }
      var na = Number(a), nb = Number(b);
      if (isFinite(na) && isFinite(nb) && String(a).trim() !== '' && String(b).trim() !== '') { return na - nb; }
      return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    }
    function applySort(rows) {
      if (!state.sort) { return rows; }
      var index = columnIndexOf(state.sort.column);
      if (index < 0) { return rows; }
      var factor = state.sort.direction === 'desc' ? -1 : 1;
      return rows.slice().sort(function (a, b) { return factor * compareCells(a[index] === undefined ? null : a[index], b[index] === undefined ? null : b[index]); });
    }

    function renderGrid() {
      var grid = activeGrid();
      var section = gridEl();
      if (!section) { return; }
      var table = section.querySelector('table.grid');
      if (!table) { return; } // error / mutation / skipped sections carry no grid
      var rows = visibleRows(grid);
      var oldBody = table.querySelector('tbody');
      if (oldBody) { oldBody.remove(); }
      var tbody = document.createElement('tbody');
      if (rows.length === 0) {
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        td.className = 'gutter';
        var td2 = document.createElement('td');
        td2.className = 'empty';
        td2.colSpan = Math.max(1, grid.columns.length);
        td2.textContent = 'No rows returned.';
        tr.appendChild(td); tr.appendChild(td2);
        tbody.appendChild(tr);
      } else {
        rows.forEach(function (row, displayIndex) {
          var originalIndex = grid.rows.indexOf(row);
          var tr = document.createElement('tr');
          tr.setAttribute('data-row', String(originalIndex < 0 ? displayIndex : originalIndex));
          var gutter = document.createElement('td');
          gutter.className = 'gutter';
          var num = document.createElement('span');
          num.className = 'rownum';
          num.textContent = String(originalIndex < 0 ? displayIndex : originalIndex) + 1;
          var exp = document.createElement('button');
          exp.type = 'button';
          exp.className = 'exp';
          exp.setAttribute('data-expand', String(originalIndex < 0 ? displayIndex : originalIndex));
          exp.textContent = '›';
          exp.title = 'Show row details';
          gutter.appendChild(num); gutter.appendChild(exp);
          tr.appendChild(gutter);
          row.forEach(function (cell, columnIndex) {
            var td = document.createElement('td');
            var column = grid.columns[columnIndex];
            if (column) { td.setAttribute('data-col', column.name); }
            if (cell === null) { td.className = 'null'; td.textContent = 'NULL'; }
            else if (typeof cell === 'number') { td.className = 'num'; td.textContent = String(cell); }
            else { td.textContent = String(cell); }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
      }
      table.appendChild(tbody);
      table.classList.toggle('reverse', state.reverse);
      var count = rows.length;
      var pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
      if (state.page >= pages) { state.page = pages - 1; }
      if (!TABLE_MODE) {
        var start = state.page * PAGE_SIZE;
        Array.prototype.forEach.call(tbody.children, function (tr, index) {
          tr.style.display = index >= start && index < start + PAGE_SIZE ? '' : 'none';
        });
        updatePager(state.page + 1, pages, count);
      }
      updateSortMarks();
      updateChips();
    }

    function updatePager(current, pages, count) {
      var indicator = document.getElementById('page-indicator');
      if (indicator) { indicator.textContent = current + ' / ' + pages; }
      var pager = document.getElementById('grid-pager');
      if (pager) { pager.hidden = !TABLE_MODE && pages <= 1; }
      var prev = document.getElementById('page-prev');
      var next = document.getElementById('page-next');
      if (prev) { prev.disabled = current <= 1; }
      if (next) { next.disabled = current >= pages; }
      var total = document.getElementById('total');
      if (total && !TABLE_MODE) { total.textContent = 'Total ' + count; }
    }

    function updateSortMarks() {
      document.querySelectorAll('[data-sort-col]').forEach(function (el) {
        var name = el.getAttribute('data-sort-col');
        var th = el.closest('th');
        var old = th.querySelector('.sort-mark');
        if (old) { old.remove(); }
        if (state.sort && state.sort.column === name) {
          var span = document.createElement('span');
          span.className = 'sort-mark';
          span.textContent = state.sort.direction === 'desc' ? '▼' : '▲';
          el.querySelector('.col-name').appendChild(span);
        }
      });
    }

    function updateChips() {
      var wrap = document.getElementById('chips');
      if (!wrap) { return; }
      wrap.innerHTML = '';
      wrap.hidden = state.filters.length === 0;
      state.filters.forEach(function (filter) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = filter.column + ' ' + filter.operator + (filter.value !== undefined ? ' ' + filter.value : '');
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('data-remove-chip', filter.column);
        remove.textContent = '✕';
        remove.title = 'Remove filter';
        chip.appendChild(remove);
        wrap.appendChild(chip);
      });
    }

    function refreshFromHost(extra) {
      var message = Object.assign({ type: 'apply', search: state.search, filters: state.filters, sort: state.sort, offset: 0 }, extra || {});
      vscode.postMessage(message);
    }

    // -- events ------------------------------------------------------------
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) { return; }
      var tab = target.closest('[data-tab]');
      if (tab) {
        state.active = Number(tab.getAttribute('data-tab'));
        document.querySelectorAll('.tab').forEach(function (el) { el.classList.toggle('active', el === tab); });
        document.querySelectorAll('.grid-section').forEach(function (el) {
          el.style.display = Number(el.getAttribute('data-grid-index')) === state.active ? '' : 'none';
        });
        state.page = 0;
        renderGrid();
        return;
      }
      var sortEl = target.closest('[data-sort-col]');
      if (sortEl) {
        var column = sortEl.getAttribute('data-sort-col');
        var direction = state.sort && state.sort.column === column && state.sort.direction === 'asc' ? 'desc' : 'asc';
        state.sort = { column: column, direction: direction };
        if (TABLE_MODE) { refreshFromHost(); } else { state.page = 0; renderGrid(); }
        return;
      }
      var filterBtn = target.closest('[data-filter-col]');
      if (filterBtn) {
        openFilterPop(filterBtn.getAttribute('data-filter-col'), filterBtn);
        return;
      }
      var removeChip = target.closest('[data-remove-chip]');
      if (removeChip) {
        var colName = removeChip.getAttribute('data-remove-chip');
        state.filters = state.filters.filter(function (filter) { return filter.column !== colName; });
        if (TABLE_MODE) { refreshFromHost(); } else { state.page = 0; renderGrid(); }
        return;
      }
      var expand = target.closest('[data-expand]');
      if (expand) {
        toggleDetail(Number(expand.getAttribute('data-expand')));
        return;
      }
      if (target.id === 'clear-filters') {
        state.filters = [];
        if (TABLE_MODE) { refreshFromHost(); } else { state.page = 0; renderGrid(); }
        return;
      }
      if (target.id === 'transpose-btn') {
        state.reverse = !state.reverse;
        document.getElementById('transpose-btn').classList.toggle('active', state.reverse);
        renderGrid();
        return;
      }
      if (target.id === 'refresh-btn') {
        vscode.postMessage({ type: 'refresh', search: state.search });
        return;
      }
      if (target.id === 'page-prev') {
        if (TABLE_MODE) { vscode.postMessage({ type: 'page', offset: Math.max(0, (state.page - 1) * PAGE_SIZE) }); }
        else { state.page = Math.max(0, state.page - 1); renderGrid(); }
        return;
      }
      if (target.id === 'page-next') {
        if (TABLE_MODE) { vscode.postMessage({ type: 'page', offset: (state.page + 1) * PAGE_SIZE }); }
        else { state.page += 1; renderGrid(); }
        return;
      }
      if (target.id === 'export-open') {
        document.getElementById('export-dialog').classList.add('open');
        return;
      }
      if (target.id === 'export-close' || target.id === 'export-dialog') {
        document.getElementById('export-dialog').classList.remove('open');
        return;
      }
      var formatBtn = target.closest('[data-format]');
      if (formatBtn) {
        document.querySelectorAll('[data-format]').forEach(function (el) { el.classList.toggle('active', el === formatBtn); });
        return;
      }
      if (target.id === 'export-file' || target.id === 'export-editor') {
        var chosen = document.querySelector('[data-format].active');
        vscode.postMessage({
          type: 'export',
          format: chosen ? chosen.getAttribute('data-format') : 'csv',
          target: target.id === 'export-file' ? 'file' : 'editor',
          gridId: activeGrid().id,
          removePagination: document.getElementById('export-all').checked
        });
        document.getElementById('export-dialog').classList.remove('open');
        return;
      }
      if (target.id === 'reveal-btn') {
        vscode.postMessage({
          type: 'reveal',
          start: Number(target.getAttribute('data-reveal-start')),
          end: Number(target.getAttribute('data-reveal-end'))
        });
        return;
      }
      var cmp = target.closest('[data-cmp]');
      if (cmp) {
        addComparatorFilter(cmp.getAttribute('data-cmp'));
        hidePopups();
        return;
      }
      var action = target.closest('[data-action]');
      if (action) {
        var kind = action.getAttribute('data-action');
        if (kind === 'copy-cell') { copyText(ctxCellText()); }
        else if (kind === 'copy-row') { copyText(insertForContextRow()); }
        else if (kind === 'filter-open') { openFilterPop(ctxColumn(), ctxButton()); }
        hidePopups();
        return;
      }
      if (!target.closest('.popup')) { hidePopups(); }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        hidePopups();
        document.getElementById('export-dialog').classList.remove('open');
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault();
        document.getElementById('grid-search').focus();
      }
    });

    document.addEventListener('contextmenu', function (event) {
      var target = event.target;
      if (!(target instanceof Element)) { return; }
      var td = target.closest('td');
      if (!td || td.classList.contains('gutter') || td.classList.contains('empty')) { return; }
      event.preventDefault();
      var tr = td.closest('tr');
      ctx = {
        column: td.getAttribute('data-col') || '',
        cell: td.classList.contains('null') ? null : td.textContent,
        row: rowOf(tr),
        button: td
      };
      var menu = document.getElementById('ctx-menu');
      menu.querySelectorAll('[data-cmp]').forEach(function (el) {
        el.style.display = ctx.column ? '' : 'none';
        var valueSpan = el.querySelector('.cmp-val');
        if (valueSpan) { valueSpan.textContent = ctx.cell === null ? '' : String(ctx.cell); }
      });
      var rowInsert = menu.querySelector('[data-action="copy-row"]');
      if (rowInsert) { rowInsert.style.display = activeGrid().table ? '' : 'none'; }
      menu.classList.add('open');
      menu.style.left = Math.min(event.clientX, window.innerWidth - 220) + 'px';
      menu.style.top = Math.min(event.clientY, window.innerHeight - 260) + 'px';
    });

    var ctx = { column: '', cell: null, row: [], button: null };

    function rowOf(tr) {
      var index = Number(tr.getAttribute('data-row'));
      var grid = activeGrid();
      return grid.rows[index] || [];
    }
    function ctxCellText() { return ctx.cell === null ? '' : String(ctx.cell); }
    function sqlQuote(value) {
      return typeof value === 'number' ? String(value) : "'" + String(value).replace(/'/g, "''") + "'";
    }
    function insertForContextRow() {
      var grid = activeGrid();
      if (!grid.table) { return ctxCellText(); }
      var q = String.fromCharCode(96);
      var names = grid.columns.map(function (column) { return q + column.name.split(q).join(q + q) + q; }).join(', ');
      var values = grid.columns.map(function (column, index) { return sqlQuote(ctx.row[index] === undefined ? null : ctx.row[index]); }).join(', ');
      return 'INSERT INTO ' + q + grid.table.split(q).join(q + q) + q + ' (' + names + ') VALUES (' + values + ');';
    }
    function copyText(text) {
      navigator.clipboard.writeText(text).catch(function () {});
    }
    function addComparatorFilter(operator) {
      if (!ctx.column) { return; }
      var needsValue = operator !== 'IS NULL' && operator !== 'IS NOT NULL';
      var filter = { column: ctx.column, operator: operator };
      if (needsValue) { filter.value = ctxCellText(); }
      state.filters = state.filters.filter(function (existing) { return existing.column !== ctx.column; });
      state.filters.push(filter);
      if (TABLE_MODE) { refreshFromHost(); } else { state.page = 0; renderGrid(); }
    }

    function toggleDetail(rowIndex) {
      var grid = activeGrid();
      var row = grid.rows[rowIndex];
      var tr = gridEl().querySelector('tr[data-row="' + rowIndex + '"]');
      if (!tr || !row) { return; }
      var existing = tr.nextElementSibling;
      if (existing && existing.classList.contains('row-detail')) { existing.remove(); return; }
      var detail = document.createElement('tr');
      detail.className = 'row-detail';
      var td = document.createElement('td');
      td.colSpan = grid.columns.length + 1;
      var dl = document.createElement('dl');
      dl.className = 'detail-list';
      grid.columns.forEach(function (column, index) {
        var dt = document.createElement('dt');
        dt.textContent = column.name;
        var dd = document.createElement('dd');
        var cell = row[index] === undefined ? null : row[index];
        dd.textContent = cell === null ? 'NULL' : String(cell);
        if (cell === null) { dd.className = 'null'; }
        dl.appendChild(dt); dl.appendChild(dd);
      });
      td.appendChild(dl);
      detail.appendChild(td);
      tr.after(detail);
    }

    function hidePopups() {
      document.querySelectorAll('.popup').forEach(function (el) { el.classList.remove('open'); });
    }

    function openFilterPop(column, anchor) {
      var pop = document.getElementById('filter-pop');
      var colSelect = document.getElementById('filter-col');
      colSelect.innerHTML = '';
      activeGrid().columns.forEach(function (columnInfo) {
        var option = document.createElement('option');
        option.value = columnInfo.name;
        option.textContent = columnInfo.name;
        colSelect.appendChild(option);
      });
      colSelect.value = column;
      var existing = state.filters.find(function (filter) { return filter.column === column; });
      document.getElementById('filter-op').value = existing ? existing.operator : '=';
      document.getElementById('filter-value').value = existing && existing.value !== undefined ? existing.value : '';
      pop.classList.add('open');
      var rect = anchor.getBoundingClientRect();
      pop.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
      pop.style.top = Math.min(rect.bottom + 4, window.innerHeight - 220) + 'px';
    }

    document.getElementById('filter-apply').addEventListener('click', function () {
      var column = document.getElementById('filter-col').value;
      var operator = document.getElementById('filter-op').value;
      var value = document.getElementById('filter-value').value;
      var filter = { column: column, operator: operator };
      if (operator !== 'IS NULL' && operator !== 'IS NOT NULL') { filter.value = value; }
      state.filters = state.filters.filter(function (existing) { return existing.column !== column; });
      state.filters.push(filter);
      if (TABLE_MODE) { refreshFromHost(); } else { state.page = 0; renderGrid(); }
      hidePopups();
    });
    document.getElementById('filter-remove').addEventListener('click', function () {
      var column = document.getElementById('filter-col').value;
      state.filters = state.filters.filter(function (existing) { return existing.column !== column; });
      if (TABLE_MODE) { refreshFromHost(); } else { state.page = 0; renderGrid(); }
      hidePopups();
    });

    var searchTimer;
    document.getElementById('grid-search').addEventListener('input', function (event) {
      state.search = event.target.value;
      if (TABLE_MODE) {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { refreshFromHost(); }, 350);
      } else {
        state.page = 0;
        renderGrid();
      }
    });
    document.getElementById('grid-search').addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && TABLE_MODE) { refreshFromHost(); }
    });

    // Filter row inputs (query mode)
    if (!TABLE_MODE) {
      var filterInputs = document.querySelectorAll('.filter-input');
      filterInputs.forEach(function (input) {
        var filterTimer;
        input.addEventListener('input', function (event) {
          var column = input.getAttribute('data-filter-col');
          var value = input.value;
          clearTimeout(filterTimer);
          filterTimer = setTimeout(function () {
            if (value === '') {
              state.filters = state.filters.filter(function (f) { return f.column !== column; });
            } else {
              state.filters = state.filters.filter(function (f) { return f.column !== column; });
              state.filters.push({ column: column, operator: 'LIKE', value: '%' + value + '%' });
            }
            state.page = 0;
            renderGrid();
          }, 350);
        });
        input.addEventListener('keydown', function (event) {
          if (event.key === 'Enter') {
            clearTimeout(filterTimer);
            var column = input.getAttribute('data-filter-col');
            var value = input.value;
            if (value === '') {
              state.filters = state.filters.filter(function (f) { return f.column !== column; });
            } else {
              state.filters = state.filters.filter(function (f) { return f.column !== column; });
              state.filters.push({ column: column, operator: 'LIKE', value: '%' + value + '%' });
            }
            state.page = 0;
            renderGrid();
          }
        });
      });
    }

    renderGrid();
  }());
  </script>`;
}

/** Assembles the full standalone page used by the table viewer. */
export function renderDataGridPage(options: DataGridViewOptions, pageTitle: string): string {
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const sections = options.grids
    .map((grid, index) => {
      const hidden = index === options.activeIndex ? '' : ' style="display:none"';
      const error = grid.status === 'error' ? `<div class="error-box" role="alert">${escapeHtml(grid.error ?? 'Statement failed.')}</div>` : '';
      const truncated =
        grid.truncated && grid.status !== 'error'
          ? `<p class="truncated-note">Showing the first ${grid.rows.length} rows; more rows are available on the server.</p>`
          : '';
      return `<div class="grid-section" data-grid-index="${index}"${hidden}>
        ${sqlStrip(grid)}
        ${error}
        <div class="grid-scroll"><table class="grid">${renderHeaders(grid, options.filters ?? [], options.sort)}${renderRows(grid)}</table></div>
        ${truncated}
      </div>`;
    })
    .join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(pageTitle)}</title>
  ${gridStyles(nonce)}
</head>
<body>
  ${renderToolbar(options)}
  ${renderTabs(options)}
  ${sections}
  ${renderPopups()}
  ${renderExportDialog(options.exportFormats ?? ['csv', 'json', 'sql', 'markdown'])}
  ${clientScript(nonce, options)}
</body>
</html>`;
}

/**
 * Body fragment (no <html> shell) used inside the query result page.
 * `nonce` must be the page's own nonce: the CSP allows only that one value for
 * both style and script elements, so the embedded grid script cannot mint its
 * own.
 */
export function renderDataGridBody(options: DataGridViewOptions, nonce: string): string {
  const isQueryMode = options.mode === 'query';
  const sections = options.grids
    .map((grid, index) => {
      const hidden = index === options.activeIndex ? '' : ' style="display:none"';
      const mutation = grid.status === 'mutation' ? `<p class="result-summary">Statement executed${grid.rowsAffected !== undefined ? `; ${grid.rowsAffected} row(s) affected.` : '.'}</p>` : '';
      const error = grid.status === 'error' ? `<div class="error-box" role="alert">${escapeHtml(grid.error ?? 'Statement failed.')}</div>` : '';
      const skipped = grid.status === 'skipped' ? '<p class="skipped-note">Statement skipped (the batch stopped before it ran).</p>' : '';
      const truncated =
        grid.truncated && grid.status === 'ok'
          ? `<p class="truncated-note">Showing the first ${grid.rows.length} rows; more rows are available on the server.</p>`
          : '';
      const tableHtml =
        grid.status === 'mutation' || grid.status === 'error' || grid.status === 'skipped'
          ? ''
          : `<div class="grid-scroll"><table class="grid">${renderHeaders(grid, options.filters ?? [], options.sort)}${renderRows(grid, isQueryMode)}</table></div>`;
      return `<div class="grid-section" data-grid-index="${index}"${hidden}>
        ${sqlStrip(grid)}
        ${mutation}
        ${error}
        ${skipped}
        ${tableHtml}
        ${truncated}
      </div>`;
    })
    .join('');
  return `${renderToolbar(options)}${renderTabs(options)}${sections}${renderPopups()}${renderExportDialog(options.exportFormats ?? ['csv', 'json', 'sql', 'markdown'])}${clientScript(nonce, options)}`;
}
