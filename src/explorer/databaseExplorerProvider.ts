/**
 * `TreeDataProvider` for the Database Explorer.
 *
 * The provider is deliberately thin: nodes know how to load their own children
 * (see `nodes.ts`). Its responsibilities are:
 *  - listing saved connection profiles as root nodes, in creation order;
 *  - invalidating the right slice of the metadata cache when refreshing;
 *  - reacting to session state changes and to profile edits.
 *
 * Children are loaded **asynchronously with a visible loading row**. Returning
 * the spinner first and repainting the node when the load lands is what makes
 * a slow catalog query legible instead of an apparently empty branch, and it
 * keeps a stale answer from an invalidated node out of the view.
 */

import * as vscode from 'vscode';
import type { SessionStatus } from '../connections/connectionManager';
import type { ConnectionProfile } from '../db/types';
import { ConnectionNode, ExplorerNode, FolderNode, MessageNode, cacheKey, nodeId, type ExplorerServices } from './nodes';

/** One in-flight or settled child listing for a node. */
interface LoadEntry {
  settled: boolean;
  children: ExplorerNode[];
}

export class DatabaseExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
  private readonly changed = new vscode.EventEmitter<ExplorerNode | undefined | void>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Child listings keyed by node id; the identity of the entry guards races. */
  private readonly loads = new Map<string, LoadEntry>();

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
    // Informational rows are leaves: VS Code never asks them for children, and
    // answering keeps the contract total.
    if (element instanceof MessageNode) {
      return [];
    }

    const key = this.loadKey(element);
    const entry = this.loads.get(key);
    if (entry?.settled) {
      return entry.children;
    }
    if (!entry) {
      this.startLoad(key, element);
    }
    return [new MessageNode('Loading...', undefined, LOADING_ICON)];
  }

  // -- loading -------------------------------------------------------------

  /** Starts a child listing and repaints the node once it lands. */
  private startLoad(key: string, element: ExplorerNode): void {
    const entry: LoadEntry = { settled: false, children: [] };
    this.loads.set(key, entry);
    element
      .getChildren(this.services)
      .then(
        (children) => this.settle(key, element, entry, children),
        (error: unknown) => {
          // Without this the only trace of a failed catalog query is a row the
          // user has to expand by hand; the output channel keeps it.
          this.services.logger.warn('Explorer: could not load children.', {
            node: key,
            error: error instanceof Error ? error.message : String(error),
          });
          this.settle(key, element, entry, [MessageNode.fromError('Failed to load', error)]);
        },
      );
  }

  /** Publishes a finished listing, unless the node was refreshed meanwhile. */
  private settle(key: string, element: ExplorerNode, entry: LoadEntry, children: ExplorerNode[]): void {
    if (this.loads.get(key) !== entry) {
      // A refresh landed while this load was in flight: its answer is stale.
      return;
    }
    entry.children = children;
    entry.settled = true;
    this.announceFolderCount(element);
    this.changed.fire(element);
  }

  /** Stable key for a node listing; every expandable node carries an id. */
  private loadKey(element: ExplorerNode): string {
    return element.id ?? `${element.kind}:${nodeLabel(element)}`;
  }

  /**
   * Folder counts are only known after the children loaded, which happens
   * after the folder row was drawn; repaint the row exactly once so the
   * `Tables (12)` description appears without a manual refresh. The repaint
   * re-reads the settled children, so it cannot loop.
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
    this.loads.clear();
    this.changed.fire(undefined);
  }

  /** Invalidates the subtree cache of a node and repaints it. */
  refreshNode(node: ExplorerNode): void {
    this.services.cache.invalidate(node.cachePrefix());
    this.loads.delete(this.loadKey(node));
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

    // No rows at all: VS Code then shows the `viewsWelcome` contribution, which
    // is the native empty state and carries the real Add Connection command.
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
      this.loads.delete(nodeId('connection', status.id));
    }
    this.changed.fire(undefined);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.loads.clear();
    this.changed.dispose();
  }
}

/** Codicon shown while a node loads its children. */
const LOADING_ICON = 'loading~spin';

/** Best-effort label for a node that has no id. */
function nodeLabel(element: ExplorerNode): string {
  const label = element.label;
  return typeof label === 'string' ? label : '';
}
