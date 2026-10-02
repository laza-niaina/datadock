/**
 * DataDock result webview application.
 *
 * One Vue 2 + umy-table app serves both panels (query results and the table
 * viewer), mirroring the reference "Database Client" result chain: tabbed
 * batches, compact toolbar (engine mark, search, columns, export, cost, pager),
 * and the reference grid look (dense rows, name-over-type headers, `(NULL)`
 * cells). Every column comes from the driver: no index column is invented.
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
  iconHashtagMark,
  iconKeyMark,
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
import {
  computeWidth,
  fieldsFor,
  widthSignature,
  type Field,
  type GridCellValue,
  type GridColumnInit,
} from "./gridFields";
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
  /**
   * Echo token of this document: every write message carries it back so the
   * host can refuse one that came from a page it has already replaced.
   */
  readonly revision?: number;
  /** Row editing is armed on this page (writable profile + primary key). */
  readonly editable?: boolean;
  /** Banner the host wants shown by exactly this paint (after a write). */
  readonly writeNotice?: { readonly kind: "info" | "error"; readonly text: string };
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

/** One open inline cell editor: a row of `displayRows` and a stable field key. */
interface CellEdit {
  readonly row: number;
  readonly field: string;
  readonly text: string;
  readonly isNull: boolean;
}

