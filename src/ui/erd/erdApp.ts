/**
 * DataDock entity relationship diagram - webview application.
 *
 * Draws the diagram the extension host described in `erdProtocol`: boxes for
 * every loaded relation, SVG edges for every engine-declared foreign key whose
 * **two** endpoints are on screen, anchored on the exact columns the
 * constraint names rather than on the centres of the boxes.
 *
 * Everything the user does happens here, with no round trip and no re-layout
 * on a mouse move:
 *
 *  - pan (drag the empty canvas) and zoom (buttons or wheel, around the
 *    pointer), applied as one CSS transform on the world;
 *  - drag a table: its `left`/`top` and the `d` of its edges are recomputed,
 *    the layout engine is never consulted;
 *  - schema selection, table search and "hide unrelated" are pure visual
 *    filters - no SQL is generated here and nothing outside this webview
 *    changes;
 *  - the only message sent back carries a schema selection or the box
 *    positions, which the host persists in `workspaceState`.
 *
 * The bundle is built by the `erdApp` esbuild entry and booted by
 * `renderErPage`, so the strict CSP needs neither `unsafe-inline` nor
 * `unsafe-eval`.
 */

import {
  iconChevron,
  iconEye,
  iconEyeOff,
  iconFit,
  iconHashtagMark,
  iconKeyMark,
  iconLayout,
  iconMinus,
  iconPlus,
  iconResetPositions,
  iconSearch,
} from '../icons';
import {
  ERD_HEADER_HEIGHT,
  ERD_ROW_HEIGHT,
  ERD_TABLE_WIDTH,
  erTableHeight,
  layoutErDiagram,
  type ErPosition,
} from './erdLayout';
import { erDiagramStats, relatedTableIds, type ErDiagram, type ErTable } from './erdModel';
import type { ErAppMessage, ErHostMessage, ErIsland } from './erdProtocol';
import './erdApp.css';

