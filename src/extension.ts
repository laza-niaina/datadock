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
import { registerCommands, type CommandServices } from './commands';
import { ConnectionManager } from './connections/connectionManager';
import { ConnectionStore } from './connections/connectionStore';
import { OutputLogger, toLogLevel } from './core/logger';
import { driverRegistry } from './db/driverRegistry';
import type { SessionStatus } from './connections/connectionManager';
import { DatabaseExplorerProvider } from './explorer/databaseExplorerProvider';
import { ConnectionNode } from './explorer/nodes';
import { MetadataCache } from './metadata/metadataCache';
import { globalRedactor } from './util/redaction';

/** Kept for `deactivate`, which must close every socket before VS Code exits. */
let activeManager: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const logger = new OutputLogger(globalRedactor);
  const configuration = vscode.workspace.getConfiguration('dbclient');
  logger.setLevel(toLogLevel(configuration.get<string>('log.level')));

  const engines = driverRegistry.all().map((factory) => factory.engine);
  logger.info(`Database Client activating. VS Code ${vscode.version}.`, {
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
  const manager = new ConnectionManager({ registry: driverRegistry, logger, redactor: globalRedactor });
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
