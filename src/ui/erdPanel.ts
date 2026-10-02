/**
 * Entity Relationship Diagram panel (extension host side).
 *
 * The panel opens as a real `WebviewPanel` tab (never an external browser and
 * never a generated file) and owns the only metadata path of the feature: the
 * existing `ConnectionManager` driver plus the existing `MetadataCache`. There
 * is no second metadata system here - tables, columns and foreign keys are the
 * very entries the explorer already caches, and the two new statements are one
 * catalog-wide query each (never one query per table).
 *
 * The host loads metadata and pushes it to the webview; every interaction
 * (pan, zoom, drag, search, schema switching) stays inside the webview. The
 * only state that ever travels back is a schema selection and box positions,
 * which are persisted in `workspaceState` under a connection/database key and
 * contain no credentials, no SQL and no connection options.
 */

import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/connectionManager';
import type { ConnectionStore } from '../connections/connectionStore';
import type {
  ColumnInfo,
  DatabaseDriver,
  ForeignKeyInfo,
  Logger,
  SchemaRef,
  TableInfo,
} from '../db/types';
import { cacheKey } from '../explorer/nodes';
import type { MetadataCache } from '../metadata/metadataCache';
import { parseAppMessage, describeErError, type ErHostMessage } from './erd/erdProtocol';
import type { ErPosition } from './erd/erdLayout';
import { buildErDiagram, type ErRelationInput } from './erd/erdModel';
import { renderErPage } from './erd/erdPage';
import { erdViewAssets, panelIconUri, resultViewWebviewOptions } from './resultView/resultHost';

export interface ErdPanelOptions {
  readonly manager: ConnectionManager;
  readonly store: ConnectionStore;
  readonly cache: MetadataCache;
  readonly logger: Logger;
  readonly context: vscode.ExtensionContext;
  /** The `Tables` folder the command was invoked from. */
  readonly ref: SchemaRef;
  /** Human label of the scope (connection / database / schema). */
  readonly title: string;
}

/** Persisted positions: diagram key → table id → box position. */
type PositionStore = Record<string, Record<string, ErPosition>>;

