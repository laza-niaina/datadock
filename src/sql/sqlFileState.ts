/**
 * Per-file SQL connection association.
 *
 * The mapping lives in `workspaceState` (a VS Code workspace-scoped Memento),
 * keyed by `uri.toString()`. Nothing is ever written into the `.sql` file
 * itself and no credential crosses this boundary: the value stored is only the
 * id of an already-validated profile from the connection store, plus an
 * optional database override chosen for that file.
 *
 * A process-wide instance is bound during activation so editor commands and the
 * status bar share the same view of the mapping and react to changes.
 */

import * as vscode from 'vscode';
import { Emitter, type Event } from '../util/emitter';

/** Versioned key so a future schema change can migrate instead of corrupting. */
const STORAGE_KEY = 'dbclient.sqlFileConnections.v1';

/** Association stored for one SQL document. Never contains a credential. */
export interface SqlFileAssociation {
  /** Id of the validated profile used to run queries for this file. */
  readonly connectionId: string;
  /**
   * Optional database override for this file (only meaningful for engines with
   * multiple databases, e.g. MySQL/MariaDB). Absent means "use the profile's
   * default database".
   */
  readonly database?: string;
}

/**
 * Stored value shape: either the legacy bare connection id (strings written by
 * the first P8 version) or the current `{ connectionId, database? }` object.
 */
type StoredAssociation = string | SqlFileAssociation;

/** Fires after any association is set or cleared. */
export interface SqlFileAssociationChange {
  /** `uri.toString()` of the SQL document whose association changed. */
  readonly uri: string;
  /** The new connection id, or `undefined` when the association was cleared. */
  readonly connectionId: string | undefined;
  /** The database override after the change (undefined when unset/cleared). */
  readonly database: string | undefined;
}

function normalizeStored(value: unknown): SqlFileAssociation | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return { connectionId: value };
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const entry = value as Partial<SqlFileAssociation>;
    if (typeof entry.connectionId === 'string' && entry.connectionId.length > 0) {
      return {
        connectionId: entry.connectionId,
        database: typeof entry.database === 'string' && entry.database.length > 0 ? entry.database : undefined,
      };
    }
  }
  return undefined;
}

export class SqlFileAssociations {
  private readonly changed = new Emitter<SqlFileAssociationChange>();

  /** Fires after any association is set or cleared. */
  readonly onDidChange: Event<SqlFileAssociationChange> = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  /** Returns the associated connection id for a document, if any. */
  get(uri: vscode.Uri): string | undefined {
    return this.getAssociation(uri)?.connectionId;
  }

  /** Returns the full association stored for a document, if any. */
  getAssociation(uri: vscode.Uri): SqlFileAssociation | undefined {
    return normalizeStored(this.load()[uri.toString()]);
  }

  /**
   * Remembers `connectionId` for a document, or clears the entry when
   * `connectionId` is `undefined`. Changing the connection resets any database
   * override, since it belonged to the previous connection.
   */
  async set(uri: vscode.Uri, connectionId: string | undefined, database?: string): Promise<void> {
    const map = this.load();
    const key = uri.toString();
    if (connectionId === undefined) {
      delete map[key];
    } else {
      map[key] = {
        connectionId,
        database: typeof database === 'string' && database.length > 0 ? database : undefined,
      };
    }
    await this.state.update(STORAGE_KEY, map);
    this.changed.fire({ uri: key, connectionId, database: connectionId === undefined ? undefined : database });
  }

  /**
   * Updates only the database override of an existing association.
   * `database === undefined` removes the override (back to the profile default).
   */
  async setDatabase(uri: vscode.Uri, database: string | undefined): Promise<void> {
    const map = this.load();
    const key = uri.toString();
    const current = normalizeStored(map[key]);
    if (!current) {
      await this.set(uri, undefined);
      return;
    }
    map[key] = {
      connectionId: current.connectionId,
      database: typeof database === 'string' && database.length > 0 ? database : undefined,
    };
    await this.state.update(STORAGE_KEY, map);
    this.changed.fire({ uri: key, connectionId: current.connectionId, database });
  }

  private load(): Record<string, StoredAssociation> {
    const raw = this.state.get<unknown>(STORAGE_KEY);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    const result: Record<string, StoredAssociation> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key === 'string' && normalizeStored(value) !== undefined) {
        result[key] = value as StoredAssociation;
      }
    }
    return result;
  }
}

let active: SqlFileAssociations | undefined;

/** Binds the process-wide associations to the workspace storage at activation. */
export function initSqlFileAssociations(state: vscode.Memento): SqlFileAssociations {
  active = new SqlFileAssociations(state);
  return active;
}

/** Shared instance used by editor commands, panel hosts and the status bar. */
export function sqlFileAssociations(): SqlFileAssociations {
  if (!active) {
    throw new Error('SqlFileAssociations has not been initialised during activation.');
  }
  return active;
}