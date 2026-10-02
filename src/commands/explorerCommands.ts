/**
 * Explorer-local commands: refresh, cache control, copy name, Quick Open.
 *
 * Context commands operate on the node that was right-clicked, which is why
 * they all take an `unknown` first argument and narrow it themselves.
 */

import * as vscode from 'vscode';
import { ExplorerNode, FolderNode, RelationNode, cacheKey } from '../explorer/nodes';
import {
  type ExplorerObjectItem,
  type ExplorerQuickPickItem,
  explorerObjectItems,
  qualifiedName,
  toQuickPickItem,
} from '../explorer/explorerSearch';
import { TableViewerPanel } from '../ui/tableViewerPanel';
import { ErdPanel } from '../ui/erdPanel';
import type { CommandServices, Register } from './types';

/** Reads the display label of a tree item, whatever shape VS Code gave it. */
export function labelOf(node: unknown): string | undefined {
  const item = node as { label?: unknown } | undefined;
  const label = item?.label;
  if (typeof label === 'string') {
    return label;
  }
  if (label && typeof label === 'object' && 'label' in label) {
    const inner = (label as { label: unknown }).label;
    return typeof inner === 'string' ? inner : undefined;
  }
  return undefined;
}

export function registerExplorerCommands(register: Register, services: CommandServices): void {
  register('dbclient.explorer.refresh', () => {
    services.provider.refreshAll();
  });

  register('dbclient.explorer.clearCache', () => {
    const removed = services.cache.invalidate();
    services.logger.info('Metadata cache cleared.', { entries: removed });
    void vscode.window.showInformationMessage(
      `DataDock: cleared ${removed} cached metadata ${removed === 1 ? 'entry' : 'entries'}.`,
    );
  });

  register('dbclient.explorer.showOutput', () => {
    services.showOutput();
  });

  register('dbclient.node.refresh', (node?: unknown) => {
    if (node instanceof ExplorerNode) {
      services.provider.refreshNode(node);
      return;
    }
    services.provider.refreshAll();
  });

  register('dbclient.node.copyName', async (node?: unknown) => {
    const label = labelOf(node);
    if (!label) {
      return;
    }
    await vscode.env.clipboard.writeText(label);
  });

  /** Qualifies the label with its database (and schema) when known. */
  function qualifiedLabel(node: ExplorerNode): string {
    if (node instanceof RelationNode) {
      return qualifiedName(node.ref);
    }
    if (node instanceof FolderNode) {
      return qualifiedName(node.ref);
    }
    return labelOf(node) ?? '';
  }

  register('dbclient.node.copyQualifiedName', async (node?: unknown) => {
    if (!(node instanceof ExplorerNode)) {
      return;
    }
    const name = qualifiedLabel(node);
    if (name !== '') {
      await vscode.env.clipboard.writeText(name);
    }
  });

  /**
   * Opens the entity relationship diagram of a `Tables` folder in a real
   * webview tab. The diagram reads the very metadata the tree just loaded
   * (tables, schema-wide columns, foreign keys) through the metadata cache, so
   * opening it never issues a second listing and never touches the data.
   */
  register('dbclient.erd.open', async (node?: unknown) => {
    if (!(node instanceof FolderNode) || node.folder !== 'tables') {
      void vscode.window.showInformationMessage(
        'Open the Entity Relationship Diagram from a Tables folder in DataDock.',
      );
      return;
    }
    await ErdPanel.show({
      manager: services.manager,
      store: services.store,
      cache: services.cache,
      logger: services.logger,
      context: services.context,
      ref: node.ref,
      title: `ER Diagram: ${qualifiedName(node.ref)}`,
    });
  });

  register('dbclient.explorer.quickOpen', async () => {
    const profiles = await services.store.list();
    if (profiles.length === 0) {
      void vscode.window.showInformationMessage('Add a connection before searching for tables.');
      return;
    }
    const connected = profiles.filter((profile) => services.manager.getDriver(profile.id));
    if (connected.length === 0) {
      void vscode.window.showInformationMessage('Connect a profile to search its tables.');
      return;
    }

    // Reads the metadata cache the explorer already fills, so searching costs
    // nothing on profiles the user has visited, and never two listings for the
    // same database.
    const tablesOf = async (ref: { connectionId: string; database: string; schema?: string }) => {
      const driver = services.manager.requireDriver(ref.connectionId);
      return services.cache.getOrLoad(cacheKey(ref.connectionId, ref.database, ref.schema, 'tables'), () =>
        driver.listTables(ref),
      );
    };

    let items: ExplorerObjectItem[];
    try {
      items = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'DataDock: indexing database objects...' },
        () => explorerObjectItems(connected, tablesOf, (connectionId, error) => {
          services.logger.warn('Quick open: could not list objects.', {
            connectionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }),
      );
    } catch (error) {
      services.logger.warn('Quick open: indexing failed.', error);
      void vscode.window.showErrorMessage('DataDock: could not index database objects. See the DataDock output channel.');
      return;
    }

    if (items.length === 0) {
      void vscode.window.showInformationMessage('No tables or views found on the connected profiles.');
      return;
    }

    const pick = vscode.window.createQuickPick<ExplorerQuickPickItem>();
    pick.title = 'Go to Table or View';
    pick.placeholder = 'Search across every connected database';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    pick.items = items.slice(0, 200).map((item) => toQuickPickItem(item));
    pick.activeItems = pick.items.slice(0, 1);
    const selected = await new Promise<ExplorerQuickPickItem | undefined>((resolve) => {
      pick.onDidAccept(() => resolve(pick.selectedItems[0]));
      pick.onDidHide(() => resolve(undefined));
      pick.show();
    });
    if (!selected) {
      return;
    }
    const chosen = selected.item;
    const driver = services.manager.getDriver(chosen.connectionId);
    TableViewerPanel.show({
      manager: services.manager,
      logger: services.logger,
      ref: { connectionId: chosen.connectionId, database: chosen.database, schema: chosen.schema, table: chosen.table, kind: chosen.kind },
      engine: driver?.engine,
      title: `${chosen.database}.${chosen.table}`,
    });
  });
}