const POSITIONS_KEY = 'datadock.erd.positions.v1';
/** Keeps `workspaceState` bounded when a workspace has many databases. */
const MAX_DIAGRAM_KEYS = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ErdPanel {
  private static readonly open = new Map<string, ErdPanel>();

  private readonly panel: vscode.WebviewPanel;
  /** Last payload or error, replayed when the webview boots or re-focuses. */
  private last: ErHostMessage | undefined;
  private loading = false;
  private sequence = 0;
  /** Schemas selected in the UI; `undefined` = single-scope engine (use `ref`). */
  private selected: string[] | undefined;

  private constructor(
    private readonly options: ErdPanelOptions,
    panel: vscode.WebviewPanel,
  ) {
    this.panel = panel;
    panel.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw));
    panel.onDidDispose(() => {
      ErdPanel.open.delete(ErdPanel.key(options.ref));
    });
  }

  /** Opens (or reveals) the diagram for this `Tables` folder. */
  static async show(options: ErdPanelOptions): Promise<void> {
    const key = ErdPanel.key(options.ref);
    const existing = ErdPanel.open.get(key);
    if (existing) {
      existing.panel.reveal(undefined, false);
      return;
    }
    const profile = await options.store.get(options.ref.connectionId);
    const panel = vscode.window.createWebviewPanel(
      'datadock.erd',
      options.title,
      vscode.ViewColumn.Active,
      {
        ...resultViewWebviewOptions(),
        retainContextWhenHidden: true,
        enableFindWidget: false,
      },
    );
    panel.iconPath = panelIconUri();
    panel.webview.html = renderErPage(
      erdViewAssets(panel.webview),
      {
        title: options.title,
        connectionName: profile?.name ?? options.title,
        database: options.ref.database,
      },
      options.title,
    );
    const instance = new ErdPanel(options, panel);
    ErdPanel.open.set(key, instance);
  }

  /** One diagram per connection/database/schema scope. */
  private static key(ref: SchemaRef): string {
    return `${ref.connectionId}/${ref.database ?? ''}/${ref.schema ?? ''}`;
  }

  private post(message: ErHostMessage): void {
    this.last = message;
    void this.panel.webview.postMessage(message);
  }

  private onMessage(raw: unknown): void {
    const message = parseAppMessage(raw);
    if (!message) {
      return;
    }
    if (message.type === 'ready') {
      if (this.last) {
        void this.panel.webview.postMessage(this.last);
      } else if (!this.loading) {
        void this.load(this.selected);
      }
      return;
    }
    if (message.type === 'reload') {
      this.last = undefined;
      void this.load(this.selected);
      return;
    }
    if (message.type === 'select') {
      this.selected = message.schemas;
      void this.load(message.schemas);
      return;
    }
    this.savePositions(message.positions);
  }

  // -- persistence ---------------------------------------------------------

  private diagramKey(): string {
    const ref = this.options.ref;
    return `${ref.connectionId}/${ref.database ?? ''}`;
  }

  private positions(): PositionStore {
    const raw = this.options.context.workspaceState.get<unknown>(POSITIONS_KEY);
    return isPlainObject(raw) ? (raw as PositionStore) : {};
  }

  private savePositions(positions: Record<string, ErPosition> | null): void {
    const store = this.positions();
    const key = this.diagramKey();
    if (positions === null) {
      delete store[key];
    } else {
      // Newest first: overwriting the same key keeps its slot, and trimming
      // drops the least recently touched diagram once the cap is reached.
      delete store[key];
      store[key] = positions;
      const keys = Object.keys(store);
      for (const extra of keys.slice(MAX_DIAGRAM_KEYS)) {
        delete store[extra];
      }
    }
    void this.options.context.workspaceState.update(POSITIONS_KEY, store);
  }

  // -- metadata ------------------------------------------------------------

  /** Applies a schema selection to the folder reference. */
  private scope(schema: string | undefined): SchemaRef {
    return schema === undefined ? this.options.ref : { ...this.options.ref, schema };
  }

  /** Default selection when the user has not picked: the invoked schema. */
  private defaultSelection(schemas: readonly string[]): string[] {
    const requested = this.options.ref.schema;
    if (requested && schemas.includes(requested)) {
      return [requested];
    }
    return schemas.slice(0, 1);
  }

  private async load(selected: string[] | undefined): Promise<void> {
    const sequence = ++this.sequence;
    this.loading = true;
    try {
      const driver = this.options.manager.requireDriver(this.options.ref.connectionId);
      const schemas = await this.schemaList(driver);
      const multi = schemas.length > 1;
      const chosen = multi ? selected ?? this.defaultSelection(schemas) : [];
      if (multi) {
        this.selected = chosen;
      }
      const scopes = multi ? chosen.map((schema) => this.scope(schema)) : [this.options.ref];
      const relations: ErRelationInput[] = [];
      const foreignKeys: ForeignKeyInfo[] = [];
      for (const scope of scopes) {
        // One table pass, one column pass, one foreign-key pass per schema.
        const schemaLabel = multi && scope.schema ? scope.schema : undefined;
        const tables = await this.tablesOf(driver, scope);
        const columns = await this.columnsOf(driver, scope, tables);
        relations.push(
          ...tables.map((table, index) => ({
            schema: schemaLabel,
            table,
            columns: columns[index],
          })),
        );
        foreignKeys.push(...(await this.foreignKeysOf(driver, scope)));
      }
      if (sequence !== this.sequence) {
        return;
      }
      this.post({
        type: 'diagram',
        schemas: multi ? schemas : [],
        selected: chosen,
        diagram: buildErDiagram({ relations, foreignKeys }),
        positions: this.positions()[this.diagramKey()] ?? {},
      });
    } catch (error) {
      if (sequence !== this.sequence) {
        return;
      }
      this.options.logger.error(`[erd] ${String(error)}`);
      this.post({ type: 'error', message: describeErError(error) });
    } finally {
      if (sequence === this.sequence) {
        this.loading = false;
      }
    }
  }

  /** Every schema of the connection, cached with the explorer's own entry. */
  private async schemaList(driver: DatabaseDriver): Promise<string[]> {
    const ref = this.options.ref;
    if (!ref.database) {
      return [];
    }
    const list = await this.options.cache.getOrLoad(
      cacheKey(ref.connectionId, ref.database, 'schemas'),
      () => driver.listSchemas(ref.database),
    );
    return [...new Set(list.filter((name) => name.trim() !== ''))].sort((a, b) => a.localeCompare(b));
  }

  /** Tables and views of one scope, shared with the tree's cache entry. */
  private async tablesOf(driver: DatabaseDriver, ref: SchemaRef): Promise<TableInfo[]> {
    return this.options.cache.getOrLoad(
      cacheKey(ref.connectionId, ref.database, ref.schema, 'tables'),
      () => driver.listTables(ref),
    );
  }

  /**
   * Column descriptions for a whole scope. One `listSchemaColumns` call per
   * schema; the per-table `listColumns` loop only runs for a hypothetical
   * driver that does not implement the wide method (all four built-ins do).
   */
  private async columnsOf(
    driver: DatabaseDriver,
    ref: SchemaRef,
    tables: readonly TableInfo[],
  ): Promise<ColumnInfo[][]> {
    // Keep the bound method: a bare `const wide = driver.listSchemaColumns`
    // drops `this`, and the driver then reads `this.connection.query`, which
    // surfaces as "Cannot read property of undefined (reading 'query')".
    const wide = driver.listSchemaColumns?.bind(driver);
    if (wide) {
      const groups = await this.options.cache.getOrLoad(
        cacheKey(ref.connectionId, ref.database, ref.schema, 'schemaColumns'),
        () => wide(ref),
      );
      const byName = new Map(groups.map((group) => [group.table, group.columns]));
      return tables.map((table) => byName.get(table.name) ?? []);
    }
    const out: ColumnInfo[][] = [];
    for (const table of tables) {
      out.push(
        await this.options.cache.getOrLoad(
          cacheKey(ref.connectionId, ref.database, ref.schema, `columns:${table.name}`),
          () => driver.listColumns({ ...ref, table: table.name, kind: table.kind }),
        ),
      );
    }
    return out;
  }

  /** Foreign keys of one scope, cached beside the tables they belong to. */
  private async foreignKeysOf(
    driver: DatabaseDriver,
    ref: SchemaRef,
  ): Promise<ForeignKeyInfo[]> {
    const wide = driver.listForeignKeys?.bind(driver);
    if (!wide) {
      return [];
    }
    return this.options.cache.getOrLoad(
      cacheKey(ref.connectionId, ref.database, ref.schema, 'foreignKeys'),
      () => wide(ref),
    );
  }
}
