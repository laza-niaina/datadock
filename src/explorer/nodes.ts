/**
 * Explorer tree node model.
 *
 * Every node knows how to produce its own children, which keeps the
 * `TreeDataProvider` a thin adapter and makes nodes independent of the
 * provider's internals.
 *
 * Children are loaded **lazily** and through the metadata cache, so expanding a
 * node that was already visited does not touch the server again before the
 * cache entry expires or is invalidated.
 */

import * as vscode from 'vscode';
import type { ConnectionManager, SessionStatus } from '../connections/connectionManager';
import type { ConnectionStore } from '../connections/connectionStore';
import type { DriverRegistry } from '../db/driverRegistry';
import type { DatabaseDriver, ConnectionProfile, ColumnInfo, RoutineInfo, SchemaRef, TableRef } from '../db/types';
import type { MetadataCache } from '../metadata/metadataCache';

export type ExplorerNodeKind =
  | 'connection'
  | 'database'
  | 'schema'
  | 'folder'
  | 'table'
  | 'view'
  | 'routine'
  | 'column'
  | 'message';

export type FolderKind = 'tables' | 'views' | 'procedures' | 'functions';

/** Services a node needs in order to resolve its children. */
export interface ExplorerServices {
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly registry: DriverRegistry;
}

/** Builds a stable, collision-free tree item id from path segments. */
export function nodeId(...parts: Array<string | undefined>): string {
  return parts.filter((part) => part !== undefined && part !== '').join('/');
}

/** Cache key scoped to a single connection. */
export function cacheKey(connectionId: string, ...parts: Array<string | number | undefined>): string {
  return [`profile:${connectionId}`, ...parts.filter((part) => part !== undefined && part !== '')].join('|');
}

const SPIN = 'loading~spin';