/** One column of the insert-row dialog, in the order the schema returned them. */
interface InsertField {
  readonly field: string;
  readonly name: string;
  readonly type?: string;
  readonly nullable: boolean;
  readonly autoIncrement: boolean;
  readonly text: string;
  readonly isNull: boolean;
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
const PLUS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
const TRASH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10"/><path d="M6.5 4.5V3h3v1.5"/><path d="M4.6 4.5 5.2 13h5.6l.6-8.5"/><path d="M6.8 6.8v4.4M9.2 6.8v4.4"/></svg>';

function iconVNode(h: CreateElement, svg: string, className?: string): VNode {
  const classes = className ? ["dd-icon", className] : "dd-icon";
  return h("span", { class: classes, domProps: { innerHTML: svg } });
}

/**
 * Schema key marks drawn to the left of a column name.
 *
 * A primary key gets a key, a foreign key gets a hashtag, and a column
 * declared both shows both in that order. Each mark is a real inline SVG
 * wrapped in a labelled `role="img"`: the shape carries the meaning for anyone
 * who cannot separate the two hues, and the accessible name says what the mark
 * is even though the `<svg>` itself is `aria-hidden`.
 */
function keyMarkVNodes(h: CreateElement, field: Field): VNode[] {
  const marks: VNode[] = [];
  const add = (kind: "primary" | "foreign", svg: string, label: string): void => {
    marks.push(
      h(
        "span",
        {
          class: ["dd-col-mark", `dd-col-mark--${kind}`],
          attrs: {
            role: "img",
            "aria-label": label,
            title: `${label}: ${field.name}`,
          },
        },
        [iconVNode(h, svg)],
      ),
    );
  };
  if (field.primaryKey) {
    add("primary", iconKeyMark(), "Primary key");
  }
  if (field.foreignKey) {
    add("foreign", iconHashtagMark(), "Foreign key");
  }
  return marks;
}

// --- data helpers --------------------------------------------------------------
// Column mapping (`fieldsFor`), auto-fit width and the width-persistence
// signature live in `./gridFields` so unit tests can lock them down.

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
/** Two header clicks closer than this are one double-click (auto-fit). */
const SORT_PAIR_WINDOW_MS = 400;
/** Table-mode sorting waits briefly so a double-click costs one request. */
const SORT_DEBOUNCE_MS = 300;
/**
 * The selection column's header toggle is umy-table's own node, and its
 * template hardcodes a Chinese tooltip on it. It is rewritten to English in
 * `labelSortHandles` after render - the same treatment as the sort carets,
 * because the library bundle offers no option for either string.
 */
const SELECT_ALL_TITLE = "Select or clear all rows";

/**
 * The plx instance behind `ux-grid`, only for the layout calls this app needs.
 *
 * `ux-grid` proxies the read APIs but not `resetColumn`, so auto-fit reaches
 * the inner table through its `singleTable` ref - the one the wrapper itself
 * names. Every method stays optional and every call is guarded: this is a
 * version-bound shortcut, not an architecture.
 */
interface PlxTableApi {
  resetColumn?(resizable?: boolean): unknown;
  refreshColumn?(): unknown;
  recalculate?(immediate?: boolean): unknown;
  clearSort?(): unknown;
}

function gridTable(gridRef: unknown): PlxTableApi | null {
  const wrapper = gridRef as { $refs?: { singleTable?: PlxTableApi } } | undefined;
  return wrapper?.$refs?.singleTable ?? null;
}

/**
 * Resize observation of the grid host, typed structurally so the build never
 * depends on a particular DOM lib version. Absent environments simply fall
 * back to the window resize event.
 */
interface HostResizeObserver {
  observe(target: Element): void;
  disconnect(): void;
}

interface ResizeObserverCtor {
  new (callback: () => void): HostResizeObserver;
}

/** Positions a popover under an element, kept inside the panel. */
function anchorRectOf(element: Element | null, width: number, height: number): PopoverRect {
  let left = 16;
  let top = 60;
  if (element) {
    const rect = element.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 4;
  }
  return {
    left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
  };
}

/** Positions a popover under the element that opened it, kept inside the panel. */
function anchorRect(
  event: MouseEvent,
  width: number,
  height: number,
): PopoverRect {
  return anchorRectOf(
    event.currentTarget instanceof Element ? event.currentTarget : null,
    width,
    height,
  );
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
  /** Keyboard cursor: row in `displayRows`, column in `activeFields`. */
  activeCell?: { row: number; col: number };
  /** A table-mode request is in flight; the host repaints the page on answer. */
  loading: boolean;
  /** Sort before the current click pair, so a double-click can put it back. */
  sortSnapshot?: { sort?: GridSortInit; clientSort?: ClientSort };
  /** When the last sort change happened, to pair two clicks into one gesture. */
  sortChangedAt: number;
  /** Pending debounced table-mode sort request, or null. */
  sortTimer: number | null;
  /** A sort caret is being reset, so its echo must be ignored. */
  restoringSort: boolean;
  /** The library's sort carets already carry our wording, so a walk can skip. */
  sortHandlesLabelled: boolean;
  /** Height observer of the grid host, null when unavailable or destroyed. */
  resizeObserver: HostResizeObserver | null;
  /** Element `resizeObserver` is attached to, so a remount is picked up. */
  observedHost: Element | null;
  /** Open inline cell editor, or undefined when no cell is being typed into. */
  editCell?: CellEdit;
  /** Row of `displayRows` waiting for a delete confirmation, or undefined. */
  deleteTarget?: number;
  /** Draft of the insert-row dialog, or undefined while it is closed. */
  insertDraft?: InsertField[];
  /** Refusal of the last write attempt, shown in the banner. */
  writeError?: string;
  /** A write is in flight; the editors stay read-only until the host answers. */
  writing: boolean;
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
  send(message: Record<string, unknown>): void;
  onSortChange(event: unknown): void;
  scheduleApplyQuery(): void;
  clearPendingSort(): void;
  undoSortPair(): void;
  labelSortHandles(): number;
  columnKey(field: Field): string;
  manualWidth(field: Field): number | undefined;
  autoWidth(field: Field): number;
  setColumnWidth(fieldKey: string, width: number): void;
  onHeaderDragend(event: unknown): void;
  syncLibraryWidths(): void;
  autoFitColumn(field: Field): void;
  autoFitAllColumns(): void;
  resetColumnWidths(): void;
  cellVNode(h: CreateElement, scope: unknown): VNode;
  onSelectionChange(rows: unknown): void;
  toggleSql(): void;
  openDetail(field: Field, rowIndex: number, anchor: Element | null): void;
  openActiveDetail(): void;
  closeDetail(): void;
  onGridClick(event: MouseEvent): void;
  onGridDblClick(event: MouseEvent): void;
  onGridKeydown(event: KeyboardEvent): void;
  onWindowResize(): void;
  onGlobalKeydown(event: KeyboardEvent): void;
  activateCell(row: number, col: number): void;
  clampActiveCell(): void;
  focusActiveCell(): void;
  copyActiveCell(): void;
  observeGridHost(): void;
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
  // --- row editing (table mode only) ----------------------------------------
  canEditField(field: Field): boolean;
  openCellEditor(rowIndex: number, field: Field): void;
  closeCellEditor(): void;
  commitCellEditor(): void;
  toggleEditorNull(): void;
  onEditorKeydown(event: KeyboardEvent): void;
  postWrite(message: Record<string, unknown>): void;
  onHostMessage(event: MessageEvent): void;
  requestDeleteRow(rowIndex: number): void;
  confirmDeleteRow(): void;
  closeWriteDialog(): void;
  openInsertDialog(): void;
  setInsertText(field: string, text: string): void;
  setInsertNull(field: string, isNull: boolean): void;
  submitInsert(): void;
  renderDialogs(h: CreateElement): VNode | null;
  renderDeleteDialog(h: CreateElement): VNode;
  renderInsertDialog(h: CreateElement): VNode;
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
  /** Persistence key of the manual widths of the active grid. */
  widthKey: string;
  /** Field under the keyboard cursor, if any. */
  activeField: Field | undefined;
  /** `id` of the cell under the keyboard cursor, for `aria-activedescendant`. */
  activeCellId: string | null;
  /** Row editing is armed: table mode, writable profile, primary key present. */
  canEdit: boolean;
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
      activeCell: undefined,
      loading: false,
      sortSnapshot: undefined,
      sortChangedAt: 0,
      sortTimer: null,
      restoringSort: false,
      sortHandlesLabelled: false,
      resizeObserver: null,
      observedHost: null,
      editCell: undefined,
      deleteTarget: undefined,
      insertDraft: undefined,
      writeError: undefined,
      writing: false,
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
      // A refused write keeps its own words: the grid it belongs to is still
      // fine, and the message says what the host would not do.
      if (this.writeError) {
        return { kind: "error", text: this.writeError };
      }
      if (init.writeNotice) {
        return { kind: init.writeNotice.kind, text: init.writeNotice.text };
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
    widthKey(): string {
      return this.grid ? widthSignature(this.grid) : "";
    },
    activeField(): Field | undefined {
      const col = this.activeCell?.col ?? -1;
      return col >= 0 ? this.activeFields[col] : undefined;
    },
    activeCellId(): string | null {
      const cell = this.activeCell;
      return cell ? `dd-cell-${cell.row}-${cell.col}` : null;
    },
    canEdit(): boolean {
      return isTableMode && init.editable === true;
    },
  },

  watch: {
    // The keyboard cursor must survive every repaint: tab switch, search,
    // sort, page change - it is clamped instead of left pointing nowhere.
    active(): void {
      this.clampActiveCell();
    },
    displayRows(): void {
      this.clampActiveCell();
    },
    // A column appearing or disappearing makes the library build its header
    // afresh, so the caret it renders has to be relabelled again.
    activeFields(): void {
      this.sortHandlesLabelled = false;
      this.$nextTick(() => this.labelSortHandles());
    },
  },

  mounted(): void {
    window.addEventListener("resize", this.onWindowResize);
    // Escape closes whatever overlay is open, outermost first, and returns
    // focus to the grid instead of leaving it on a removed element.
    window.addEventListener("keydown", this.onGlobalKeydown);
    // Answers to write attempts arrive as window messages: a refusal keeps the
    // editor open with its text and turns into a banner.
    window.addEventListener("message", this.onHostMessage);
    this.$nextTick(() => {
      this.remeasure();
      this.restoreScroll();
      this.observeGridHost();
      this.labelSortHandles();
    });
    if (isTableMode) {
      postMessage({ type: "ready" });
    }
  },

  /**
   * Finishes what `mounted` could not: umy-table builds its headers in a
   * flush scheduled after `mounted` queues its own work, so the sort carets
   * do not exist yet when the first attempt runs. The flag keeps this a
   * boolean check on every render that follows the one where they appeared.
   */
  updated(): void {
    if (!this.sortHandlesLabelled) {
      this.labelSortHandles();
    }
  },

  // Nothing outlives the document: the host repaints it on every answer, and
  // the webview may also be disposed with the panel.
  beforeDestroy(): void {
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("keydown", this.onGlobalKeydown);
    window.removeEventListener("message", this.onHostMessage);
    this.clearPendingSort();
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.observedHost = null;
  },

  methods: {
    remeasure(): void {
      const host = this.$refs.gridHost;
      if (host instanceof HTMLElement) {
        this.gridHostHeight = Math.max(120, host.clientHeight);
      }
    },
    onWindowResize(): void {
      this.remeasure();
    },
    /**
     * Observes the grid host itself: the toolbar, banner and SQL band all
     * change its height, and the library needs the real one. Falls back to the
     * window resize event where the API does not exist.
     */
    observeGridHost(): void {
      const host = this.$refs.gridHost;
      const Ctor = (window as { ResizeObserver?: ResizeObserverCtor })
        .ResizeObserver;
      if (!(host instanceof HTMLElement) || typeof Ctor !== "function") return;
      if (this.resizeObserver) {
        if (this.observedHost === host) return;
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }
      this.resizeObserver = new Ctor(() => this.remeasure());
      this.resizeObserver.observe(host);
      this.observedHost = host;
    },
    /**
     * Escape closes whatever overlay is open, outermost first, and returns
     * focus to the grid instead of leaving it on a removed element.
     */
    onGlobalKeydown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      if (this.editCell) {
        this.closeCellEditor();
      } else if (this.detail) {
        this.closeDetail();
      } else if (this.deleteTarget !== undefined || this.insertDraft) {
        this.closeWriteDialog();
      } else if (this.copyMenu) {
        this.closeCopyMenu();
      } else if (this.columnsOpen || this.exportOpen || this.filterDraft) {
        this.closePopovers();
      } else {
        return;
      }
      const host = this.$refs.gridHost;
      if (host instanceof HTMLElement) {
        host.focus();
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
    /**
     * Posts an intent that repaints the page: state first, then a loading flag
     * the overlay reads until the new document replaces this one.
     */
    send(message: Record<string, unknown>): void {
      if (isTableMode) {
        this.loading = true;
      }
      this.captureScroll();
      postMessage(message);
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
      this.send({ type: "refresh", search: this.search });
    },
    page(delta: number): void {
      const total = Math.max(0, (init.pageCount ?? 1) - 1);
      const next = Math.min(Math.max(0, this.pageIndex + delta), total);
      if (next === this.pageIndex) return;
      this.pageIndex = next;
      this.send({ type: "page", offset: next * (init.pageSize ?? 100) });
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
      // Whatever sent us here already carries the current sort.
      this.clearPendingSort();
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
      this.send(message);
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
      if (this.restoringSort) return;
      // A double-click on a header fires two sort changes. Remember the state
      // before the first one, so a double-click that only wanted an auto-fit
      // can put it back (see `undoSortPair`).
      const now = Date.now();
      if (now - this.sortChangedAt > SORT_PAIR_WINDOW_MS) {
        this.sortSnapshot = { sort: this.sort, clientSort: this.clientSort };
      }
      this.sortChangedAt = now;
      if (isTableMode) {
        this.sort = order
          ? { column: field.name, direction: order }
          : undefined;
        // One double-click must cost one request, not two.
        this.scheduleApplyQuery();
      } else {
        this.clientSort = order
          ? { column: field.field, direction: order }
          : undefined;
      }
    },
    scheduleApplyQuery(): void {
      this.clearPendingSort();
      this.sortTimer = window.setTimeout(() => {
        this.sortTimer = null;
        this.applyQuery();
      }, SORT_DEBOUNCE_MS);
    },
    clearPendingSort(): void {
      if (this.sortTimer !== null) {
        window.clearTimeout(this.sortTimer);
        this.sortTimer = null;
      }
    },
    undoSortPair(): void {
      if (Date.now() - this.sortChangedAt > SORT_PAIR_WINDOW_MS) return;
      const before = this.sortSnapshot;
      this.sortSnapshot = undefined;
      if (!before || before.sort !== undefined || before.clientSort !== undefined) {
        return; // it was already sorting: keep the reported state real
      }
      if (isTableMode) {
        if (this.sortTimer === null) return; // the request is already gone
        this.clearPendingSort();
      }
      this.sort = undefined;
      this.clientSort = undefined;
      const table = gridTable(this.$refs.grid);
      if (table && typeof table.clearSort === "function") {
        this.restoringSort = true;
        try {
          table.clearSort();
        } finally {
          this.restoringSort = false;
        }
      }
    },
    /**
     * Replaces the tooltips umy-table puts on its own sort carets.
     *
     * Those two carets are what actually sorts the grid, and they are the
     * library's markup, not ours: its template gives them a `title` that ships
     * in Chinese. They cannot be dropped (the click handler lives on them) and
     * Vue does not own them after render, so they are relabelled once they
     * exist - which is not the mount tick: the library still builds its
     * headers in a later flush, so this also runs from `updated` while it has
     * not found one yet. Writing an attribute on a library node needs no
     * teardown: it is discarded with the document.
     *
     * Returns how many carets were found, so the caller knows whether the
     * library has caught up yet.
     */
    labelSortHandles(): number {
      const handles = document.querySelectorAll<HTMLElement>(".plx-cell--sort i");
      for (let index = 0; index < handles.length; index += 1) {
        const handle = handles[index];
        const label = handle.classList.contains("plx-sort--asc-btn")
          ? "Sort ascending: lowest to highest"
          : handle.classList.contains("plx-sort--desc-btn")
            ? "Sort descending: highest to lowest"
            : null;
        if (label !== null && handle.title !== label) {
          handle.title = label;
        }
      }
      // The selection column's header toggle is the library's markup too, and
      // it ships the same Chinese wording ("select all / clear"). It is walked
      // in the same pass because it is rendered with those carets: every field
      // is sortable, so the two always appear in the same header flush.
      const selectAll = document.querySelector<HTMLElement>(
        ".plx-table--header .plx-cell--checkbox",
      );
      if (selectAll !== null && selectAll.title !== SELECT_ALL_TITLE) {
        selectAll.title = SELECT_ALL_TITLE;
      }
      // Zero carets means the headers are not in the DOM yet: stay dirty so
      // the next render tries again instead of assuming the work is done.
      this.sortHandlesLabelled = handles.length > 0;
      return handles.length;
    },
    columnKey(field: Field): string {
      return `${this.grid?.id ?? "grid"}::${field.field}`;
    },
    /** Saved manual width of this column, or undefined while it auto-sizes. */
    manualWidth(field: Field): number | undefined {
      const saved = this.widthKey === "" ? undefined : this.widths[this.widthKey]?.[field.field];
      if (typeof saved === "number" && Number.isFinite(saved)) {
        return Math.max(RESIZE_MIN_WIDTH, Math.round(saved));
      }
      return undefined;
    },
    /** Auto-fit width of this column: header, SQL type and the first rows. */
    autoWidth(field: Field): number {
      return Math.min(RESIZE_MAX_AUTO_WIDTH, computeWidth(field, this.displayRows));
    },
    /** Stores one manual width under the table/column signature of this grid. */
    setColumnWidth(fieldKey: string, width: number): void {
      const key = this.widthKey;
      if (key === "") return;
      const next = Math.max(RESIZE_MIN_WIDTH, Math.round(width));
      const current = this.widths[key] ?? {};
      // Vue 2 reactivity for a dynamic key.
      this.$set(this.widths, key, { ...current, [fieldKey]: next });
    },
    /**
     * umy-table finished a header drag: keep exactly the width it chose.
     *
     * The library is the only authority while a drag runs, so this stores the
     * result for the next document; both sides then hold the same number.
     */
    onHeaderDragend(event: unknown): void {
      const candidate = event as {
        column?: { resizeWidth?: unknown; property?: unknown; field?: unknown };
      } | null;
      const column = candidate?.column;
      if (!column) return;
      const width = Number(column.resizeWidth);
      if (!Number.isFinite(width) || width < RESIZE_MIN_WIDTH) return;
      const rawProp =
        typeof column.property === "string"
          ? column.property
          : typeof column.field === "string"
            ? column.field
            : undefined;
      if (!rawProp) return;
      const field = this.activeFields.find((f) => f.field === rawProp);
      if (!field) return;
      this.setColumnWidth(field.field, width);
      this.persistState();
    },
    /**
     * Hands the widths back to umy-table after a change the library did not
     * make itself (auto-fit, reset).
     *
     * A column prop change alone never repaints: `Column.update()` only
     * assigns. `resetColumn(true)` drops the transient `resizeWidth`s and
     * re-lays out from the props, `recalculate` writes the result into the DOM.
     */
    syncLibraryWidths(): void {
      const table = gridTable(this.$refs.grid);
      if (!table) return;
      try {
        if (typeof table.resetColumn === "function") {
          table.resetColumn(true);
        } else if (typeof table.refreshColumn === "function") {
          table.refreshColumn();
        }
        if (typeof table.recalculate === "function") {
          void table.recalculate(true);
        }
      } catch {
        // Layout internals are version-bound; a miss must not break the view.
      }
    },
    autoFitColumn(field: Field): void {
      this.setColumnWidth(field.field, this.autoWidth(field));
      this.persistState();
      this.syncLibraryWidths();
    },
    autoFitAllColumns(): void {
      this.activeFields.forEach((field) =>
        this.setColumnWidth(field.field, this.autoWidth(field)),
      );
      this.persistState();
      this.syncLibraryWidths();
    },
    /** Accessible way out of a messy layout: forget this table's widths. */
    resetColumnWidths(): void {
      const key = this.widthKey;
      if (key !== "" && this.widths[key]) {
        const next = { ...this.widths };
        delete next[key];
        this.widths = next;
        this.persistState();
      }
      this.syncLibraryWidths();
    },
    /**
     * One cell. The value is always a text child, never HTML, so a hostile
     * result cannot inject markup into the page - and while a cell is being
     * edited, it becomes an input whose text is posted as a value, not as SQL.
     */
    // --- grid interaction: pointer + keyboard cursor ---------------------------
    /**
     * Clicking a cell parks the keyboard cursor there. Focus only follows when
     * the click left no text selection, so drag-selecting a value in order to
     * copy it never steals focus.
     */
    onGridClick(event: MouseEvent): void {
      const host = this.$refs.gridHost;
      if (!(host instanceof HTMLElement)) return;
      const cell =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-dd-row]")
          : null;
      if (!cell) return;
      const row = Number(cell.dataset.ddRow);
      const col = Number(cell.dataset.ddCol);
      if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0) {
        return;
      }
      this.activateCell(row, col);
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        host.focus({ preventScroll: true });
      }
    },
    /**
     * Double-click auto-fits the column under the pointer - on the resize
     * handle, or on the header itself, where the two clicks also sorted and so
     * that sort is undone first (see `undoSortPair`).
     */
    onGridDblClick(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof Element)) return;
      let dataset: DOMStringMap | undefined;
      const handle = target.closest(".plx-resizable");
      if (handle) {
        dataset = handle
          .closest("th")
          ?.querySelector<HTMLElement>("[data-dd-field]")?.dataset;
      } else {
        const header = target.closest<HTMLElement>("[data-dd-field]");
        if (header) {
          dataset = header.dataset;
          this.undoSortPair();
        }
      }
      const key = dataset?.ddField;
      if (!key) {
        // Body cell: double-click opens the editor where editing is armed.
        const cell = target.closest<HTMLElement>("[data-dd-row]");
        const rowIndex = cell ? Number(cell.dataset.ddRow) : Number.NaN;
        const colIndex = cell ? Number(cell.dataset.ddCol) : Number.NaN;
        const field = this.activeFields[colIndex];
        if (cell && Number.isFinite(rowIndex) && field) {
          const editing = this.editCell;
          if (editing && editing.row === rowIndex && editing.field === field.field) {
            return;
          }
          this.activateCell(rowIndex, colIndex);
          this.openCellEditor(rowIndex, field);
        }
        return;
      }
      const field = this.activeFields.find((f) => f.field === key);
      if (!field) return;
      event.preventDefault();
      this.autoFitColumn(field);
    },
    /**
     * Arrow/Home/End/PageUp/PageDown move the cursor, Enter edits a writable
     * cell (or opens a read-only detail otherwise), Ctrl/Cmd+C copies. Tab and
     * every other key stay with the browser: focus is never trapped in the grid.
     */
    onGridKeydown(event: KeyboardEvent): void {
      const host = this.$refs.gridHost;
      // Only the host itself drives the cursor; keys over a button or an input
      // remain the browser's business.
      if (!(host instanceof HTMLElement) || event.target !== host) return;
      if (event.altKey) return;
      const rows = this.displayRows.length;
      const cols = this.activeFields.length;
      if (rows === 0 || cols === 0) return;

      const key = event.key;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        key.toLowerCase() === "c"
      ) {
        // A live text selection wins: copy exactly what the user highlighted.
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        if (this.hasSelection) {
          this.runCopy("quick");
        } else {
          this.copyActiveCell();
        }
        event.preventDefault();
        return;
      }
      const modified = event.ctrlKey || event.metaKey;
      if (modified && key !== "Home" && key !== "End") return;

      const current = this.activeCell ?? { row: 0, col: 0 };
      const rowHeight = this.compact ? 28 : 36;
      const pageStep = Math.max(
        1,
        Math.floor((this.gridHostHeight - 48) / rowHeight),
      );
      let next: { row: number; col: number } | null = null;
      switch (key) {
        case "ArrowUp":
          next = { row: current.row - 1, col: current.col };
          break;
        case "ArrowDown":
          next = { row: current.row + 1, col: current.col };
          break;
        case "ArrowLeft":
          next = { row: current.row, col: current.col - 1 };
          break;
        case "ArrowRight":
          next = { row: current.row, col: current.col + 1 };
          break;
        case "Home":
          next = { row: event.ctrlKey ? 0 : current.row, col: 0 };
          break;
        case "End":
          next = { row: event.ctrlKey ? rows - 1 : current.row, col: cols - 1 };
          break;
        case "PageUp":
          next = { row: current.row - pageStep, col: current.col };
          break;
        case "PageDown":
          next = { row: current.row + pageStep, col: current.col };
          break;
        case "Enter":
          event.preventDefault();
          this.openActiveDetail();
          return;
        default:
          return;
      }
      event.preventDefault();
      this.activateCell(next.row, next.col);
    },
    /** Ctrl+C with nothing ticked and no selection copies one cell's value. */
    copyActiveCell(): void {
      const field = this.activeField;
      const row = this.activeCell
        ? this.displayRows[this.activeCell.row]
        : undefined;
      if (!field || !row) return;
      const value = row[field.field];
      const text = value == null ? "" : String(value);
      if (text !== "") {
        postMessage({ type: "copy", text });
      }
    },
    activateCell(row: number, col: number): void {
      const rows = this.displayRows.length;
      const cols = this.activeFields.length;
      if (rows === 0 || cols === 0) {
        this.activeCell = undefined;
        return;
      }
      this.activeCell = {
        row: Math.min(Math.max(0, row), rows - 1),
        col: Math.min(Math.max(0, col), cols - 1),
      };
      this.focusActiveCell();
    },
    /** Keeps the cursor pointing at a cell after a repaint changed the grid. */
    clampActiveCell(): void {
      const cell = this.activeCell;
      if (!cell) return;
      const rows = this.displayRows.length;
      const cols = this.activeFields.length;
      if (rows === 0 || cols === 0) {
        this.activeCell = undefined;
        return;
      }
      if (cell.row >= rows || cell.col >= cols || cell.row < 0 || cell.col < 0) {
        this.activeCell = {
          row: Math.min(Math.max(0, cell.row), rows - 1),
          col: Math.min(Math.max(0, cell.col), cols - 1),
        };
      }
    },
    focusActiveCell(): void {
      this.$nextTick(() => {
        const host = this.$refs.gridHost;
        if (!(host instanceof HTMLElement)) return;
        const cell = host.querySelector(".dd-cell.is-active");
        if (cell instanceof HTMLElement) {
          // Nearest edge in both axes: the scroll wrappers move, the page does
          // not (the layout never scrolls).
          cell.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      });
    },

    cellVNode(h: CreateElement, scope: unknown): VNode {
      const rowIndex = scopeRowIndex(scope);
      const colIndex = this.activeFields.findIndex(
        (f) => f.field === scopeKey(scope),
      );
      const cursor = this.activeCell;
      const active =
        rowIndex >= 0 &&
        colIndex >= 0 &&
        cursor !== undefined &&
        cursor.row === rowIndex &&
        cursor.col === colIndex;
      const attrs: Record<string, string | number> = {
        "data-dd-row": rowIndex,
        "data-dd-col": colIndex,
      };
      if (active) {
        // The grid host points `aria-activedescendant` at this node.
        attrs.id = `dd-cell-${rowIndex}-${colIndex}`;
        attrs.tabindex = -1;
      }
      const classes = active ? ["dd-cell", "is-active"] : ["dd-cell"];

      // The cell being typed into is an editor, not text: same box, same
      // cursor id, so the keyboard position never moves while editing.
      const editing = this.editCell;
      if (
        editing &&
        rowIndex >= 0 &&
        editing.row === rowIndex &&
        editing.field === scopeFieldName(scope)
      ) {
        const field = this.fields.find((candidate) => candidate.field === editing.field);
        const editorClasses = active
          ? ["dd-cell", "dd-cell-editing", "is-active"]
          : ["dd-cell", "dd-cell-editing"];
        if (editing.isNull) {
          editorClasses.push("is-null");
        }
        const editorChildren: VNode[] = [
          h("input", {
            class: "dd-cell-input",
            attrs: {
              type: "text",
              "aria-label": `Value of ${field?.name ?? editing.field}`,
              // Read-only while the host still has the write, so the text on
              // screen always describes exactly what was sent.
              readonly: this.writing,
            },
            domProps: { value: editing.text },
            on: {
              input: (event: Event) => {
                this.editCell = {
                  ...editing,
                  text: (event.target as HTMLInputElement).value,
                  isNull: false,
                };
              },
              keydown: (event: KeyboardEvent) => this.onEditorKeydown(event),
              blur: () => this.commitCellEditor(),
            },
          }),
        ];
        if (field?.nullable === true) {
          editorChildren.push(
            h(
              "button",
              {
                class: ["dd-cell-null", editing.isNull ? "is-active" : ""],
                attrs: {
                  type: "button",
                  title: "Write NULL into this cell",
                  "aria-pressed": editing.isNull ? "true" : "false",
                  disabled: this.writing,
                },
                // Pointer-down keeps the focus in the input: a click that
                // blurred it first would commit the value the switch replaces.
                on: {
                  mousedown: (event: MouseEvent) => event.preventDefault(),
                  click: () => this.toggleEditorNull(),
                },
              },
              "NULL",
            ),
          );
        }
        return h("div", { class: editorClasses, attrs }, editorChildren);
      }

      const value = readScopeValue(scope);
      if (value == null) {
        // NULL is data: it reads as its own word, never as an empty cell.
        return h("div", { class: classes, attrs }, [
          h("span", { class: "dd-null" }, "(NULL)"),
        ]);
      }
      const text = String(value);
      // Long values are clipped by the cell, so the full content stays
      // reachable twice: a native tooltip, and the read-only detail panel.
      const long = text.length > 32;
      if (long) {
        attrs.title = text;
      } else if (text === "") {
        // Empty string: nothing to display, but told apart from NULL and from
        // the four letters "NULL" the moment the pointer rests on the cell.
        classes.push("dd-cell--empty");
        attrs.title = "(empty string)";
      }
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
                    event.currentTarget instanceof Element
                      ? event.currentTarget
                      : null,
                  );
                },
              },
            },
            [iconVNode(h, DETAIL_SVG)],
          ),
        );
      }
      return h("div", { class: classes, attrs }, children);
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

    openDetail(field: Field, rowIndex: number, anchor: Element | null): void {
      const rect = anchorRectOf(anchor, 320, 200);
      this.detail = { ...rect, rowIndex, field: field.field };
    },

    /** Enter on the keyboard cursor edits the cell, or opens its detail. */
    openActiveDetail(): void {
      const cursor = this.activeCell;
      if (!cursor) return;
      const field = this.activeField;
      const row = this.displayRows[cursor.row];
      if (!field || !row) return;
      // Writable column: Enter starts the edit instead of the read-only panel.
      if (this.canEditField(field)) {
        this.openCellEditor(cursor.row, field);
        return;
      }
      const value = row[field.field];
      if (value == null || String(value).length <= 32) return;
      const host = this.$refs.gridHost;
      const anchor =
        host instanceof HTMLElement
          ? host.querySelector(".dd-cell.is-active")
          : null;
      this.openDetail(field, cursor.row, anchor);
    },

    closeDetail(): void {
      this.detail = undefined;
    },

    // --- row editing (table mode, armed by `init.editable`) --------------------

    /** A column can be typed into when editing is armed and its value round-trips. */
    canEditField(field: Field): boolean {
      return this.canEdit && field.editable !== false && !this.writing;
    },

    openCellEditor(rowIndex: number, field: Field): void {
      if (!this.canEditField(field)) return;
      const row = this.displayRows[rowIndex];
      if (!row) return;
      const value = row[field.field];
      this.writeError = undefined;
      this.editCell = {
        row: rowIndex,
        field: field.field,
        text: value == null ? "" : String(value),
        isNull: value === null,
      };
      this.$nextTick(() => {
        const host = this.$refs.gridHost;
        const input =
          host instanceof HTMLElement ? host.querySelector<HTMLInputElement>(".dd-cell-input") : null;
        if (input) {
          input.focus();
          input.select();
        }
      });
    },

    closeCellEditor(): void {
      this.editCell = undefined;
    },

    /**
     * Sends the typed value, or closes the editor when nothing actually
     * changed. The editor stays open while the write is in flight, so a
     * refusal from the host never loses what the user typed.
     */
    commitCellEditor(): void {
      const edit = this.editCell;
      if (!edit || this.writing) return;
      const row = this.displayRows[edit.row];
      const field = this.fields.find((candidate) => candidate.field === edit.field);
      if (!row || !field) {
        this.editCell = undefined;
        return;
      }
      const current = row[edit.field];
      const next = edit.isNull ? null : edit.text;
      // The grid serializes numbers, the editor always produces text: compare
      // what the database would store, not the JavaScript type.
      const unchanged =
        current === next ||
        (current !== null && current !== undefined && next !== null && String(current) === String(next));
      if (unchanged) {
        this.editCell = undefined;
        return;
      }
      this.postWrite({ type: "update", row: edit.row, column: field.name, value: next });
    },

    toggleEditorNull(): void {
      const edit = this.editCell;
      if (!edit || this.writing) return;
      this.editCell = { ...edit, isNull: !edit.isNull };
    },

    onEditorKeydown(event: KeyboardEvent): void {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        this.commitCellEditor();
        return;
      }
      if (event.key === "Escape") {
        // Handled here so the window-level Escape also stops at the editor
        // instead of closing a panel behind it in the same keypress.
        event.preventDefault();
        event.stopPropagation();
        this.closeCellEditor();
      }
    },

    /** Every write leaves this way; the host answers with a repaint or a refusal. */
    postWrite(message: Record<string, unknown>): void {
      this.writing = true;
      this.writeError = undefined;
      postMessage({ ...message, revision: init.revision });
    },

    onHostMessage(event: MessageEvent): void {
      const data = event.data as { type?: unknown; ok?: unknown; message?: unknown } | null;
      if (!data || typeof data !== "object" || data["type"] !== "write") {
        return;
      }
      this.writing = false;
      if (data["ok"] === true) {
        this.writeError = undefined;
        this.editCell = undefined;
        this.deleteTarget = undefined;
        this.insertDraft = undefined;
        return;
      }
      this.writeError =
        typeof data["message"] === "string" && data["message"] !== ""
          ? data["message"]
          : "The write was refused.";
    },

    requestDeleteRow(rowIndex: number): void {
      if (!this.canEdit || this.writing) return;
      if (!this.displayRows[rowIndex]) return;
      this.closePopovers();
      this.closeDetail();
      this.writeError = undefined;
      this.deleteTarget = rowIndex;
      this.$nextTick(() => {
        const button = document.querySelector<HTMLElement>(".dd-dialog-actions button");
        button?.focus();
      });
    },

    confirmDeleteRow(): void {
      const rowIndex = this.deleteTarget;
      this.deleteTarget = undefined;
      if (rowIndex === undefined || this.writing) return;
      this.postWrite({ type: "delete", row: rowIndex });
    },

    closeWriteDialog(): void {
      this.deleteTarget = undefined;
      this.insertDraft = undefined;
    },

    openInsertDialog(): void {
      if (!this.canEdit || this.writing) return;
      this.closePopovers();
      this.writeError = undefined;
      this.insertDraft = this.fields.map((field) => ({
        field: field.field,
        name: field.name,
        type: field.type,
        nullable: field.nullable === true,
        autoIncrement: field.autoIncrement === true,
        text: "",
        isNull: false,
      }));
      this.$nextTick(() => {
        document.querySelector<HTMLInputElement>(".dd-dialog-input")?.focus();
      });
    },

    setInsertText(field: string, text: string): void {
      const draft = this.insertDraft;
      if (!draft || this.writing) return;
      // Typing a value turns the NULL switch off: the two never both apply.
      this.insertDraft = draft.map((entry) =>
        entry.field === field ? { ...entry, text, isNull: false } : entry,
      );
    },

    setInsertNull(field: string, isNull: boolean): void {
      const draft = this.insertDraft;
      if (!draft || this.writing) return;
      this.insertDraft = draft.map((entry) =>
        entry.field === field ? { ...entry, isNull } : entry,
      );
    },

    /**
     * Sends the columns the user actually filled in. An empty field is left
     * out of the statement so the engine supplies its own default, and the
     * NULL switch is the only way to write NULL on purpose.
     */
    submitInsert(): void {
      const draft = this.insertDraft;
      if (!draft || this.writing) return;
      const values: Record<string, GridCellValue> = {};
      for (const entry of draft) {
        if (entry.isNull) {
          values[entry.name] = null;
        } else if (entry.text !== "") {
          values[entry.name] = entry.text;
        }
      }
      this.postWrite({ type: "insert", values });
    },

    renderDialogs(h: CreateElement): VNode | null {
      if (this.deleteTarget !== undefined) {
        return this.renderDeleteDialog(h);
      }
      return this.insertDraft ? this.renderInsertDialog(h) : null;
    },

    renderDeleteDialog(h: CreateElement): VNode {
      const rowIndex = this.deleteTarget ?? -1;
      const table = this.grid?.table ?? "";
      return h("div", { class: "dd-dialog-layer" }, [
        h("div", {
          class: "dd-dialog-backdrop",
          on: { click: () => this.closeWriteDialog() },
        }),
        h(
          "div",
          {
            class: "dd-dialog",
            attrs: { role: "alertdialog", "aria-label": "Delete row" },
            on: { click: (event: MouseEvent) => event.stopPropagation() },
          },
          [
            h("div", { class: "dd-dialog-title" }, "Delete row"),
            h(
              "p",
              { class: "dd-dialog-text" },
              `Row ${rowIndex + 1} of ${table} will be deleted. This cannot be undone.`,
            ),
            h("div", { class: "dd-dialog-actions" }, [
              h(
                "button",
                {
                  class: "dd-btn-secondary",
                  attrs: { type: "button" },
                  on: { click: () => this.closeWriteDialog() },
                },
                "Cancel",
              ),
              h(
                "button",
                {
                  class: "dd-btn-danger",
                  attrs: { type: "button", disabled: this.writing },
                  on: { click: () => this.confirmDeleteRow() },
                },
                [iconVNode(h, TRASH_SVG), "Delete row"],
              ),
            ]),
          ],
        ),
      ]);
    },

    renderInsertDialog(h: CreateElement): VNode {
      const draft = this.insertDraft ?? [];
      const table = this.grid?.table ?? "";
      const rows = draft.map((entry) =>
        h("div", { class: "dd-dialog-row" }, [
          h("span", { class: "dd-dialog-label" }, [
            h("span", { class: "dd-dialog-col" }, entry.name),
            entry.type ? h("span", { class: "dd-dialog-type" }, entry.type) : null,
            entry.autoIncrement ? h("span", { class: "dd-dialog-type" }, "auto") : null,
          ]),
          h("input", {
            class: "dd-dialog-input",
            attrs: {
              type: "text",
              "aria-label": `Value for ${entry.name}`,
              placeholder: entry.autoIncrement ? "default" : "",
              readonly: this.writing || entry.isNull,
            },
            domProps: { value: entry.isNull ? "" : entry.text },
            on: {
              input: (event: Event) =>
                this.setInsertText(entry.field, (event.target as HTMLInputElement).value),
              keydown: (event: KeyboardEvent) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  this.submitInsert();
                }
              },
            },
          }),
          entry.nullable
            ? h(
                "button",
                {
                  class: ["dd-null-toggle", entry.isNull ? "is-active" : ""],
                  attrs: {
                    type: "button",
                    title: `Write NULL into ${entry.name}`,
                    "aria-pressed": entry.isNull ? "true" : "false",
                    disabled: this.writing,
                  },
                  on: { click: () => this.setInsertNull(entry.field, !entry.isNull) },
                },
                "NULL",
              )
            : h("span", { class: "dd-dialog-spacer" }),
        ]),
      );
      return h("div", { class: "dd-dialog-layer" }, [
        h("div", {
          class: "dd-dialog-backdrop",
          on: { click: () => this.closeWriteDialog() },
        }),
        h(
          "div",
          {
            class: "dd-dialog dd-dialog-insert",
            attrs: { role: "dialog", "aria-label": "Insert row" },
            on: { click: (event: MouseEvent) => event.stopPropagation() },
          },
          [
            h("div", { class: "dd-dialog-title" }, `Insert row into ${table}`),
            h(
              "p",
              { class: "dd-dialog-text" },
              "Leave a field empty to use its default value. Use NULL to write NULL.",
            ),
            h("div", { class: "dd-dialog-body" }, rows),
            h("div", { class: "dd-dialog-actions" }, [
              h(
                "button",
                {
                  class: "dd-btn-secondary",
                  attrs: { type: "button", disabled: this.writing },
                  on: { click: () => this.closeWriteDialog() },
                },
                "Cancel",
              ),
              h(
                "button",
                {
                  class: "dd-btn-primary",
                  attrs: { type: "button", disabled: this.writing },
                  on: { click: () => this.submitInsert() },
                },
                [iconVNode(h, PLUS_SVG), "Insert"],
              ),
            ]),
          ],
        ),
      ]);
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
            attrs: {
              type: "button",
              title: "Select Columns",
              "aria-haspopup": "dialog",
              "aria-expanded": this.columnsOpen ? "true" : "false",
            },
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
            attrs: {
              type: "button",
              title: "Compact rows",
              "aria-pressed": this.compact ? "true" : "false",
            },
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
            attrs: {
              type: "button",
              title: "Export Data",
              "aria-haspopup": "dialog",
              "aria-expanded": this.exportOpen ? "true" : "false",
            },
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
        if (this.canEdit) {
          parts.push(
            h(
              "button",
              {
                class: "dd-btn",
                attrs: {
                  type: "button",
                  title: "Insert Row",
                  "aria-haspopup": "dialog",
                  disabled: this.writing,
                },
                on: { click: () => this.openInsertDialog() },
              },
              [iconVNode(h, PLUS_SVG)],
            ),
          );
        }
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
      // Marks first, then the name: the label reads "[key] id" so the icon
      // belongs to the name instead of floating between it and the filter.
      const labelChildren: VNode[] = [...keyMarkVNodes(h, field)];
      labelChildren.push(h("span", { class: "dd-col-name" }, field.name));
      const rowChildren: VNode[] = [h("div", { class: "dd-col-label" }, labelChildren)];
      if (isTableMode) {
        rowChildren.push(
          h(
            "button",
            {
              class: ["dd-btn", "dd-col-filter", hasFilter ? "is-active" : ""],
              attrs: {
                type: "button",
                title: `Filter ${field.name}`,
                "aria-haspopup": "dialog",
                "aria-expanded":
                  this.filterDraft && this.filterDraft.column === field.name
                    ? "true"
                    : "false",
              },
              on: {
                click: (e: MouseEvent) => this.openFilter(field.name, e),
              },
            },
            [iconVNode(h, iconFunnel())],
          ),
        );
      }
      // Database Client Row_Header: key mark + name first, type on a second
      // muted line. The separator between two headers is umy-table's own
      // `.plx-resizable` handle - a real element themed in the stylesheet (no
      // glyph, no pseudo-element) - so the library owns the drag. This wrapper
      // carries the field key, which is how a double-click finds its column.
      return h(
        "div",
        { class: "dd-col-header", attrs: { "data-dd-field": field.field } },
        [
          h("div", { class: "dd-col-name-row" }, rowChildren),
          field.type ? h("div", { class: "dd-col-type" }, field.type) : null,
        ],
      );
    },

    renderGrid(h: CreateElement): VNode {
      const columns = this.activeFields.map((field) => {
        // Width authority: a saved manual width goes through `width` (the
        // library then treats the column as exact, never stretched), an
        // untouched column goes through `minWidth` so it still grows with the
        // container. `resizable: true` switches on the library's own handle -
        // the grid-level prop of ux-grid is not forwarded, only this one is.
        const manual = this.manualWidth(field);
        return h("ux-table-column", {
          key: this.columnKey(field),
          props: {
            field: field.field,
            title: field.name,
            sortable: "custom",
            resizable: true,
            width: manual,
            minWidth: manual === undefined ? this.autoWidth(field) : RESIZE_MIN_WIDTH,
          },
          scopedSlots: {
            header: () => this.renderColumnHeader(h, field),
            default: (scope: unknown) => this.cellVNode(h, scope),
          },
        });
      });

      // Selection column: the reference grid's checkbox column. It feeds the
      // Copy As scope and gives keyboard users a row-granular target; writing
      // a row lives in the row-action column, never in this one.
      const selectCol = h("ux-table-column", {
        props: {
          type: "checkbox",
          width: 34,
          align: "center",
        },
      });

      // Row actions: the delete affordance, one real button per row. It only
      // exists where the host armed editing, so a read-only page never shows
      // a control that cannot do anything.
      const actionCol = this.canEdit
        ? h(
            "ux-table-column",
            {
              key: "dd-row-actions",
              props: { width: 44, align: "center" },
              scopedSlots: {
                header: () =>
                  h("div", { class: "dd-col-header" }, [
                    h("span", { class: "dd-col-name", attrs: { title: "Row actions" } }, ""),
                  ]),
                default: (scope: unknown) => {
                  const rowIndex = scopeRowIndex(scope);
                  const label = `Delete row ${rowIndex + 1}`;
                  return h("div", { class: "dd-cell dd-cell-action" }, [
                    h(
                      "button",
                      {
                        class: "dd-row-delete",
                        attrs: {
                          type: "button",
                          title: label,
                          "aria-label": label,
                          disabled: this.writing,
                        },
                        on: {
                          click: (event: MouseEvent) => {
                            event.stopPropagation();
                            this.requestDeleteRow(rowIndex);
                          },
                        },
                      },
                      [iconVNode(h, TRASH_SVG)],
                    ),
                  ]);
                },
              },
            },
          )
        : null;

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
            "header-dragend": (evt: unknown) => this.onHeaderDragend(evt),
          },
        },
        [selectCol, ...columns, actionCol],
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
      const children: VNode[] =
        this.displayRows.length > 0
          ? [this.renderGrid(h)]
          : [h("div", { class: "dd-empty" }, "No Data Found")];
      if (this.loading) {
        children.push(
          h(
            "div",
            { class: "dd-grid-loading", attrs: { role: "status" } },
            "Loading\u2026",
          ),
        );
      }
      const table = this.grid?.table ?? "";
      return h(
        "div",
        {
          ref: "gridHost",
          class: ["dd-grid-host", this.compact ? "dd-grid-host--compact" : ""],
          // Focusable region: Tab lands here, arrows move the keyboard cursor,
          // and `aria-activedescendant` reports the cell it rests on.
          attrs: {
            tabindex: "0",
            "aria-label": table ? `Rows of ${table}` : "Query results",
            "aria-busy": this.loading ? "true" : "false",
            "aria-activedescendant": this.activeCellId ?? undefined,
          },
          on: {
            contextmenu: (event: MouseEvent) => this.openCopyMenu(event),
            click: (event: MouseEvent) => this.onGridClick(event),
            dblclick: (event: MouseEvent) => this.onGridDblClick(event),
            keydown: (event: KeyboardEvent) => this.onGridKeydown(event),
          },
        },
        children,
      );
    },

    renderColumnsPopover(h: CreateElement): VNode {
      const rect = this.popoverRect ?? { left: 16, top: 60 };
      return h(
        "div",
        {
          class: "dd-popover",
          style: { top: `${rect.top}px`, left: `${rect.left}px` },
          attrs: { role: "dialog", "aria-label": "Columns" },
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
          // Accessible counterpart to dragging a handle: two buttons that fix
          // the whole layout without a pointer, in the same reachable place.
          h(
            "div",
            { class: "dd-popover-actions" },
            [
              h(
                "button",
                {
                  class: "dd-btn",
                  attrs: {
                    type: "button",
                    title: "Size every column to its content",
                  },
                  on: { click: () => this.autoFitAllColumns() },
                },
                "Auto-fit",
              ),
              h(
                "button",
                {
                  class: "dd-btn",
                  attrs: {
                    type: "button",
                    title: "Forget the widths saved for this table",
                  },
                  on: { click: () => this.resetColumnWidths() },
                },
                "Reset widths",
              ),
            ],
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
          attrs: { role: "dialog", "aria-label": "Export Format" },
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
          attrs: { role: "dialog", "aria-label": `Filter: ${draft.column}` },
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
      this.renderDialogs(h),
    ]);
  },
});

export default ResultApp;

// `el` in a Vue.extend options object is ignored; the instance must be created
// (and therefore mounted) explicitly, exactly like the previous implementation.
new ResultApp();