declare global {
  interface Window {
    __DATADOCK_ERD__?: unknown;
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_SCALE = 0.2;
const MAX_SCALE = 3;
/** Bounding box padding used when fitting the diagram into the viewport. */
const FIT_PADDING = 48;

let api: VsCodeApi | undefined;

function send(message: ErAppMessage): void {
  api = api ?? window.acquireVsCodeApi?.();
  api?.postMessage(message);
}

/** Text interpolation for the SVG markup built below. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounded to one decimal: keeps the `d` attribute short and stable. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// --- state ------------------------------------------------------------------------

const island: ErIsland = (() => {
  const raw = window.__DATADOCK_ERD__;
  if (raw && typeof raw === 'object') {
    const value = raw as ErIsland;
    return {
      title: typeof value.title === 'string' ? value.title : '',
      connectionName: typeof value.connectionName === 'string' ? value.connectionName : '',
      database: typeof value.database === 'string' ? value.database : undefined,
    };
  }
  return { title: 'Entity Relationship Diagram', connectionName: '' };
})();

let status: 'loading' | 'ready' | 'error' = 'loading';
let errorMessage = '';
let schemas: string[] = [];
let selected: string[] = [];
let diagram: ErDiagram = { tables: [], relationships: [] };
let positions: Record<string, ErPosition> = {};
let search = '';
let hideUnrelated = false;

const view = { x: 0, y: 0, scale: 1 };

/** Column name → row index per table, so an edge can be anchored on a row. */
const rowIndex = new Map<string, Map<string, number>>();
const tableById = new Map<string, ErTable>();
const boxById = new Map<string, HTMLElement>();
let related = new Set<string>();

let canvas: HTMLDivElement;
let world: HTMLDivElement;
let edges: SVGSVGElement;
let stateBox: HTMLDivElement;
let searchInput: HTMLInputElement;
let zoomLabel: HTMLElement;
let statsLabel: HTMLElement;
let schemasGroup: HTMLDivElement;
let schemaLabel: HTMLElement;
let schemaList: HTMLDivElement;
let unrelatedBtn: HTMLButtonElement;

// --- toolbar ----------------------------------------------------------------------

function iconButton(
  className: string,
  title: string,
  svg: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = el('button', `dd-erd-btn ${className}`);
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = svg;
  button.addEventListener('click', onClick);
  return button;
}

/** Text-only button of the toolbar and of the canvas states. */
function textButton(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const button = el('button', `dd-erd-btn ${className}`.trim());
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function scopeText(): string {
  const parts = [island.connectionName, island.database].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  if (parts.length === 0) {
    return island.title;
  }
  return parts.join(' / ');
}

function buildToolbar(): HTMLDivElement {
  const bar = el('div', 'dd-erd-bar');

  const scope = el('span', 'dd-erd-scope');
  scope.textContent = scopeText();
  scope.title = scopeText();
  bar.appendChild(scope);

  // Schema selector: hidden by the host when the engine exposes a single scope.
  schemasGroup = el('div', 'dd-erd-group dd-erd-schemas');
  const schemaBtn = el('button', 'dd-erd-btn dd-erd-schema-btn');
  schemaBtn.type = 'button';
  schemaBtn.title = 'Choose the schemas to draw';
  schemaBtn.setAttribute('aria-label', 'Choose the schemas to draw');
  schemaLabel = el('span', 'dd-erd-schema-label', 'Schemas');
  const caret = el('span', 'dd-erd-schema-caret');
  caret.innerHTML = iconChevron('down');
  schemaBtn.appendChild(schemaLabel);
  schemaBtn.appendChild(caret);
  const pop = el('div', 'dd-erd-pop');
  pop.hidden = true;
  pop.id = 'dd-erd-schema-pop';
  schemaBtn.setAttribute('aria-expanded', 'false');
  schemaBtn.setAttribute('aria-controls', pop.id);
  schemaBtn.addEventListener('click', () => toggleSchemas(schemaBtn, pop));

  const actions = el('div', 'dd-erd-pop-actions');
  actions.appendChild(
    textButton('Select All', () => send({ type: 'select', schemas: [...schemas] })),
  );
  actions.appendChild(
    textButton('Deselect All', () => send({ type: 'select', schemas: [] })),
  );
  pop.appendChild(actions);
  schemaList = el('div', 'dd-erd-pop-list');
  pop.appendChild(schemaList);
  schemasGroup.appendChild(schemaBtn);
  schemasGroup.appendChild(pop);
  bar.appendChild(schemasGroup);

  bar.appendChild(el('div', 'dd-erd-spacer'));

  // Table search with its own drawn magnifier (no icon font, no glyph).
  const searchGroup = el('label', 'dd-erd-search');
  searchGroup.innerHTML = iconSearch();
  searchInput = el('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search tables and columns';
  searchInput.setAttribute('aria-label', 'Search tables and columns');
  searchInput.addEventListener('input', () => {
    search = searchInput.value;
    scheduleRedraw();
  });
  searchGroup.appendChild(searchInput);
  bar.appendChild(searchGroup);

  const zoomGroup = el('div', 'dd-erd-group');
  zoomGroup.appendChild(iconButton('', 'Zoom out', iconMinus(), () => zoomBy(1 / 1.2)));
  zoomLabel = el('span', 'dd-erd-zoom', '100%');
  zoomGroup.appendChild(zoomLabel);
  zoomGroup.appendChild(iconButton('', 'Zoom in', iconPlus(), () => zoomBy(1.2)));
  zoomGroup.appendChild(iconButton('', 'Fit the diagram to the window', iconFit(), () => fit()));
  bar.appendChild(zoomGroup);

  const layoutGroup = el('div', 'dd-erd-group');
  layoutGroup.appendChild(
    iconButton('', 'Arrange the tables by their relationships', iconLayout(), () => autoLayout()),
  );
  layoutGroup.appendChild(
    iconButton('', 'Reset the table positions', iconResetPositions(), () => resetPositions()),
  );
  unrelatedBtn = iconButton('dd-erd-hide-btn', 'Hide tables without relationships', iconEye(), () => {
    hideUnrelated = !hideUnrelated;
    scheduleRedraw();
  });
  layoutGroup.appendChild(unrelatedBtn);
  bar.appendChild(layoutGroup);

  statsLabel = el('span', 'dd-erd-stats', '');
  bar.appendChild(statsLabel);
  return bar;
}

function toggleSchemas(trigger: HTMLElement, pop: HTMLElement): void {
  pop.hidden = !pop.hidden;
  trigger.setAttribute('aria-expanded', String(!pop.hidden));
}

/** The schema trigger button, read from the DOM so it cannot go stale. */
function schemaGroupTrigger(): HTMLElement | undefined {
  const first = schemasGroup.firstElementChild;
  return first instanceof HTMLElement ? first : undefined;
}

function syncSchemas(): void {
  schemasGroup.hidden = schemas.length <= 1;
  if (schemaLabel) {
    schemaLabel.textContent = `Schemas ${selected.length}/${schemas.length}`;
  }
  schemaList.replaceChildren();
  if (schemas.length === 0) {
    schemaList.appendChild(el('div', 'dd-erd-pop-empty', 'This engine has no schemas.'));
    return;
  }
  for (const schema of schemas) {
    const label = el('label', 'dd-erd-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = selected.includes(schema);
    box.addEventListener('change', () => {
      const next = new Set(selected);
      if (box.checked) {
        next.add(schema);
      } else {
        next.delete(schema);
      }
      postSelect([...next]);
    });
    label.appendChild(box);
    label.appendChild(el('span', undefined, schema));
    schemaList.appendChild(label);
  }
}

function postSelect(next: string[]): void {
  selected = next;
  status = 'loading';
  renderState();
  send({ type: 'select', schemas: next });
}

// --- geometry ---------------------------------------------------------------------

function visibleIds(): Set<string> {
  const query = search.trim().toLowerCase();
  const visible = new Set<string>();
  for (const table of diagram.tables) {
    if (hideUnrelated && !related.has(table.id)) {
      continue;
    }
    if (query !== '') {
      const inName =
        table.name.toLowerCase().includes(query) ||
        (table.schema ?? '').toLowerCase().includes(query);
      const inColumns = table.columns.some((column) => column.name.toLowerCase().includes(query));
      if (!inName && !inColumns) {
        continue;
      }
    }
    visible.add(table.id);
  }
  return visible;
}

/** Vertical anchor of a column row inside a box (header centre when unknown). */
function anchorY(tableId: string, column: string | undefined, fallback: number): number {
  if (column === undefined) {
    return fallback + ERD_HEADER_HEIGHT / 2;
  }
  const index = rowIndex.get(tableId)?.get(column);
  if (index === undefined) {
    return fallback + ERD_HEADER_HEIGHT / 2;
  }
  return fallback + ERD_HEADER_HEIGHT + (index + 0.5) * ERD_ROW_HEIGHT;
}

/** Bezier between two per-column anchors, entering the referenced box's side. */
function edgePath(sourceId: string, sourceColumn: string, targetId: string, targetColumn: string | undefined): string {
  const from = positions[sourceId];
  const to = positions[targetId];
  if (!from || !to) {
    return '';
  }
  const sourceRight = to.x + ERD_TABLE_WIDTH / 2 >= from.x + ERD_TABLE_WIDTH / 2;
  const x1 = sourceRight ? from.x + ERD_TABLE_WIDTH : from.x;
  const x2 = sourceRight ? to.x : to.x + ERD_TABLE_WIDTH;
  const y1 = anchorY(sourceId, sourceColumn, from.y);
  const y2 = anchorY(targetId, targetColumn, to.y);
  const bend = clamp(Math.abs(x2 - x1) * 0.5, 24, 160) * (x2 >= x1 ? 1 : -1);
  return (
    `M ${round(x1)} ${round(y1)} C ${round(x1 + bend)} ${round(y1)}, ` +
    `${round(x2 - bend)} ${round(y2)}, ${round(x2)} ${round(y2)}`
  );
}

function drawEdges(): void {
  const visible = visibleIds();
  const markup: string[] = [];
  for (const relationship of diagram.relationships) {
    if (!visible.has(relationship.sourceTableId) || !visible.has(relationship.targetTableId)) {
      continue;
    }
    const source = tableById.get(relationship.sourceTableId);
    const target = tableById.get(relationship.targetTableId);
    if (!source || !target) {
      continue;
    }
    const d = edgePath(
      relationship.sourceTableId,
      relationship.sourceColumn,
      relationship.targetTableId,
      relationship.targetColumn,
    );
    if (d === '') {
      continue;
    }
    const targetColumn = relationship.targetColumn ?? 'primary key';
    const title =
      `${relationship.constraintName ? `${relationship.constraintName}: ` : ''}` +
      `${source.name}.${relationship.sourceColumn} references ` +
      `${target.name}.${targetColumn}`;
    markup.push(
      `<path class="dd-erd-edge" data-src="${esc(relationship.sourceTableId)}" ` +
        `data-tgt="${esc(relationship.targetTableId)}" d="${d}"><title>${esc(title)}</title></path>`,
    );
  }
  edges.innerHTML = markup.join('');
}

// --- boxes ------------------------------------------------------------------------

function buildBox(table: ErTable): HTMLElement {
  const box = el('div', `dd-erd-box${table.kind === 'view' ? ' dd-erd-box--view' : ''}`);
  box.dataset.id = table.id;
  box.style.width = `${ERD_TABLE_WIDTH}px`;
  box.style.height = `${erTableHeight(table.columns.length)}px`;
  box.setAttribute('role', 'group');
  box.setAttribute(
    'aria-label',
    table.schema ? `${table.name} (${table.schema})` : table.name,
  );

  const head = el('div', 'dd-erd-head');
  const name = el('span', 'dd-erd-name', table.name);
  name.title = table.name;
  head.appendChild(name);
  const tag = el('span', 'dd-erd-scope-tag', table.schema ?? (table.kind === 'view' ? 'view' : ''));
  if (table.schema) {
    tag.title = table.schema;
  }
  head.appendChild(tag);
  box.appendChild(head);

  if (table.columns.length === 0) {
    box.appendChild(el('div', 'dd-erd-empty-col', 'No columns'));
    return box;
  }

  for (const column of table.columns) {
    const row = el('div', 'dd-erd-col');
    const marks = el('span', 'dd-erd-marks');
    if (column.isPrimaryKey) {
      const mark = el('span', 'dd-erd-mark dd-erd-mark--primary');
      mark.title = 'Primary key';
      mark.innerHTML = iconKeyMark();
      marks.appendChild(mark);
    }
    if (column.isForeignKey) {
      const mark = el('span', 'dd-erd-mark dd-erd-mark--foreign');
      mark.title = 'Foreign key';
      mark.innerHTML = iconHashtagMark();
      marks.appendChild(mark);
    }
    if (!column.isPrimaryKey && !column.isForeignKey) {
      // Placeholder of the same width keeps every name aligned in the column.
      marks.appendChild(el('span', 'dd-erd-mark'));
    }
    row.appendChild(marks);

    const label = el('span', 'dd-erd-colname', column.name);
    label.title = column.name;
    row.appendChild(label);
    const type = el('span', 'dd-erd-coltype', column.dataType);
    if (column.dataType !== '') {
      type.title = column.dataType;
    }
    row.appendChild(type);
    box.appendChild(row);
  }

  box.addEventListener('pointerenter', () => lightEdges(table.id, true));
  box.addEventListener('pointerleave', () => lightEdges(table.id, false));
  return box;
}

function lightEdges(tableId: string, on: boolean): void {
  for (const child of Array.from(edges.children)) {
    const path = child as SVGElement;
    if (path.dataset.src === tableId || path.dataset.tgt === tableId) {
      path.classList.toggle('is-lit', on);
    }
  }
}

function renderBoxes(): void {
  for (const box of boxById.values()) {
    box.remove();
  }
  boxById.clear();
  for (const table of diagram.tables) {
    const box = buildBox(table);
    const position = positions[table.id];
    if (position) {
      box.style.left = `${position.x}px`;
      box.style.top = `${position.y}px`;
    }
    world.appendChild(box);
    boxById.set(table.id, box);
  }
}

// --- drawing loop ------------------------------------------------------------------

let frame = 0;

function scheduleRedraw(): void {
  if (frame !== 0) {
    return;
  }
  frame = window.requestAnimationFrame(() => {
    frame = 0;
    redraw();
  });
}

function redraw(): void {
  const visible = visibleIds();
  for (const [id, box] of boxById) {
    box.hidden = !visible.has(id);
  }
  drawEdges();
  syncStats(visible);
  syncToggles();
  renderState();
}

function syncStats(visible: Set<string>): void {
  const stats = erDiagramStats(diagram);
  const relationships = diagram.relationships.filter(
    (relationship) =>
      visible.has(relationship.sourceTableId) && visible.has(relationship.targetTableId),
  ).length;
  const tables = visible.size === stats.tables
    ? `${stats.tables} ${stats.tables === 1 ? 'table' : 'tables'}`
    : `${visible.size} of ${stats.tables} tables`;
  statsLabel.textContent = `${tables} - ${relationships} ${
    relationships === 1 ? 'relationship' : 'relationships'
  }`;
}

function syncToggles(): void {
  unrelatedBtn.classList.toggle('is-on', hideUnrelated);
  unrelatedBtn.title = hideUnrelated
    ? 'Show tables without relationships'
    : 'Hide tables without relationships';
  unrelatedBtn.setAttribute('aria-label', unrelatedBtn.title);
  unrelatedBtn.innerHTML = hideUnrelated ? iconEyeOff() : iconEye();
}

// --- states ------------------------------------------------------------------------

function renderState(): void {
  if (status === 'ready' && diagram.tables.length > 0 && visibleIds().size > 0) {
    stateBox.hidden = true;
    stateBox.replaceChildren();
    return;
  }
  stateBox.hidden = false;
  stateBox.replaceChildren();

  if (status === 'loading') {
    stateBox.appendChild(el('div', 'dd-erd-state-title', 'Loading the diagram...'));
    stateBox.appendChild(
      el('div', 'dd-erd-state-text', 'Reading tables, columns and foreign keys from the connection.'),
    );
    return;
  }
  if (status === 'error') {
    stateBox.appendChild(el('div', 'dd-erd-state-title', 'The diagram could not be loaded'));
    stateBox.appendChild(el('div', 'dd-erd-state-text', errorMessage));
    const retry = textButton('Retry', () => {
      status = 'loading';
      renderState();
      send({ type: 'reload' });
    });
    stateBox.appendChild(retry);
    return;
  }
  if (diagram.tables.length === 0) {
    stateBox.appendChild(el('div', 'dd-erd-state-title', 'No tables in this diagram'));
    stateBox.appendChild(
      el(
        'div',
        'dd-erd-state-text',
        schemas.length > 1 && selected.length === 0
          ? 'No schema is selected. Open the schema selector and pick at least one.'
          : 'The selected scope contains no tables or views.',
      ),
    );
    return;
  }
  stateBox.appendChild(el('div', 'dd-erd-state-title', 'No table matches the current filters'));
  stateBox.appendChild(
    el('div', 'dd-erd-state-text', 'The diagram is still loaded; only what is on screen changed.'),
  );
  const clear = textButton('Clear filters', () => {
    search = '';
    searchInput.value = '';
    hideUnrelated = false;
    scheduleRedraw();
  });
  stateBox.appendChild(clear);
}

// --- view ---------------------------------------------------------------------------

function applyView(): void {
  world.style.transform = `translate(${round(view.x)}px, ${round(view.y)}px) scale(${round(view.scale)})`;
  zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
}

function zoomAt(factor: number, px: number, py: number): void {
  const next = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  if (next === view.scale) {
    return;
  }
  const worldX = (px - view.x) / view.scale;
  const worldY = (py - view.y) / view.scale;
  view.scale = next;
  view.x = px - worldX * next;
  view.y = py - worldY * next;
  applyView();
}

function zoomBy(factor: number): void {
  const rect = canvas.getBoundingClientRect();
  zoomAt(factor, rect.width / 2, rect.height / 2);
}

/** Frames every visible box inside the viewport, then centres it. */
function fit(): void {
  const visible = visibleIds();
  if (visible.size === 0) {
    applyView();
    return;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const id of visible) {
    const position = positions[id];
    const table = tableById.get(id);
    if (!position || !table) {
      continue;
    }
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + ERD_TABLE_WIDTH);
    maxY = Math.max(maxY, position.y + erTableHeight(table.columns.length));
  }
  if (!Number.isFinite(minX)) {
    applyView();
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const width = maxX - minX;
  const height = maxY - minY;
  const scale = clamp(
    Math.min(
      (rect.width - FIT_PADDING * 2) / Math.max(1, width),
      (rect.height - FIT_PADDING * 2) / Math.max(1, height),
      1.5,
    ),
    MIN_SCALE,
    MAX_SCALE,
  );
  view.scale = scale;
  view.x = (rect.width - width * scale) / 2 - minX * scale;
  view.y = (rect.height - height * scale) / 2 - minY * scale;
  applyView();
}

// --- layout actions -----------------------------------------------------------------

/** Re-runs the layout for the loaded tables and keeps the result. */
function autoLayout(): void {
  const base = layoutErDiagram(diagram);
  for (const table of diagram.tables) {
    positions[table.id] = base[table.id];
  }
  renderBoxes();
  redraw();
  fit();
  send({ type: 'positions', positions: { ...positions } });
}

/** Forgets the stored positions and returns to the deterministic layout. */
function resetPositions(): void {
  send({ type: 'positions', positions: null });
  const base = layoutErDiagram(diagram);
  positions = { ...base };
  renderBoxes();
  redraw();
  fit();
}

// --- interaction ---------------------------------------------------------------------

let mode: 'none' | 'pan' | 'drag' = 'none';
/** Client coordinates where the gesture started. */
let startClientX = 0;
let startClientY = 0;
/** View origin (pan) or box origin (drag) when the gesture started. */
let panX = 0;
let panY = 0;
let dragId: string | undefined;
let dragX = 0;
let dragY = 0;

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  // Toolbar, state overlay and the schema popover own their own clicks.
  if (!target || target.closest('button, input, label, .dd-erd-pop, .dd-erd-state')) {
    return;
  }
  const box = target.closest('.dd-erd-box') as HTMLElement | null;
  const id = box?.dataset.id;
  const position = id ? positions[id] : undefined;
  if (box && id && position) {
    mode = 'drag';
    dragId = id;
    dragX = position.x;
    dragY = position.y;
    box.classList.add('is-drag');
  } else {
    mode = 'pan';
    panX = view.x;
    panY = view.y;
    canvas.classList.add('is-panning');
  }
  startClientX = event.clientX;
  startClientY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (mode === 'pan') {
    view.x = panX + (event.clientX - startClientX);
    view.y = panY + (event.clientY - startClientY);
    applyView();
    return;
  }
  if (mode !== 'drag' || !dragId) {
    return;
  }
  const next = {
    x: dragX + (event.clientX - startClientX) / view.scale,
    y: dragY + (event.clientY - startClientY) / view.scale,
  };
  positions[dragId] = next;
  const box = boxById.get(dragId);
  if (box) {
    box.style.left = `${next.x}px`;
    box.style.top = `${next.y}px`;
  }
  scheduleRedraw();
}

function onPointerUp(event: PointerEvent): void {
  const wasDrag = mode === 'drag';
  mode = 'none';
  dragId = undefined;
  canvas.classList.remove('is-panning');
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
  if (wasDrag) {
    for (const box of boxById.values()) {
      box.classList.remove('is-drag');
    }
    send({ type: 'positions', positions: { ...positions } });
  }
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const factor = Math.exp(-event.deltaY * 0.0015);
  zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
}

// --- host messages -------------------------------------------------------------------

function indexDiagram(): void {
  rowIndex.clear();
  tableById.clear();
  related = relatedTableIds(diagram);
  for (const table of diagram.tables) {
    tableById.set(table.id, table);
    const rows = new Map<string, number>();
    table.columns.forEach((column, index) => {
      if (!rows.has(column.name)) {
        rows.set(column.name, index);
      }
    });
    rowIndex.set(table.id, rows);
  }
}

/** Applies saved positions on top of a fresh deterministic layout. */
function seedPositions(saved: Record<string, ErPosition>): void {
  const base = layoutErDiagram(diagram);
  positions = {};
  for (const table of diagram.tables) {
    positions[table.id] = saved[table.id] ?? base[table.id];
  }
  // Positions of tables that are not loaded right now (another schema) must
  // survive a save, otherwise deselecting a schema would erase them.
  for (const [id, position] of Object.entries(saved)) {
    if (!positions[id]) {
      positions[id] = position;
    }
  }
}

function onDiagram(message: ErHostMessage & { type: 'diagram' }): void {
  schemas = message.schemas;
  selected = message.selected;
  diagram = message.diagram;
  indexDiagram();
  seedPositions(message.positions);
  status = 'ready';
  errorMessage = '';
  renderBoxes();
  syncSchemas();
  redraw();
  fit();
}

function onError(message: string): void {
  status = 'error';
  errorMessage = message;
  renderState();
}

function onHostMessage(event: MessageEvent): void {
  const data = event.data as ErHostMessage | undefined;
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
    return;
  }
  if (data.type === 'diagram') {
    onDiagram(data);
  } else if (data.type === 'error') {
    onError(data.message);
  }
}

// --- boot ------------------------------------------------------------------------------

function boot(): void {
  const app = document.getElementById('app');
  if (!app) {
    return;
  }
  const root = el('div', 'dd-erd');
  root.appendChild(buildToolbar());

  canvas = el('div', 'dd-erd-canvas');
  world = el('div', 'dd-erd-world');
  edges = document.createElementNS(SVG_NS, 'svg');
  edges.setAttribute('class', 'dd-erd-edges');
  edges.setAttribute('aria-hidden', 'true');
  world.appendChild(edges);
  canvas.appendChild(world);

  stateBox = el('div', 'dd-erd-state');
  canvas.appendChild(stateBox);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  root.appendChild(canvas);

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    const pop = schemaList.parentElement;
    if (event.key === 'Escape' && pop && !pop.hidden) {
      const trigger = schemaGroupTrigger();
      if (trigger) {
        toggleSchemas(trigger, pop);
      }
      return;
    }
    if (event.key === 'f' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      fit();
    }
  });
  window.addEventListener('message', onHostMessage);
  window.addEventListener('resize', () => scheduleRedraw());

  app.replaceChildren(root);
  syncSchemas();
  applyView();
  renderState();
  send({ type: 'ready' });
}

boot();
