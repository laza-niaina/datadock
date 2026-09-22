/**
 * Shared command plumbing.
 *
 * Handlers receive the tree node they were invoked from (VS Code passes the
 * `contextValue` item as the first argument for `view/item/context` commands).
 * They must therefore tolerate `undefined` and fall back to a QuickPick.
 */

import type { ConnectionManager } from '../connections/connectionManager';
import type { ConnectionStore } from '../connections/connectionStore';
import type { DriverRegistry } from '../db/driverRegistry';
import type { Logger } from '../db/types';
import type { DatabaseExplorerProvider } from '../explorer/databaseExplorerProvider';
import type { MetadataCache } from '../metadata/metadataCache';

export interface CommandServices {
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly registry: DriverRegistry;
  readonly cache: MetadataCache;
  readonly logger: Logger;
  readonly provider: DatabaseExplorerProvider;
  /** Reveals the output channel. */
  showOutput(): void;
  /** Expands and focuses a connection node in the explorer. */
  revealConnection(connectionId: string): Promise<void>;
}

/** Registers one VS Code command id together with its handler. */
export type Register = (commandId: string, handler: (...args: unknown[]) => unknown) => void;
