/**
 * Extension entry point.
 *
 * Wiring only: every service is constructed here and injected explicitly, which
 * keeps the rest of the codebase free of global state and makes the layers
 * independently testable.
 *
 * There is deliberately **no telemetry**, no remote configuration and no
 * entitlement check of any kind in this file or anywhere else in the extension.
 */

import * as vscode from 'vscode';
import { basename } from 'node:path';
import { registerCommands, type CommandServices } from './commands';
import { ConnectionManager } from './connections/connectionManager';
import { ConnectionStore } from './connections/connectionStore';
import { OutputLogger, toLogLevel } from './core/logger';
import { driverRegistry } from './db/driverRegistry';
import { registerBuiltinDrivers } from './db/drivers';
import type { SessionStatus } from './connections/connectionManager';
import { DatabaseExplorerProvider } from './explorer/databaseExplorerProvider';
import { ConnectionNode } from './explorer/nodes';
import { MetadataCache } from './metadata/metadataCache';
import { initSqlFileAssociations } from './sql/sqlFileState';
import { SqlBlockCodeLensProvider } from './sql/sqlCodeLens';
import { sqlStatusLabels } from './util/engineDisplay';
import { globalRedactor } from './util/redaction';

/** Kept for `deactivate`, which must close every socket before VS Code exits. */
let activeManager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const logger = new OutputLogger(globalRedactor);
  const configuration = vscode.workspace.getConfiguration('dbclient');
  logger.setLevel(toLogLevel(configuration.get<string>('log.level')));

  // Registers MySQL, MariaDB and SQLite. Must run before any registry read:
  // the wizard, the explorer and the connection manager all derive their
  // behaviour from what is registered here.
  registerBuiltinDrivers(driverRegistry);

  const engines = driverRegistry.all().map((factory) => factory.engine);
  logger.info(`DataDock activating. VS Code ${vscode.version}.`, {
    drivers: engines,
    connectionLimit: 'none',
  });
  if (engines.length === 0) {
    logger.warn(
      'No database driver is registered. Connection commands will report this instead of failing silently.',
    );
  }

  const cache = new MetadataCache({
    ttlMs: Math.max(0, configuration.get<number>('metadata.cacheTtlSeconds') ?? 300) * 1000,
  });
  const store = new ConnectionStore(context.globalState, context.secrets, logger, globalRedactor);
  const manager = new ConnectionManager({
    registry: driverRegistry,
    logger,
    redactor: globalRedactor,
    // sql-wasm.wasm and any future non-bundleable runtime asset live here.
    assetsDir: __dirname,
  });
  activeManager = manager;

  const provider = new DatabaseExplorerProvider({
    store,
    manager,
    cache,
    registry: driverRegistry,
  });

  const treeView = vscode.window.createTreeView('dbclient.explorer', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const services: CommandServices = {
    store,
    manager,
    cache,
    registry: driverRegistry,
    logger,
    provider,
    showOutput: () => logger.show(),
    revealConnection: async (connectionId: string) => {
      try {
        const profile = await store.get(connectionId);
        if (!profile) {
          return;
        }
        const status: SessionStatus = manager.statusOf(connectionId) ?? {
          id: profile.id,
          name: profile.name,
          engine: profile.engine,
          state: 'disconnected',
          readOnly: !!profile.readOnly,
        };
        // Node ids are stable, so VS Code matches this fresh instance with the
        // item already on screen and expands it in place.
        await treeView.reveal(new ConnectionNode(profile, status), { expand: true, focus: false });
      } catch (error) {
        logger.debug('Could not reveal the connection node.', error);
      }
    },
  };

  registerCommands(context, services);

  // Per-file SQL connection association: remembered in workspaceState so the
  // SQL editor, the status bar and the CodeLens share one view, with nothing
  // written into the .sql file itself.
  const associations = initSqlFileAssociations(context.workspaceState);

  const sqliteFilePath = (profile: { engine: string; options?: Record<string, unknown> }): string | undefined => {
    const path = profile.options?.filePath;
    return typeof path === 'string' ? path : undefined;
  };

  // CodeLens action bar above each SQL block. The profile lookup is async, so
  // the provider keeps a small cache it refreshes on editor/association change.
  const sqlCodeLens = new SqlBlockCodeLensProvider(associations, async (id) => {
    const profile = await store.get(id);
    if (!profile) {
      return undefined;
    }
    const database =
      profile.engine === 'sqlite' ? basename(sqliteFilePath(profile) ?? '') || undefined : profile.database;
    return { name: profile.name, engine: profile.engine, database };
  });

  // Status bar: one visual unit made of two adjacent items - the connection
  // (or "Connect"), then the engine and the active database. Both only exist
  // for the active .sql editor, so switching files swaps the context shown.
  const sqlConnectionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 62);
  const sqlDatabaseStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 61);

  const refreshSqlStatus = async (): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      sqlConnectionStatus.hide();
      sqlDatabaseStatus.hide();
      return;
    }
    const uri = editor.document.uri;
    const association = associations.getAssociation(uri);
    const profile = association ? await store.get(association.connectionId) : undefined;
    const database = profile
      ? association?.database ??
        (profile.engine === 'sqlite' ? basename(sqliteFilePath(profile) ?? '') || undefined : profile.database)
      : undefined;
    const labels = sqlStatusLabels({ connectionName: profile?.name, engine: profile?.engine, database });

    if (!profile) {
      sqlConnectionStatus.text = labels.connection;
      sqlConnectionStatus.tooltip = 'Select a DataDock connection for this SQL file.';
      sqlConnectionStatus.command = 'dbclient.query.selectConnection';
      sqlConnectionStatus.show();
      sqlDatabaseStatus.hide();
      return;
    }

    sqlConnectionStatus.text = labels.connection;
    sqlConnectionStatus.tooltip = 'DataDock connection used for this SQL file. Click to change it.';
    sqlConnectionStatus.command = 'dbclient.query.selectConnection';
    sqlConnectionStatus.show();

    sqlDatabaseStatus.text = labels.database ?? '';
    sqlDatabaseStatus.tooltip =
      typeof database === 'string' && database.length > 0
        ? 'Active database for this SQL file. Click to change it.'
        : 'No database selected yet. Click to choose one.';
    sqlDatabaseStatus.command = 'dbclient.query.selectDatabase';
    sqlDatabaseStatus.show();
  };

  const refreshSqlLenses = (): void => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'sql') {
      void sqlCodeLens.refresh(editor.document.uri);
    }
  };

  context.subscriptions.push(
    sqlConnectionStatus,
    sqlDatabaseStatus,
    vscode.languages.registerCodeLensProvider({ language: 'sql' }, sqlCodeLens),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void refreshSqlStatus();
      refreshSqlLenses();
    }),
    vscode.window.onDidChangeTextEditorSelection(() => void refreshSqlStatus()),
    associations.onDidChange((change) => {
      void refreshSqlStatus();
      void sqlCodeLens.refresh(vscode.Uri.parse(change.uri));
    }),
    store.onDidChange(() => {
      void refreshSqlStatus();
      sqlCodeLens.refreshAll();
    }),
  );
  void refreshSqlStatus();
  refreshSqlLenses();

  context.subscriptions.push(
    logger,
    provider,
    treeView,
    cache,
    { dispose: () => manager.dispose() },
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dbclient.metadata.cacheTtlSeconds')) {
        const seconds =
          vscode.workspace.getConfiguration('dbclient').get<number>('metadata.cacheTtlSeconds') ?? 300;
        cache.setTtlSeconds(seconds);
        cache.invalidate();
        logger.info('Metadata cache lifetime changed; cache cleared.', { seconds });
        provider.repaint();
      }
      if (event.affectsConfiguration('dbclient.log.level')) {
        const level = toLogLevel(vscode.workspace.getConfiguration('dbclient').get<string>('log.level'));
        logger.setLevel(level);
        logger.info('Log level changed.', { level });
      }
    }),
  );
}

/** VS Code awaits this, so open sockets are closed before the process exits. */
export async function deactivate(): Promise<void> {
  const manager = activeManager;
  activeManager = undefined;
  if (!manager) {
    return;
  }
  await manager.disconnectAll();
  manager.dispose();
}
