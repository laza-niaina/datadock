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
import UmyTable from "umy-table";
import "umy-table/lib/theme-chalk/index.css";
import Vue, { type CreateElement, type VNode } from "vue";
import type { EngineId } from "../../db/types";
import {
  getEngineIcon,
  iconChevron,
  iconClose,
  iconFunnel,
  iconRefresh,
  iconReveal,
} from "../icons";
import type { GridColumn } from "../dataGrid/dataGridModel";
import {
  ALL_FORMATS,
  SELECTION_FORMATS,
  copyFormatLabel,
  copyPayload,
  type CopyFormat,
} from "./copyFormats";
import "./resultApp.css";

Vue.use(UmyTable);

declare global {
  interface Window {
    __DATADOCK_RESULT__?: unknown;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
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
  readonly status: "ok" | "error" | "mutation" | "skipped";
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
  readonly direction: "asc" | "desc";
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
  readonly mode: "query" | "table";
  readonly grids: readonly GridViewGridInit[];
  readonly activeIndex: number;
  readonly engine?: string;
  /** Persisted density preference delivered by the host page shell. */
  readonly compact?: boolean;
  readonly filters?: readonly {
    column: string;
    operator: string;
    value?: string;
  }[];
  readonly sort?: GridSortInit;
  readonly search?: string;
  readonly pageIndex?: number;
  readonly pageSize?: number;
  readonly pageCount?: number;
  readonly totalRows?: number;
  readonly cost?: string;
  readonly query?: QueryMetaInit;
}

type GridFormat = "csv" | "json" | "sql" | "markdown";
const FORMATS: readonly GridFormat[] = ["csv", "json", "sql", "markdown"];
const OPERATORS = [
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "LIKE",
  "NOT LIKE",
  "IS NULL",
  "IS NOT NULL",
] as const;

// --- vscode bridge -----------------------------------------------------------

/**
 * VS Code hands out one API object per webview; asking twice is not part of
 * the contract and `getState`/`setState` would not see the same store, so the
 * instance is resolved once and reused.
 */
let vscodeApi: VsCodeApi | undefined;

function api(): VsCodeApi | undefined {
  if (!vscodeApi) {
    vscodeApi = window.acquireVsCodeApi?.();
  }
  return vscodeApi;
}

function postMessage(message: unknown): void {
  api()?.postMessage(message);
}

// --- local SVGs --------------------------------------------------------------

const SEARCH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.6 10.6 14 14"/></svg>';
const DOWNLOAD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5v7"/><path d="M5 6.5l3 3 3-3"/><path d="M3.5 12.5h9"/></svg>';
const COLUMNS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="3" width="3.2" height="10" rx="0.7"/><rect x="6.4" y="3" width="3.2" height="10" rx="0.7"/><rect x="9.8" y="3" width="3.2" height="10" rx="0.7"/></svg>';
const COPY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.7" y="2.7" width="8" height="8" rx="1.5"/><path d="M5.6 13.3h7.7V5.6"/></svg>';
const DENSITY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11"/><path d="M2.5 8h11"/><path d="M2.5 12h11"/></svg>';
const DETAIL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.2"/><path d="M7 6.2v3.6"/><path d="M7 4.6h.01"/></svg>';

function iconVNode(h: CreateElement, svg: string, className?: string): VNode {
  const classes = className ? ["dd-icon", className] : "dd-icon";
  return h("span", { class: classes, domProps: { innerHTML: svg } });
}

// --- data helpers --------------------------------------------------------------

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
      : {
          field: `${column.name}__${count}`,
          name: column.name,
          type: column.type,
        };
  });
}

function rowsFor(
  grid: GridViewGridInit,
  fields: readonly Field[],
): Record<string, GridCellValue>[] {
  return grid.rows.map((cells) => {
    const row: Record<string, GridCellValue> = {};
    fields.forEach((field, index) => {
      row[field.field] = cells[index] ?? null;
    });
    return row;
  });
}

