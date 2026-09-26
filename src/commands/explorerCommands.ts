/**
 * Explorer-local commands: refresh, cache control, copy name, Quick Open.
 *
 * Context commands operate on the node that was right-clicked, which is why
 * they all take an `unknown` first argument and narrow it themselves.
 */

import * as vscode from 'vscode';
import { ExplorerNode, FolderNode, RelationNode } from '../explorer/nodes';
import {
  type ExplorerQuickPickItem,
  explorerObjectItems,
  qualifiedName,
  toQuickPickItem,
} from '../explorer/explorerSearch';
import { TableViewerPanel } from '../ui/tableViewerPanel';
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
    if (label) {
      await vscode.env.clipboard.writeText(label);
    }
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

    const tablesOf = async (ref: { connectionId: string; database: string }) => {
      const driver = services.manager.requireDriver(ref.connectionId);
      return driver.listTables(ref);
    };
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'DataDock: indexing database objects…' },
      async () => {
        const items = await explorerObjectItems(connected, tablesOf);
        if (items.length === 0) {
          void vscode.window.showInformationMessage('No tables or views found on the connected profiles.');
          return;
        }
        const pick = vscode.window.createQuickPick<ExplorerQuickPickItem>();
        pick.placeholder = 'Go to table or view, across every connected database (fuzzy).';
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
      },
    );
  });
}