export function engineIconForState(state: SessionStatus['state']): vscode.ThemeIcon {
  switch (state) {
    case 'connected':
      return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.green'));
    case 'connecting':
      return new vscode.ThemeIcon(SPIN);
    case 'error':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

export abstract class ExplorerNode extends vscode.TreeItem {
  readonly kind: ExplorerNodeKind;

  constructor(kind: ExplorerNodeKind, label: string, collapsibleState: vscode.TreeItemCollapsibleState) {
    super(label, collapsibleState);
    this.kind = kind;
  }

  /** Children of this node. Leaf nodes return an empty array. */
  abstract getChildren(services: ExplorerServices): Promise<ExplorerNode[]>;

  /** Cache key prefix covering this node and everything below it. */
  abstract cachePrefix(): string;
}

/** Non-interactive informational row (hint, empty state, error summary). */
export class MessageNode extends ExplorerNode {
  constructor(
    label: string,
    readonly detail?: string,
    icon: string = 'info',
    severity: 'info' | 'warning' | 'error' = 'info',
  ) {
    super('message', label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'dbclient.message';
    const color =
      severity === 'error'
        ? new vscode.ThemeColor('errorForeground')
        : severity === 'warning'
          ? new vscode.ThemeColor('editorWarning.foreground')
          : undefined;
    this.iconPath = color ? new vscode.ThemeIcon(icon, color) : new vscode.ThemeIcon(icon);
    if (detail) {
      const tooltip = new vscode.MarkdownString(detail);
      tooltip.supportThemeIcons = true;
      this.tooltip = tooltip;
    }
  }

  /** Convenience factory that renders any thrown value as an error row. */
  static fromError(label: string, error: unknown): MessageNode {
    const message = error instanceof Error ? error.message : String(error);
    return new MessageNode(label, message, 'error', 'error');
  }

  async getChildren(): Promise<ExplorerNode[]> {
    return [];
  }

  cachePrefix(): string {
    return 'message';
  }
}

export class ConnectionNode extends ExplorerNode {
  constructor(
    readonly profile: ConnectionProfile,
    private status: SessionStatus,
  ) {
    super(
      'connection',
      profile.name,
      status.state === 'connected' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    this.id = nodeId('connection', profile.id);
    this.applyStatus(status);
  }

  private static describe(profile: ConnectionProfile, status: SessionStatus): string {
    const engine = profile.engine;
    switch (status.state) {
      case 'connected': {
        const databases = status.databaseCount === undefined ? '' : ` · ${status.databaseCount} db`;
        const latency = status.latencyMs === undefined ? '' : ` · ${status.latencyMs} ms`;
        return `${engine}${databases}${latency}`;
      }
      case 'connecting':
        return `${engine} · connecting…`;
      case 'error':
        return `${engine} · failed`;
      default:
        return engine;
    }
  }

  private static tooltipFor(profile: ConnectionProfile, status: SessionStatus): vscode.MarkdownString {
    const lines = [
      `**${profile.name}**`,
      '',
      `Engine: \`${profile.engine}\``,
      profile.host ? `Host: \`${profile.host}${profile.port ? `:${profile.port}` : ''}\`` : '',
      profile.user ? `User: \`${profile.user}\`` : '',
      profile.database ? `Database: \`${profile.database}\`` : '',
      profile.schema ? `Schema: \`${profile.schema}\`` : '',
      profile.ssl?.enabled ? 'SSL: enabled' : '',
      profile.ssh?.enabled ? `SSH: \`${profile.ssh.username}@${profile.ssh.host}\`` : '',
      profile.readOnly ? 'Mode: **read-only**' : '',
    ].filter((line) => line !== '');

    if (status.state === 'error' && status.error) {
      lines.push('', `$(error) **${status.error.hint}**`, '', '```', status.error.message, '```');
    }

    const tooltip = new vscode.MarkdownString(lines.join('\n'));
    tooltip.supportThemeIcons = true;
    return tooltip;
  }

  /** Refreshes every visual aspect without rebuilding the node. */
  applyStatus(status: SessionStatus): void {
    this.status = status;
    this.iconPath = engineIconForState(status.state);
    this.description = ConnectionNode.describe(this.profile, status);
    this.tooltip = ConnectionNode.tooltipFor(this.profile, status);
    this.collapsibleState =
      status.state === 'connected' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    this.contextValue =
      status.state === 'connected'
        ? 'dbclient.connection.connected'
        : status.state === 'error'
          ? 'dbclient.connection.error'
          : status.state === 'connecting'
            ? 'dbclient.connection.connecting'
            : 'dbclient.connection.disconnected';
  }

  override async getChildren(services: ExplorerServices): Promise<ExplorerNode[]> {
    if (this.status.state === 'error' && this.status.error) {
      return [
        new MessageNode(this.status.error.hint, this.status.error.message, 'error', 'error'),
        new MessageNode('Edit this connection to fix the settings', undefined, 'gear'),
      ];
    }
    if (this.status.state === 'connecting') {
      return [new MessageNode('Connecting…', undefined, SPIN)];
    }

    const driver = services.manager.getDriver(this.profile.id);
    if (!driver) {
      return [new MessageNode('Not connected', 'Connect this profile to browse its databases.', 'plug')];
    }

    try {
      return await this.loadDatabases(services, driver);
    } catch (error) {
      return [MessageNode.fromError('Failed to load databases', error)];
    }
  }

  private async loadDatabases(services: ExplorerServices, driver: DatabaseDriver): Promise<ExplorerNode[]> {
    // An engine that only ever reaches one database skips the database level
    // and shows the object folders directly (a SQLite file behaves this way).
    if (!driver.capabilities.multipleDatabases) {
      const database = this.profile.database ?? this.profile.name;
      return foldersFor(driver, {
        connectionId: this.profile.id,
        database,
        schema: this.profile.schema,
      });
    }

    const databases = await services.cache.getOrLoad(cacheKey(this.profile.id, 'databases'), () =>
      driver.listDatabases(),
    );
    if (databases.length === 0) {
      return [
        new MessageNode(
          'No databases visible',
          'The account may lack the privileges needed to enumerate databases.',
          'warning',
          'warning',
        ),
      ];
    }
    return databases.map((database) => new DatabaseNode(this.profile.id, database, driver.capabilities.schemas));
  }

  cachePrefix(): string {
    return cacheKey(this.profile.id);
  }
}

/**
 * Object folders directly under a connection or a schema.
 * Only the folders the driver can actually populate are created, so the tree
 * never shows an empty "Procedures" node for an engine without them.
 */
export function foldersFor(driver: DatabaseDriver, ref: SchemaRef): FolderNode[] {
  const folders: FolderNode[] = [new FolderNode(ref, 'tables', 'Tables', 'table')];
  if (driver.capabilities.views) {
    folders.push(new FolderNode(ref, 'views', 'Views', 'eye'));
  }
  if (driver.capabilities.routines) {
    folders.push(new FolderNode(ref, 'procedures', 'Procedures', 'symbol-method'));
    folders.push(new FolderNode(ref, 'functions', 'Functions', 'symbol-function'));
  }
  return folders;
}

export class DatabaseNode extends ExplorerNode {
  constructor(
    readonly connectionId: string,
    readonly database: string,
    private readonly hasSchemas: boolean,
  ) {
    super('database', database, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = nodeId('database', connectionId, database);
    this.contextValue = 'dbclient.database';
    this.iconPath = new vscode.ThemeIcon('database');
  }

  override async getChildren(services: ExplorerServices): Promise<ExplorerNode[]> {
    const driver = services.manager.requireDriver(this.connectionId);

    if (this.hasSchemas) {
      const schemas = await services.cache.getOrLoad(cacheKey(this.connectionId, this.database, 'schemas'), () =>
        driver.listSchemas(this.database),
      );
      if (schemas.length === 0) {
        return [new MessageNode('No schemas found', undefined, 'warning', 'warning')];
      }
      return schemas.map((schema) => new SchemaNode(this.connectionId, this.database, schema));
    }

    return foldersFor(driver, { connectionId: this.connectionId, database: this.database });
  }

  cachePrefix(): string {
    return cacheKey(this.connectionId, this.database);
  }
}

export class SchemaNode extends ExplorerNode {
  constructor(
    readonly connectionId: string,
    readonly database: string,
    readonly schema: string,
  ) {
    super('schema', schema, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = nodeId('schema', connectionId, database, schema);
    this.contextValue = 'dbclient.schema';
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
  }

  override async getChildren(services: ExplorerServices): Promise<ExplorerNode[]> {
    const driver = services.manager.requireDriver(this.connectionId);
    return foldersFor(driver, {
      connectionId: this.connectionId,
      database: this.database,
      schema: this.schema,
    });
  }

  cachePrefix(): string {
    return cacheKey(this.connectionId, this.database, this.schema);
  }
}

export class FolderNode extends ExplorerNode {
  constructor(
    readonly ref: SchemaRef,
    readonly folder: FolderKind,
    label: string,
    icon: string,
  ) {
    super('folder', label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = nodeId('folder', ref.connectionId, ref.database, ref.schema, folder);
    this.contextValue = `dbclient.folder.${folder}`;
    this.iconPath = new vscode.ThemeIcon(icon);
  }

  override async getChildren(services: ExplorerServices): Promise<ExplorerNode[]> {
    const driver = services.manager.requireDriver(this.ref.connectionId);

    if (this.folder === 'tables' || this.folder === 'views') {
      // `listTables` returns tables and views together, so both folders read a
      // single cached entry instead of issuing two round trips.
      const relations = await services.cache.getOrLoad(this.cachePrefix(), () => driver.listTables(this.ref));
      const wanted = this.folder === 'tables' ? 'table' : 'view';
      const selected = relations.filter((relation) => relation.kind === wanted);
      if (selected.length === 0) {
        return [new MessageNode(`No ${this.folder} found`, undefined, 'info')];
      }
      return selected.map(
        (relation) =>
          new RelationNode(
            { ...this.ref, table: relation.name, kind: relation.kind },
            relation.tableType,
            relation.comment,
          ),
      );
    }

    if (!driver.listRoutines) {
      return [new MessageNode(`${this.folder} are not supported by this engine`, undefined, 'info')];
    }
    const routines = await services.cache.getOrLoad(this.cachePrefix(), () => driver.listRoutines!(this.ref));
    const wantedKind = this.folder === 'procedures' ? 'procedure' : 'function';
    const selected = routines.filter((routine) => routine.kind === wantedKind);
    if (selected.length === 0) {
      return [new MessageNode(`No ${this.folder} found`, undefined, 'info')];
    }
    return selected.map((routine) => new RoutineNode(this.ref, routine));
  }

  cachePrefix(): string {
    // Tables and views intentionally share one cache entry.
    const bucket = this.folder === 'tables' || this.folder === 'views' ? 'tables' : 'routines';
    return cacheKey(this.ref.connectionId, this.ref.database, this.ref.schema, bucket);
  }
}

export class RelationNode extends ExplorerNode {
  constructor(
    readonly ref: TableRef,
    readonly tableType?: string,
    readonly comment?: string,
  ) {
    super(ref.kind === 'view' ? 'view' : 'table', ref.table, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = nodeId('relation', ref.connectionId, ref.database, ref.schema, ref.table);
    this.contextValue = ref.kind === 'view' ? 'dbclient.view' : 'dbclient.table';
    this.iconPath = new vscode.ThemeIcon(ref.kind === 'view' ? 'eye' : 'table');
    if (tableType) {
      this.description = tableType;
    }
    if (comment) {
      const tooltip = new vscode.MarkdownString(`**${ref.table}**\n\n${comment}`);
      this.tooltip = tooltip;
    }
    this.command = {
      command: 'dbclient.table.view',
      title: 'View Table Data',
      arguments: [this],
    };
  }

  override async getChildren(services: ExplorerServices): Promise<ExplorerNode[]> {
    const driver = services.manager.requireDriver(this.ref.connectionId);
    const columns = await services.cache.getOrLoad(this.cachePrefix(), () => driver.listColumns(this.ref));
    if (columns.length === 0) {
      return [new MessageNode('No columns found', undefined, 'warning', 'warning')];
    }
    return columns.map((column) => new ColumnNode(this.ref, column));
  }

  cachePrefix(): string {
    return cacheKey(
      this.ref.connectionId,
      this.ref.database,
      this.ref.schema,
      `columns:${this.ref.table}`,
    );
  }
}

export class ColumnNode extends ExplorerNode {
  constructor(
    readonly ref: TableRef,
    readonly column: ColumnInfo,
  ) {
    super('column', column.name, vscode.TreeItemCollapsibleState.None);
    this.id = nodeId('column', ref.connectionId, ref.database, ref.schema, ref.table, column.name);
    this.contextValue = 'dbclient.column';

    const type = column.nullable ? column.dataType : `${column.dataType} NOT NULL`;
    this.description = column.isPrimaryKey ? `${type} · PK` : type;
    this.iconPath = column.isPrimaryKey
      ? new vscode.ThemeIcon('key', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon('symbol-field');

    const lines = [
      `**${column.name}**`,
      '',
      `Type: \`${column.dataType}\``,
      `Nullable: ${column.nullable ? 'yes' : 'no'}`,
      column.isPrimaryKey ? 'Primary key: **yes**' : '',
      column.isAutoIncrement ? 'Auto increment: yes' : '',
      column.defaultValue !== undefined && column.defaultValue !== null
        ? `Default: \`${column.defaultValue}\``
        : '',
      column.comment ? `Comment: ${column.comment}` : '',
    ].filter((line) => line !== '');
    const tooltip = new vscode.MarkdownString(lines.join('\n'));
    tooltip.supportThemeIcons = true;
    this.tooltip = tooltip;
  }

  async getChildren(): Promise<ExplorerNode[]> {
    return [];
  }

  cachePrefix(): string {
    return nodeId('column', this.ref.connectionId, this.ref.database, this.ref.schema, this.ref.table, this.column.name);
  }
}

export class RoutineNode extends ExplorerNode {
  constructor(
    readonly ref: SchemaRef,
    readonly routine: RoutineInfo,
  ) {
    super('routine', routine.name, vscode.TreeItemCollapsibleState.None);
    this.id = nodeId('routine', ref.connectionId, ref.database, ref.schema, routine.kind, routine.name);
    this.contextValue = 'dbclient.routine';
    this.iconPath = new vscode.ThemeIcon(routine.kind === 'procedure' ? 'symbol-method' : 'symbol-function');
    this.description = routine.routineType ?? routine.kind;
  }

  async getChildren(): Promise<ExplorerNode[]> {
    return [];
  }

  cachePrefix(): string {
    return nodeId('routine', this.ref.connectionId, this.ref.database, this.ref.schema, this.routine.name);
  }
}



