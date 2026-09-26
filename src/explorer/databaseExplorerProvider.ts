/**
 * `TreeDataProvider` for the Database Explorer.
 *
 * The provider is deliberately thin: nodes know how to load their own children
 * (see `nodes.ts`). Its responsibilities are:
 *  - listing saved connection profiles as root nodes, in creation order;
 *  - invalidating the right slice of the metadata cache when refreshing;
 *  - reacting to session state changes and to profile edits.
 */

import * as vscode from 'vscode';
import type { SessionStatus } from '../connections/connectionManager';
import type { ConnectionProfile } from '../db/types';
import { ConnectionNode, ExplorerNode, FolderNode, MessageNode, cacheKey, type ExplorerServices } from './nodes';

export class DatabaseExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
  private readonly changed = new vscode.EventEmitter<ExplorerNode | undefined | void>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeTreeData: vscode.Event<ExplorerNode | undefined | void> = this.changed.event;

  constructor(readonly services: ExplorerServices) {
    const storeSubscription = services.manager.onDidChange((status) => this.onSessionChanged(status));
    const profileSubscription = services.store.onDidChange(() => this.refreshAll({ keepCache: true }));

    this.disposables.push(
      { dispose: () => storeSubscription.dispose() },
      { dispose: () => profileSubscription.dispose() },
    );
  }

  // -- TreeDataProvider ----------------------------------------------------

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!element) {
      return this.rootNodes();
    }
    try {
      const children = await element.getChildren(this.services);
      this.announceFolderCount(element);
      return children;
    } catch (error) {
      // A node that fails to expand shows the reason inline instead of
      // collapsing with a silent error in the developer tools.
      const message = error instanceof Error ? error.message : String(error);
      return [new MessageNode('Failed to load', message, 'error', 'error')];
    }
  }

  /**
   * Folder counts are only known after the children loaded, which happens
   * after the folder row was drawn; repaint the row exactly once so the
   * `Tables (12)` description appears without a manual refresh. The repaint
   * re-reads the cached children, so it cannot loop.
   */
  private announceFolderCount(element: ExplorerNode): void {
    if (element instanceof FolderNode && element.count !== undefined && !element.countAnnounced) {
      element.countAnnounced = true;
      this.changed.fire(element);
    }
  }

  // -- refresh -------------------------------------------------------------

  /**
   * Rebuilds the tree.
   * `keepCache` is used for profile edits, which change labels only and must
   * not throw away cached schema metadata.
   */
  refreshAll(options: { keepCache?: boolean } = {}): void {
    if (!options.keepCache) {
      this.services.cache.invalidate();
    }
    this.changed.fire(undefined);
  }

  /** Invalidates the subtree cache of a node and repaints it. */
  refreshNode(node: ExplorerNode): void {
    this.services.cache.invalidate(node.cachePrefix());
    this.changed.fire(node);
  }

  /** Invalidates cached metadata for one connection. */
  invalidateConnection(connectionId: string): void {
    this.services.cache.invalidate(cacheKey(connectionId));
  }

  /**
   * Repaints a specific connection row without touching the cache.
   * Used by commands that only change presentation.
   */
  repaint(): void {
    this.changed.fire(undefined);
  }

  // -- internals -----------------------------------------------------------

  private async rootNodes(): Promise<ExplorerNode[]> {
    const profiles = await this.services.store.list();

    if (profiles.length === 0) {
      return [
        new MessageNode('No connections yet', 'Run "Add Connection" to create one.', 'plug'),
        new MessageNode('Add Connection', 'Bind the command to a keyboard shortcut if you like.', 'add'),
      ];
    }

    return profiles.map((profile) => new ConnectionNode(profile, this.statusFor(profile)));
  }

  private statusFor(profile: ConnectionProfile): SessionStatus {
    return (
      this.services.manager.statusOf(profile.id) ?? {
        id: profile.id,
        name: profile.name,
        engine: profile.engine,
        state: 'disconnected',
        readOnly: !!profile.readOnly,
      }
    );
  }

  private onSessionChanged(status: SessionStatus): void {
    if (status.state === 'disconnected' || status.state === 'error') {
      // Nothing served from the cache can still be trusted once the transport
      // is gone, and a failed connect may have created a half-populated tree.
      this.services.cache.invalidate(cacheKey(status.id));
    }
    this.changed.fire(undefined);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changed.dispose();
  }
}