function compareCells(a: GridCellValue, b: GridCellValue): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function computeWidth(
  field: Field,
  rows: readonly Record<string, GridCellValue>[],
): number {
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

/** Stable field key of a rendered cell, whatever shape the library uses. */
function scopeKey(scope: unknown): string | undefined {
  if (!scope || typeof scope !== "object") return undefined;
  const candidate = scope as {
    column?: { property?: unknown; field?: unknown; title?: unknown };
  };
  const column = candidate.column;
  if (!column) return undefined;
  if (typeof column.property === "string") return column.property;
  if (typeof column.field === "string") return column.field;
  if (typeof column.title === "string") return column.title;
  return undefined;
}

/** Row index of a rendered cell, or -1 when the library did not expose it. */
function scopeRowIndex(scope: unknown): number {
  if (!scope || typeof scope !== "object") return -1;
  const candidate = scope as { $rowIndex?: unknown; rowIndex?: unknown };
  const raw = candidate.$rowIndex ?? candidate.rowIndex;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : -1;
}

/** Field key of a rendered cell, used to label the detail panel. */
function scopeFieldName(scope: unknown): string {
  return scopeKey(scope) ?? "";
}

function readScopeValue(scope: unknown): GridCellValue {
  if (!scope || typeof scope !== "object") return null;
  const row = (scope as { row?: Record<string, unknown> }).row;
  const rawKey = scopeKey(scope);
  if (!row || !rawKey) return null;
  const value = row[rawKey];
  return value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number"
    ? (value as GridCellValue)
    : null;
}

// --- init ----------------------------------------------------------------------

const initial = window.__DATADOCK_RESULT__;
const init: ResultInit =
  initial && typeof initial === "object"
    ? (initial as ResultInit)
    : { mode: "query", grids: [], activeIndex: 0 };
const isTableMode = init.mode === "table";

// --- interfaces ----------------------------------------------------------------

interface ClientSort {
  readonly column: string;
  readonly direction: "asc" | "desc";
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

/** Open Copy As context menu: anchor point plus the hovered flyout level. */
interface CopyMenuState {
  readonly left: number;
  readonly top: number;
  readonly section: "root" | "copyAs" | "selection" | "all";
  /** Index of the right-clicked row in `displayRows`, or -1 for the toolbar. */
  readonly rowIndex: number;
}

/** Manual widths live per grid instance, keyed by grid id then stable field key. */
type ResizeWidths = Record<string, Record<string, number>>;

/** Read-only detail of one cell, anchored to the cell that opened it. */
interface DetailState {
  readonly left: number;
  readonly top: number;
  readonly rowIndex: number;
  readonly field: string;
}

/**
 * Presentation state that must survive the host repainting the page.
 *
 * The host re-renders the whole document to deliver a new page, a new filter or
 * a refreshed result. Without this, the active result tab, the search text and
 * the column layout would silently reset on every one of those actions.
 */
interface PersistedState {
  /** Grid id the saved state was captured on, so a stale entry is ignored. */
  readonly gridId?: string;
  readonly search?: string;
  readonly hidden?: string[];
  readonly sqlOpen?: boolean;
  readonly widths?: ResizeWidths;
  readonly scrollTop?: number;
}

function readState(): PersistedState {
  const stored = api()?.getState();
  return stored && typeof stored === "object" ? (stored as PersistedState) : {};
}

function writeState(state: PersistedState): void {
  api()?.setState(state);
}

/** Column-width floor: 50px keeps the two-line name/type header usable. */
const RESIZE_MIN_WIDTH = 50;
/** Double-click auto-fit never exceeds this, one huge TEXT value stays capped. */
const RESIZE_MAX_AUTO_WIDTH = 420;

/** Positions a popover under the element that opened it, kept inside the panel. */
function anchorRect(
  event: MouseEvent,
  width: number,
  height: number,
): PopoverRect {
  let left = 16;
  let top = 60;
  if (event.currentTarget instanceof HTMLElement) {
    const rect = event.currentTarget.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 4;
  }
  return {
    left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
  };
}

/** Resolves the data row under the pointer from the umy-table DOM. */
function rowIndexOfTarget(target: EventTarget | null): number {
  if (!target || !(target instanceof Element)) {
    return -1;
  }
  const tr = target.closest("tr");
  if (!tr || !tr.parentElement) {
    return -1;
  }
  return Array.prototype.indexOf.call(tr.parentElement.children, tr);
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
  copyMenu: CopyMenuState | null;
  compact: boolean;
  /** Manual widths per grid id, then per stable field key. Row-number index stays fixed. */
  widths: ResizeWidths;
  /** Executed SQL of the active result, folded by default. */
  sqlOpen: boolean;
  /** Rows ticked in the checkbox column; drives the Copy As selection scope. */
  selectedRows: Record<string, GridCellValue>[];
  /** Open read-only cell detail, or undefined. */
  detail?: DetailState;
}

interface DdMethods {
  remeasure(): void;
  onSearchInput(value: string): void;
  onSearchKeyup(event: KeyboardEvent): void;
  clearSearch(): void;
  openColumnsPopover(event: MouseEvent): void;
  openExportPopover(event: MouseEvent): void;
  closePopovers(): void;
  toggleColumn(name: string, checked: boolean): void;
  chooseFormat(format: GridFormat): void;
  doExport(target: "editor" | "file"): void;
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
  columnWidth(field: Field): number;
  columnKey(field: Field): string;
  setColumnWidth(gridId: string, fieldKey: string, width: number): void;
  beginResize(field: Field, event: PointerEvent): void;
  autoFitColumn(field: Field): void;
  cellVNode(h: CreateElement, scope: unknown): VNode;
  onSelectionChange(rows: unknown): void;
  toggleSql(): void;
  openDetail(field: Field, rowIndex: number, event: MouseEvent): void;
  closeDetail(): void;
  persistState(): void;
  restoreScroll(): void;
  captureScroll(): void;
  scrollTopOf(): number;
  renderSqlBand(h: CreateElement): VNode | null;
  renderDetail(h: CreateElement): VNode | null;
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
  renderPopovers(h: CreateElement): VNode | null;
  openCopyMenu(event: MouseEvent): void;
  openCopyMenuFromButton(event: MouseEvent): void;
  closeCopyMenu(): void;
  setCopySection(section: CopyMenuState["section"]): void;
  runCopy(format: CopyFormat | "quick"): void;
  renderCopyMenu(h: CreateElement): VNode | null;
  toggleCompact(): void;
}

interface DdComputed {
  grid: GridViewGridInit | null;
  fields: Field[];
  allRows: Record<string, GridCellValue>[];
  activeFields: Field[];
  displayRows: Record<string, GridCellValue>[];
  engineMark: string;
  banner: { kind: "error" | "info"; text: string } | null;
  canExportSql: boolean;
  showReveal: boolean;
  pagerLabel: string;
  /** Executed SQL of the active result, when the host sent one. */
  sqlText: string;
  /**
   * Where the search box actually looks. Filtering the rows already loaded is
   * not the same operation as filtering the table on the server, and the label
   * has to say which one it is.
   */
  searchScope: { placeholder: string; title: string };
  /** Rows the Copy As menu should use, in the documented order of preference. */
  copyRows: Record<string, GridCellValue>[];
  /** True when a checkbox selection exists, so the menu can offer it. */
  hasSelection: boolean;
}

// --- component ------------------------------------------------------------------

const ResultApp = Vue.extend<DdData, DdMethods, DdComputed>({
  el: "#app",

  data(): DdData {
    // Only presentation state is restored. The active tab stays the host's
    // decision: it deliberately opens the first failing statement, and nothing
    // in this build repaints a query result underneath the user.
    const saved = readState();
    return {
      active: Math.min(
        Math.max(0, init.activeIndex),
        Math.max(0, init.grids.length - 1),
      ),
      search: typeof saved.search === "string" ? saved.search : init.search ?? "",
      hidden: Array.isArray(saved.hidden) ? saved.hidden.filter((n) => typeof n === "string") : [],
      columnsOpen: false,
      exportOpen: false,
      exportFormat: "csv",
      filters: (init.filters ?? []).map((filter) => ({
        column: filter.column,
        operator: filter.operator,
        value: filter.value ?? "",
      })),
      sort: init.sort,
      clientSort: undefined,
      pageIndex: init.pageIndex ?? 0,
      filterDraft: undefined,
      popoverRect: undefined,
      gridHostHeight: 300,
      copyMenu: null,
      compact: init.compact === true,
      widths: saved.widths && typeof saved.widths === "object" ? saved.widths : {},
      sqlOpen: saved.sqlOpen === true,
      selectedRows: [],
      detail: undefined,
    };
  },

  computed: {
    grid(): GridViewGridInit | null {
      return init.grids[this.active] ?? null;
    },
    fields(): Field[] {
      return this.grid ? fieldsFor(this.grid.columns) : [];
    },
    allRows(): Record<string, GridCellValue>[] {
      return this.grid ? rowsFor(this.grid, this.fields) : [];
    },
    activeFields(): Field[] {
      return this.fields.filter((f) => !this.hidden.includes(f.name));
    },
    displayRows(): Record<string, GridCellValue>[] {
      let rows = [...this.allRows];
      if (!isTableMode && this.search.trim() !== "") {
        const q = this.search.toLowerCase();
        rows = rows.filter((row) =>
          Object.values(row).some(
            (val) => val != null && String(val).toLowerCase().includes(q),
          ),
        );
      }
      if (!isTableMode && this.clientSort) {
        const { column, direction } = this.clientSort;
        rows.sort((a, b) => {
          const res = compareCells(a[column], b[column]);
          return direction === "asc" ? res : -res;
        });
      }
      return rows;
    },
    engineMark(): string {
      return init.engine ? getEngineIcon(init.engine as EngineId).svg : "";
    },
    banner(): { kind: "error" | "info"; text: string } | null {
      const g = this.grid;
      if (!g) return null;
      if (g.status === "error" && g.error) {
        return { kind: "error", text: g.error };
      }
      if (g.status === "mutation") {
        return {
          kind: "info",
          text: `Query executed successfully. ${g.rowsAffected ?? 0} row(s) affected.`,
        };
      }
      if (g.truncated) {
        return {
          kind: "info",
          text: "Result set truncated to max allowed rows.",
        };
      }
      return null;
    },
    canExportSql(): boolean {
      return isTableMode || Boolean(this.grid?.table);
    },
    showReveal(): boolean {
      return Boolean(this.grid?.reveal);
    },
    pagerLabel(): string {
      if (isTableMode) {
        const current = this.pageIndex + 1;
        const total = Math.max(1, init.pageCount ?? 1);
        // The row count comes from the host, so the pager states both the
        // position in the table and the size of the whole table.
        const rows =
          typeof init.totalRows === "number"
            ? ` · ${init.totalRows.toLocaleString()} rows`
            : "";
        return `Page ${current} / ${total}${rows}`;
      }
      return `${this.displayRows.length} rows`;
    },
    sqlText(): string {
      return this.grid?.statementSql ?? "";
    },
    searchScope(): { placeholder: string; title: string } {
      return isTableMode
        ? {
            placeholder: "Filter on the server",
            title: "Sends the filter to the database and reloads this page. Press Enter to apply.",
          }
        : {
            placeholder: "Search loaded rows",
            title:
              "Filters the rows already loaded in this result. The database is not queried again.",
          };
    },
    hasSelection(): boolean {
      return this.selectedRows.length > 0;
    },
    copyRows(): Record<string, GridCellValue>[] {
      if (this.selectedRows.length > 0) {
        return this.selectedRows;
      }
      const rowIndex = this.copyMenu?.rowIndex ?? -1;
      if (rowIndex >= 0 && this.displayRows[rowIndex]) {
        return [this.displayRows[rowIndex]];
      }
      return this.displayRows;
    },
  },

  mounted(): void {
    this.$nextTick(() => {
      this.remeasure();
      this.restoreScroll();
    });
    window.addEventListener("resize", () => this.remeasure());
    // Escape closes whatever overlay is open, outermost first, and returns
    // focus to the grid instead of leaving it on a removed element.
    window.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (this.detail) {
        this.closeDetail();
      } else if (this.copyMenu) {
        this.closeCopyMenu();
      } else if (this.columnsOpen || this.exportOpen || this.filterDraft) {
        this.closePopovers();
      } else {
        return;
      }
      const grid = this.$refs.grid;
      if (grid instanceof HTMLElement) {
        grid.focus();
      }
    });
    if (isTableMode) {
      postMessage({ type: "ready" });
    }
  },

  methods: {
    remeasure(): void {
      const host = this.$refs.gridHost;
      if (host instanceof HTMLElement) {
        this.gridHostHeight = Math.max(120, host.clientHeight);
      }
    },

    // --- state that must outlive a host repaint -----------------------------
    persistState(): void {
      writeState({
        gridId: this.grid?.id,
        search: this.search,
        hidden: this.hidden,
        sqlOpen: this.sqlOpen,
        widths: this.widths,
        scrollTop: this.scrollTopOf(),
      });
    },
    captureScroll(): void {
      // Called right before a message that makes the host repaint the page.
      this.persistState();
    },
    scrollTopOf(): number {
      const grid = this.$refs.grid;
      const wrapper =
        grid instanceof Element ? grid.querySelector(".plx-table--body-wrapper") : null;
      return wrapper instanceof HTMLElement ? wrapper.scrollTop : 0;
    },
    restoreScroll(): void {
      const saved = readState();
      if (typeof saved.scrollTop !== "number" || saved.scrollTop <= 0) {
        return;
      }
      const grid = this.$refs.grid;
      const wrapper =
        grid instanceof Element ? grid.querySelector(".plx-table--body-wrapper") : null;
      if (wrapper instanceof HTMLElement) {
        wrapper.scrollTop = saved.scrollTop;
      }
    },

    // --- search --------------------------------------------------------------
    onSearchInput(value: string): void {
      this.search = value;
    },
    onSearchKeyup(event: KeyboardEvent): void {
      if (
        isTableMode &&
        (event.key === "Enter" || event.key === "NumpadEnter")
      ) {
        this.applyQuery();
      }
    },
    clearSearch(): void {
      this.search = "";
      if (isTableMode) {
        this.applyQuery();
      }
    },
    /** Anchors the column popover to its button instead of a fixed offset. */
    openColumnsPopover(event: MouseEvent): void {
      this.closePopovers();
      const rect = anchorRect(event, 240, 320);
      this.columnsOpen = true;
      this.popoverRect = rect;
    },
    /** Anchors the export popover to its button instead of a fixed offset. */
    openExportPopover(event: MouseEvent): void {
      this.closePopovers();
      const rect = anchorRect(event, 220, 260);
      this.exportOpen = true;
      this.popoverRect = rect;
    },
    closePopovers(): void {
      this.columnsOpen = false;
      this.exportOpen = false;
      this.filterDraft = undefined;
      this.popoverRect = undefined;
    },
    toggleColumn(name: string, checked: boolean): void {
      this.hidden = checked
        ? this.hidden.filter((n) => n !== name)
        : [...this.hidden, name];
    },
    chooseFormat(format: GridFormat): void {
      this.exportFormat = format;
    },
    doExport(target: "editor" | "file"): void {
      const grid = this.grid;
      if (!grid) return;
      const message: Record<string, unknown> = {
        type: "export",
        format: this.exportFormat,
        target,
      };
      if (!isTableMode) {
        message.gridId = grid.id;
      }
      this.captureScroll();
      postMessage(message);
      this.exportOpen = false;
    },
    revealSql(): void {
      const reveal = this.grid?.reveal;
      if (reveal) {
        postMessage({ type: "reveal", start: reveal.start, end: reveal.end });
      }
    },
    refresh(): void {
      this.captureScroll();
      postMessage({ type: "refresh", search: this.search });
    },
    page(delta: number): void {
      const total = Math.max(0, (init.pageCount ?? 1) - 1);
      const next = Math.min(Math.max(0, this.pageIndex + delta), total);
      if (next === this.pageIndex) return;
      this.pageIndex = next;
      this.captureScroll();
      postMessage({ type: "page", offset: next * (init.pageSize ?? 100) });
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
      this.filterDraft = {
        column: name,
        operator: existing?.operator ?? "=",
        value: existing?.value ?? "",
      };
      this.popoverRect = { left: Math.min(left, window.innerWidth - 260), top };
      this.columnsOpen = false;
      this.exportOpen = false;
    },
    setFilterOperator(operator: string): void {
      if (this.filterDraft) this.filterDraft.operator = operator;
    },
    setFilterValue(value: string): void {
      if (this.filterDraft) this.filterDraft.value = value;
    },
    applyFilter(): void {
      const draft = this.filterDraft;
      if (!draft) return;
      const rest = this.filters.filter(
        (filter) => filter.column !== draft.column,
      );
      const value = draft.value.trim();
      if (draft.operator === "IS NULL" || draft.operator === "IS NOT NULL") {
        this.filters = [
          ...rest,
          { column: draft.column, operator: draft.operator, value: "" },
        ];
      } else if (value !== "") {
        this.filters = [
          ...rest,
          { column: draft.column, operator: draft.operator, value },
        ];
      } else {
        this.filters = rest;
      }
      this.closePopovers();
      this.applyQuery();
    },
    clearFilter(): void {
      const draft = this.filterDraft;
      if (!draft) return;
      this.filters = this.filters.filter(
        (filter) => filter.column !== draft.column,
      );
      this.closePopovers();
      this.applyQuery();
    },
    applyQuery(): void {
      if (!isTableMode) return;
      this.pageIndex = 0;
      const filters = this.filters.map((filter) => ({
        column: filter.column,
        operator: filter.operator,
        value:
          filter.operator === "IS NULL" || filter.operator === "IS NOT NULL"
            ? undefined
            : filter.value,
      }));
      const sort = this.sort
        ? { column: this.sort.column, direction: this.sort.direction }
        : undefined;
      const message: Record<string, unknown> = {
        type: "apply",
        search: this.search,
      };
      if (filters.length > 0) message.filters = filters;
      if (sort) message.sort = sort;
      postMessage(message);
    },
    onSortChange(event: unknown): void {
      if (!event || typeof event !== "object") return;
      const candidate = event as {
        prop?: unknown;
        column?: { property?: unknown; title?: unknown };
        order?: unknown;
      };
      const order =
        candidate.order === "asc" || candidate.order === "desc"
          ? candidate.order
          : undefined;
      const rawProp =
        typeof candidate.prop === "string"
          ? candidate.prop
          : typeof candidate.column?.property === "string"
            ? candidate.column.property
            : typeof candidate.column?.title === "string"
              ? candidate.column.title
              : undefined;
      if (!rawProp) return;
      const field = this.fields.find((f) => f.field === rawProp);
      if (!field) return;
      if (isTableMode) {
        this.sort = order
          ? { column: field.name, direction: order }
          : undefined;
        this.applyQuery();
      } else {
        this.clientSort = order
          ? { column: field.field, direction: order }
          : undefined;
      }
    },
    columnKey(field: Field): string {
      return `${this.grid?.id ?? "grid"}::${field.field}`;
    },
    columnWidth(field: Field): number {
      const gridWidths = this.grid ? this.widths[this.grid.id] : undefined;
      const manual = gridWidths ? gridWidths[field.field] : undefined;
      if (typeof manual === "number" && Number.isFinite(manual)) {
        return Math.max(RESIZE_MIN_WIDTH, Math.round(manual));
      }
      // Width flows through minWidth so umy-table still grows for long compact
      // content and keeps header/body cells aligned in one column definition.
      return computeWidth(field, this.displayRows);
    },
    setColumnWidth(gridId: string, fieldKey: string, width: number): void {
      const next = Math.max(RESIZE_MIN_WIDTH, Math.round(width));
      const current = this.widths[gridId] ?? {};
      // Vue 2 reactivity for a dynamic per-grid key.
      this.$set(this.widths, gridId, { ...current, [fieldKey]: next });
    },
    beginResize(field: Field, event: PointerEvent): void {
      const grid = this.grid;
      if (!grid) return;
      // The handle consumes its own click/drag so header sorting never fires.
      event.preventDefault();
      event.stopPropagation();
      const pointerId = event.pointerId;
      const handle = event.currentTarget;
      const target = handle instanceof HTMLElement ? handle : null;
      const startX = event.clientX;
      const startWidth = this.columnWidth(field);
      const gridId = grid.id;
      const fieldKey = field.field;
      const move = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== pointerId) return;
        this.setColumnWidth(gridId, fieldKey, startWidth + (moveEvent.clientX - startX));
      };
      const stop = (stopEvent: PointerEvent): void => {
        if (stopEvent.pointerId !== pointerId) return;
        stopEvent.preventDefault();
        stopEvent.stopPropagation();
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", stop, true);
        window.removeEventListener("pointercancel", stop, true);
        document.body.classList.remove("dd-resizing");
        // A capture release after removeEventListener keeps later drags clean.
        try {
          target?.releasePointerCapture(pointerId);
        } catch {
          // Best effort only; removal above already detached the drag.
        }
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", stop, true);
      window.addEventListener("pointercancel", stop, true);
      document.body.classList.add("dd-resizing");
      try {
        target?.setPointerCapture(pointerId);
      } catch {
        // Pointer capture is best-effort; window-level listeners still track it.
      }
    },
    autoFitColumn(field: Field): void {
      const grid = this.grid;
      if (!grid) return;
      const fitted = computeWidth(field, this.displayRows);
      this.setColumnWidth(
        grid.id,
        field.field,
        Math.min(RESIZE_MAX_AUTO_WIDTH, fitted),
      );
    },
    cellVNode(h: CreateElement, scope: unknown): VNode {
      const value = readScopeValue(scope);
      if (value == null) {
        return h("div", { class: "dd-cell" }, [h("span", { class: "dd-null" }, "(NULL)")]);
      }
      const text = String(value);
      // Long values are clipped by the cell, so the full content stays
      // reachable twice: a native tooltip, and the read-only detail panel.
      const long = text.length > 32;
      const rowIndex = scopeRowIndex(scope);
      const children: VNode[] = [h("span", { class: "dd-cell-text" }, text)];
      if (long && rowIndex >= 0) {
        const field = scopeFieldName(scope);
        children.push(
          h(
            "button",
            {
              class: "dd-cell-detail",
              attrs: {
                type: "button",
                title: "Show the full value",
                "aria-label": `Show the full value of this cell`,
              },
              on: {
                click: (event: MouseEvent) => {
                  event.stopPropagation();
                  this.openDetail(
                    { field, name: field },
                    rowIndex,
                    event,
                  );
                },
              },
            },
            [iconVNode(h, DETAIL_SVG)],
          ),
        );
      }
      return h(
        "div",
        {
          class: "dd-cell",
          attrs: long ? { title: text } : {},
        },
        children,
      );
    },

    /** Checkbox column selection: the reference rows drive the Copy As scope. */
    onSelectionChange(rows: unknown): void {
      this.selectedRows = Array.isArray(rows)
        ? (rows.filter((row) => row && typeof row === "object") as Record<
            string,
            GridCellValue
          >[])
        : [];
    },

    toggleSql(): void {
      this.sqlOpen = !this.sqlOpen;
      this.persistState();
    },

    openDetail(field: Field, rowIndex: number, event: MouseEvent): void {
      const rect = anchorRect(event, 320, 200);
      this.detail = { ...rect, rowIndex, field: field.field };
    },

    closeDetail(): void {
      this.detail = undefined;
    },

    // --- Copy As context menu (DBCode grid right-click) --------------------------
    openCopyMenu(event: MouseEvent): void {
      event.preventDefault();
      this.closePopovers();
      const maxLeft = Math.max(4, window.innerWidth - 540);
      const maxTop = Math.max(4, window.innerHeight - 340);
      this.copyMenu = {
        left: Math.max(4, Math.min(event.clientX, maxLeft)),
        top: Math.max(4, Math.min(event.clientY, maxTop)),
        section: "root",
        rowIndex: rowIndexOfTarget(event.target),
      };
    },

    openCopyMenuFromButton(event: MouseEvent): void {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      this.closePopovers();
      const maxLeft = Math.max(4, window.innerWidth - 540);
      this.copyMenu = {
        left: Math.max(4, Math.min(rect.left, maxLeft)),
        top: Math.min(rect.bottom + 4, Math.max(4, window.innerHeight - 340)),
        section: "root",
        rowIndex: -1,
      };
    },

    closeCopyMenu(): void {
      this.copyMenu = null;
    },

    setCopySection(section: CopyMenuState["section"]): void {
      if (this.copyMenu) {
        this.copyMenu = { ...this.copyMenu, section };
      }
    },

    toggleCompact(): void {
      this.compact = !this.compact;
      // The host persists the preference (workspace configuration) so the next
      // result view opens with the same density; the webview applies the state
      // immediately, the round trip only restores it later.
      postMessage({ type: "setCompact", compact: this.compact });
    },

    runCopy(format: CopyFormat | "quick"): void {
      const columns: GridColumn[] = this.activeFields.map((field) => ({
        name: field.name,
        type: field.type,
      }));
      // Scope, in order of preference: the ticked rows, the right-clicked row,
      // then everything. `copyRows` is the single place that decides.
      const rows: GridCellValue[][] = this.copyRows.map((record) =>
        this.activeFields.map((field) => record[field.field] ?? null),
      );
      const text = copyPayload(
        format === "quick" ? "plain" : format,
        this.grid?.table ?? "",
        columns,
        rows,
      );
      if (text !== "") {
        postMessage({ type: "copy", text });
      }
      this.closeCopyMenu();
    },

    renderHead(h: CreateElement): VNode | null {
      const query = init.query;
      if (init.mode !== "query" || !query) return null;
      const tags: VNode[] = [
        h("span", { key: "conn", class: "dd-tag is-primary" }, query.connectionName),
      ];
      if (query.database) {
        tags.push(h("span", { key: "db", class: "dd-tag" }, query.database));
      }
      tags.push(
        h("span", { key: "stmts", class: "dd-stat" }, `${query.statementCount} statement(s)`),
        h("span", { key: "exec", class: "dd-stat" }, `${query.executedCount} executed`),
        h("span", { key: "time", class: "dd-stat" }, `${(query.durationMs / 1000).toFixed(2)} s total`),
      );
      if (query.hasError) {
        tags.push(h("span", { key: "err", class: "dd-tag is-error" }, "one or more statements failed"));
      }
      const out: VNode[] = [h("div", { class: "dd-head-row" }, tags)];
      if (query.notices.length > 0) {
        out.push(
          h(
            "ul",
            { class: "dd-notices" },
            query.notices.map((notice, index) =>
              h("li", { key: String(index) }, notice),
            ),
          ),
        );
      }
      return h("div", { class: "dd-head" }, out);
    },

    renderTabs(h: CreateElement): VNode | null {
      if (init.mode !== "query" || init.grids.length <= 1) return null;
      const tabs: VNode[] = init.grids.map((grid, index) => {
        const statusClass =
          grid.status === "error"
            ? "is-error"
            : grid.status === "mutation"
              ? "is-mutation"
              : grid.status === "skipped"
                ? "is-skipped"
                : "";
        const inner: VNode[] = [];
        if (statusClass !== "") {
          inner.push(
            h("span", { key: "mark", class: ["dd-tab-mark", statusClass] }),
          );
        }
        inner.push(h("span", { key: "label" }, grid.label));
        return h(
          "button",
          {
            key: grid.id,
            class: ["dd-tab", this.active === index ? "is-active" : ""],
            attrs: {
              role: "tab",
              "aria-selected": this.active === index ? "true" : "false",
              title: grid.statementSql ?? grid.label,
            },
            on: {
              click: () => {
                this.active = index;
              },
            },
          },
          inner,
        );
      });
      return h("nav", { class: "dd-tabs", attrs: { role: "tablist" } }, tabs);
    },

    renderToolbar(h: CreateElement): VNode {
      const parts: VNode[] = [];
      if (this.engineMark !== "") {
        parts.push(
          h("span", {
            class: "dd-engine",
            attrs: { title: init.engine ?? "" },
            domProps: { innerHTML: this.engineMark },
          }),
        );
      }
      parts.push(
        h("div", { class: "dd-search" }, [
          iconVNode(h, SEARCH_SVG, "dd-search-icon"),
          h("input", {
            attrs: {
              type: "text",
              // The placeholder names the scope: loaded rows locally, or the
              // server. "Search" alone would hide a real behavioural difference.
              placeholder: this.searchScope.placeholder,
              title: this.searchScope.title,
              "aria-label": this.searchScope.placeholder,
            },
            domProps: { value: this.search },
            on: {
              input: (event: Event) =>
                this.onSearchInput((event.target as HTMLInputElement).value),
              keyup: (event: KeyboardEvent) => this.onSearchKeyup(event),
            },
          }),
          this.search !== ""
            ? h(
                "button",
                {
                  class: "dd-search-clear",
                  attrs: {
                    type: "button",
                    title: "Clear search",
                    "aria-label": "Clear search",
                  },
                  on: { click: () => this.clearSearch() },
                },
                [iconVNode(h, iconClose())],
              )
            : null,
        ]),
      );

      parts.push(h("span", { class: "dd-sep" }));

      parts.push(
        h(
          "button",
          {
            class: ["dd-btn", this.columnsOpen ? "is-active" : ""],
            attrs: { type: "button", title: "Select Columns" },
            on: { click: (event: MouseEvent) => this.openColumnsPopover(event) },
          },
          [iconVNode(h, COLUMNS_SVG)],
        ),
      );

      parts.push(
        h(
          "button",
          {
            class: ["dd-btn", this.compact ? "is-active" : ""],
            attrs: { type: "button", title: "Compact rows" },
            on: { click: () => this.toggleCompact() },
          },
          [iconVNode(h, DENSITY_SVG)],
        ),
      );

      parts.push(
        h(
          "button",
          {
            class: ["dd-btn", this.copyMenu ? "is-active" : ""],
            attrs: { type: "button", title: "Copy As" },
            on: { click: (event: MouseEvent) => this.openCopyMenuFromButton(event) },
          },
          [iconVNode(h, COPY_SVG)],
        ),
      );

      parts.push(
        h(
          "button",
          {
            class: ["dd-btn", this.exportOpen ? "is-active" : ""],
            attrs: { type: "button", title: "Export Data" },
            on: { click: (event: MouseEvent) => this.openExportPopover(event) },
          },
          [iconVNode(h, DOWNLOAD_SVG)],
        ),
      );

      parts.push(h("span", { class: "dd-sep" }));

      if (this.showReveal) {
        parts.push(
          h(
            "button",
            {
              class: "dd-btn",
              attrs: { type: "button", title: "Reveal Query" },
              on: { click: () => this.revealSql() },
            },
            [iconVNode(h, iconReveal())],
          ),
        );
      }

      if (isTableMode) {
        parts.push(
          h(
            "button",
            {
              class: "dd-btn",
              attrs: { type: "button", title: "Refresh Data" },
              on: { click: () => this.refresh() },
            },
            [iconVNode(h, iconRefresh())],
          ),
        );
      }

      parts.push(h("div", { class: "dd-spacer" }));

      if (init.cost) {
        parts.push(h("span", { class: "dd-cost" }, init.cost));
      }

      const pagerBtns: VNode[] = [];
      if (isTableMode) {
        pagerBtns.push(
          h(
            "button",
            {
              class: "dd-btn",
              attrs: {
                type: "button",
                title: "Previous Page",
                disabled: this.pageIndex === 0,
              },
              on: { click: () => this.page(-1) },
            },
            [iconVNode(h, iconChevron("left"))],
          ),
        );
      }

      pagerBtns.push(h("span", {}, this.pagerLabel));

      if (isTableMode) {
        const isLastPage =
          this.pageIndex >= Math.max(0, (init.pageCount ?? 1) - 1);
        pagerBtns.push(
          h(
            "button",
            {
              class: "dd-btn",
              attrs: {
                type: "button",
                title: "Next Page",
                disabled: isLastPage,
              },
              on: { click: () => this.page(1) },
            },
            [iconVNode(h, iconChevron("right"))],
          ),
        );
      }

      parts.push(h("div", { class: "dd-pager" }, pagerBtns));

      return h("div", { class: "dd-toolbar" }, parts);
    },

    renderBanner(h: CreateElement): VNode | null {
      const banner = this.banner;
      if (!banner) return null;
      return h(
        "div",
        {
          class: [
            "dd-banner",
            banner.kind === "error" ? "dd-banner-error" : "dd-banner-info",
          ],
        },
        banner.text,
      );
    },

    renderColumnHeader(h: CreateElement, field: Field): VNode {
      const hasFilter = this.filters.some((f) => f.column === field.name);
      const nameRow: VNode[] = [h("span", { class: "dd-col-name" }, field.name)];
      if (isTableMode) {
        nameRow.push(
          h(
            "button",
            {
              class: ["dd-btn", "dd-col-filter", hasFilter ? "is-active" : ""],
              attrs: { type: "button", title: `Filter ${field.name}` },
              on: {
                click: (e: MouseEvent) => this.openFilter(field.name, e),
              },
            },
            [iconVNode(h, iconFunnel())],
          ),
        );
      }
      // Database Client Row_Header: name first, type on a second muted line.
      // The handle is two plain spans (no pseudo-element, no glyph content):
      // outer 9px grab zone with col-resize cursor, inner 1px separator.
      // Drag-only: the handle consumes pointer/click so header sorting never fires.
      return h("div", { class: "dd-col-header" }, [
        h("div", { class: "dd-col-name-row" }, nameRow),
        field.type ? h("div", { class: "dd-col-type" }, field.type) : null,
        h(
          "span",
          {
            key: `resize-${this.columnKey(field)}`,
            class: "dd-col-resize",
            attrs: {
              role: "separator",
              "aria-orientation": "vertical",
              "aria-label": `Resize ${field.name} column`,
              title: `Resize ${field.name} column`,
            },
            on: {
              pointerdown: (event: PointerEvent) =>
                this.beginResize(field, event),
              dblclick: (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                this.autoFitColumn(field);
              },
              click: (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
              },
            },
          },
          [h("span", { class: "dd-col-resize-line" })],
        ),
      ]);
    },

    renderGrid(h: CreateElement): VNode {
      const columns = this.activeFields.map((field) =>
        h("ux-table-column", {
          key: this.columnKey(field),
          props: {
            field: field.field,
            title: field.name,
            sortable: "custom",
            minWidth: this.columnWidth(field),
          },
          scopedSlots: {
            header: () => this.renderColumnHeader(h, field),
            default: (scope: unknown) => this.cellVNode(h, scope),
          },
        }),
      );

      // Selection column: the reference grid's checkbox column. It feeds the
      // Copy As scope and gives keyboard users a row-granular target; it never
      // edits anything, because no driver in this build can write a row back.
      const selectCol = h("ux-table-column", {
        props: {
          type: "checkbox",
          width: 34,
          align: "center",
        },
      });

      const indexCol = h("ux-table-column", {
        props: {
          type: "index",
          width: 50,
          align: "center",
          classNames: "col--index",
        },
      });

      return h(
        "ux-grid",
        {
          ref: "grid",
          props: {
            data: this.displayRows,
            height: this.gridHostHeight,
            size: "mini",
            border: true,
            stripe: true,
            showOverflow: true,
            showHeaderOverflow: true,
          },
          on: {
            "sort-change": (evt: unknown) => this.onSortChange(evt),
            "selection-change": (rows: unknown) => this.onSelectionChange(rows),
          },
        },
        [selectCol, indexCol, ...columns],
      );
    },

    renderSqlBand(h: CreateElement): VNode | null {
      const sql = this.sqlText;
      if (sql === "") return null;
      return h("div", { class: "dd-sql" }, [
        h(
          "button",
          {
            class: ["dd-sql-toggle", this.sqlOpen ? "is-open" : ""],
            attrs: {
              type: "button",
              "aria-expanded": this.sqlOpen ? "true" : "false",
              title: this.sqlOpen ? "Hide the executed statement" : "Show the executed statement",
            },
            on: { click: () => this.toggleSql() },
          },
          [
            iconVNode(h, iconChevron(this.sqlOpen ? "down" : "right")),
            h("span", { class: "dd-sql-label" }, "Executed statement"),
          ],
        ),
        this.sqlOpen ? h("pre", { class: "dd-sql-text" }, sql) : null,
      ]);
    },

    renderDetail(h: CreateElement): VNode | null {
      const detail = this.detail;
      if (!detail) return null;
      const row = this.displayRows[detail.rowIndex];
      if (!row) return null;
      const field = this.fields.find((f) => f.field === detail.field);
      const value = row[detail.field];
      return h("div", { class: "dd-detail-layer" }, [
        // Backdrop first so a click anywhere else closes the panel; the panel
        // itself stops the propagation.
        h("div", {
          class: "dd-detail-backdrop",
          on: { click: () => this.closeDetail() },
        }),
        h(
          "div",
          {
            class: "dd-detail",
            style: { left: `${detail.left}px`, top: `${detail.top}px` },
            attrs: { role: "dialog", "aria-label": "Cell detail" },
            on: {
              click: (event: MouseEvent) => event.stopPropagation(),
            },
          },
          [
            h("div", { class: "dd-detail-title" }, [
              h("span", { class: "dd-detail-col" }, field?.name ?? detail.field),
              field?.type ? h("span", { class: "dd-detail-type" }, field.type) : null,
              h("span", { class: "dd-detail-row" }, `row ${detail.rowIndex + 1}`),
            ]),
            value == null
              ? h("p", { class: "dd-detail-null" }, "NULL")
              : h("pre", { class: "dd-detail-value" }, String(value)),
          ],
        ),
      ]);
    },

    renderGridHost(h: CreateElement): VNode {
      // The density class lives on this real element (not on the ux-grid
      // component, whose class lands on an inner wrapper) so the CSS overrides
      // can scope through it, and the custom property inherits down.
      return h(
        "div",
        {
          ref: "gridHost",
          class: ["dd-grid-host", this.compact ? "dd-grid-host--compact" : ""],
          on: {
            contextmenu: (event: MouseEvent) => this.openCopyMenu(event),
          },
        },
        this.displayRows.length > 0
          ? [this.renderGrid(h)]
          : [h("div", { class: "dd-empty" }, "No Data Found")],
      );
    },

    renderColumnsPopover(h: CreateElement): VNode {
      const rect = this.popoverRect ?? { left: 16, top: 60 };
      return h(
        "div",
        {
          class: "dd-popover",
          style: { top: `${rect.top}px`, left: `${rect.left}px` },
        },
        [
          h("div", { class: "dd-popover-title" }, "Columns"),
          h(
            "div",
            { class: "dd-col-list" },
            this.fields.map((f) =>
              h("label", { key: f.field }, [
                h("input", {
                  attrs: { type: "checkbox" },
                  domProps: { checked: !this.hidden.includes(f.name) },
                  on: {
                    change: (e: Event) =>
                      this.toggleColumn(
                        f.name,
                        (e.target as HTMLInputElement).checked,
                      ),
                  },
                }),
                h("span", {}, f.name),
              ]),
            ),
          ),
        ],
      );
    },

    renderExportPopover(h: CreateElement): VNode {
      const rect = this.popoverRect ?? { left: 16, top: 60 };
      return h(
        "div",
        {
          class: "dd-popover",
          style: { top: `${rect.top}px`, left: `${rect.left}px` },
        },
        [
          h("div", { class: "dd-popover-title" }, "Export Format"),
          h(
            "div",
            { class: "dd-chips" },
            FORMATS.map((fmt) =>
              h(
                "button",
                {
                  key: fmt,
                  class: [
                    "dd-chip",
                    this.exportFormat === fmt ? "is-selected" : "",
                  ],
                  attrs: {
                    type: "button",
                    disabled: fmt === "sql" && !this.canExportSql,
                  },
                  on: { click: () => this.chooseFormat(fmt) },
                },
                fmt.toUpperCase(),
              ),
            ),
          ),
          h("div", { class: "dd-popover-actions" }, [
            h(
              "button",
              {
                class: "dd-btn-secondary",
                attrs: { type: "button" },
                on: { click: () => this.doExport("editor") },
              },
              "To Editor",
            ),
            h(
              "button",
              {
                class: "dd-btn-primary",
                attrs: { type: "button" },
                on: { click: () => this.doExport("file") },
              },
              "To File",
            ),
          ]),
        ],
      );
    },

    renderFilterPopover(h: CreateElement): VNode {
      const draft = this.filterDraft;
      const rect = this.popoverRect;
      if (!draft || !rect) return h("div");

      const isNullOp =
        draft.operator === "IS NULL" || draft.operator === "IS NOT NULL";

      return h(
        "div",
        {
          class: "dd-popover",
          style: { top: `${rect.top}px`, left: `${rect.left}px` },
        },
        [
          h("div", { class: "dd-popover-title" }, `Filter: ${draft.column}`),
          h("div", { class: "dd-filter-form" }, [
            h(
              "select",
              {
                domProps: { value: draft.operator },
                on: {
                  change: (e: Event) =>
                    this.setFilterOperator(
                      (e.target as HTMLSelectElement).value,
                    ),
                },
              },
              OPERATORS.map((op) => h("option", { attrs: { value: op } }, op)),
            ),
            !isNullOp
              ? h("input", {
                  attrs: { type: "text", placeholder: "Filter value..." },
                  domProps: { value: draft.value },
                  on: {
                    input: (e: Event) =>
                      this.setFilterValue((e.target as HTMLInputElement).value),
                  },
                })
              : null,
          ]),
          h("div", { class: "dd-popover-actions" }, [
            h(
              "button",
              {
                class: "dd-btn-secondary",
                attrs: { type: "button" },
                on: { click: () => this.clearFilter() },
              },
              "Clear",
            ),
            h(
              "button",
              {
                class: "dd-btn-primary",
                attrs: { type: "button" },
                on: { click: () => this.applyFilter() },
              },
              "Apply",
            ),
          ]),
        ],
      );
    },

    renderPopovers(h: CreateElement): VNode | null {
      const hasPopover =
        this.columnsOpen || this.exportOpen || Boolean(this.filterDraft);
      if (!hasPopover) return null;

      const children: VNode[] = [
        h("div", {
          class: "dd-popover-backdrop",
          on: { click: () => this.closePopovers() },
        }),
      ];

      if (this.columnsOpen) children.push(this.renderColumnsPopover(h));
      if (this.exportOpen) children.push(this.renderExportPopover(h));
      if (this.filterDraft) children.push(this.renderFilterPopover(h));

      return h("div", children);
    },

    renderCopyMenu(h: CreateElement): VNode | null {
      const menu = this.copyMenu;
      if (!menu) return null;

      const item = (
        key: string,
        label: string,
        options: {
          active?: boolean;
          sub?: boolean;
          onEnter?: () => void;
          onClick: () => void;
        },
      ): VNode => {
        const children: VNode[] = [h("span", {}, label)];
        if (options.sub) {
          children.push(iconVNode(h, iconChevron("right"), "dd-menu-caret"));
        }
        return h(
          "button",
          {
            key,
            class: ["dd-menu-item", options.active ? "is-active" : ""],
            attrs: { type: "button" },
            on: {
              mouseenter: options.onEnter ?? ((): void => undefined),
              click: options.onClick,
            },
          },
          children,
        );
      };

      const flyouts: VNode[] = [];
      if (menu.section !== "root") {
        flyouts.push(
          h(
            "div",
            {
              key: "sections",
              class: "dd-menu",
              style: { left: `${menu.left + 178}px`, top: `${menu.top}px` },
            },
            [
              // The label states the scope it will actually use, so a copy is
              // never a surprise: ticked rows, else the row under the pointer.
              item(
                "selection",
                this.hasSelection
                  ? `Selected rows (${this.selectedRows.length})`
                  : menu.rowIndex >= 0
                    ? "This row"
                    : "Selected rows",
                {
                  active: menu.section === "selection",
                  sub: true,
                  onEnter: () => this.setCopySection("selection"),
                  onClick: () => this.setCopySection("selection"),
                },
              ),
              item("all", "All rows", {
                active: menu.section === "all",
                sub: true,
                onEnter: () => this.setCopySection("all"),
                onClick: () => this.setCopySection("all"),
              }),
            ],
          ),
        );
      }
      if (menu.section === "selection" || menu.section === "all") {
        const formats = menu.section === "selection" ? SELECTION_FORMATS : ALL_FORMATS;
        flyouts.push(
          h(
            "div",
            {
              key: "formats",
              class: "dd-menu dd-menu-formats",
              style: { left: `${menu.left + 330}px`, top: `${menu.top}px` },
            },
            formats.map((format) =>
              item(format, copyFormatLabel(format), {
                onEnter: () => this.setCopySection(menu.section),
                onClick: () => this.runCopy(format),
              }),
            ),
          ),
        );
      }

      const root = h(
        "div",
        {
          key: "root",
          class: "dd-menu",
          style: { left: `${menu.left}px`, top: `${menu.top}px` },
        },
        [
          item("copy", "Copy", { onClick: () => this.runCopy("quick") }),
          h("div", { key: "sep", class: "dd-menu-sep" }),
          item("copyas", "Copy As", {
            active: menu.section !== "root",
            sub: true,
            onEnter: () => this.setCopySection("copyAs"),
            onClick: () =>
              this.setCopySection(menu.section === "root" ? "copyAs" : "root"),
          }),
        ],
      );

      const backdrop = h("div", {
        key: "backdrop",
        class: "dd-menu-backdrop",
        on: {
          mousedown: () => this.closeCopyMenu(),
          contextmenu: (event: MouseEvent) => {
            event.preventDefault();
            this.closeCopyMenu();
          },
        },
      });

      return h("div", { class: "dd-menu-layer" }, [backdrop, root, ...flyouts]);
    },
  },

  render(h: CreateElement): VNode {
    // Horizontal bands, in reading order: context, result tabs, the executed
    // statement (folded), the action bar, the state of the active result, then
    // the grid itself. Overlays come last so they always sit on top.
    return h("div", { class: "dd-root" }, [
      this.renderHead(h),
      this.renderTabs(h),
      this.renderSqlBand(h),
      this.renderToolbar(h),
      this.renderBanner(h),
      this.renderGridHost(h),
      this.renderPopovers(h),
      this.renderDetail(h),
      this.renderCopyMenu(h),
    ]);
  },
});

export default ResultApp;

// `el` in a Vue.extend options object is ignored; the instance must be created
// (and therefore mounted) explicitly, exactly like the previous implementation.
new ResultApp();
