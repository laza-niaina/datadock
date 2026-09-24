/**
 * CodeLens provider for `.sql` documents.
 *
 * Renders, above every detected SQL block, the DataDock action bar:
 * Run all queries / Run selected query (this block) / connection / engine +
 * active database. The block detection reuses the same engine-aware splitter as
 * the commands, so a click on "Run selected query" and `Ctrl+Enter` always
 * agree on what a block is.
 *
 * `provideCodeLenses` is synchronous, while the connection profile lives in
 * async storage. A small per-document cache bridges the gap: it is refreshed
 * whenever the active editor or the association changes, and the provider asks
 * VS Code to re-render by firing `onDidChangeCodeLenses`.
 */

import * as vscode from 'vscode';
import type { EngineId } from '../db/types';
import { splitSqlStatements } from './sqlStatements';
import { buildBlockLensDescriptors, type SqlBlockInput } from './sqlBlockLenses';
import type { SqlFileAssociations } from './sqlFileState';

/** What the provider needs to know about a profile, pre-resolved for sync use. */
export interface SqlCodeLensProfile {
  readonly name: string;
  readonly engine: EngineId;
  readonly database: string | undefined;
}

interface CacheEntry {
  readonly name: string | undefined;
  readonly engine: EngineId | undefined;
  readonly database: string | undefined;
}

export class SqlBlockCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly cache = new Map<string, CacheEntry | undefined>();

  /** Fired after any background refresh so VS Code re-queries the lenses. */
  readonly onDidChangeCodeLenses: vscode.Event<void> = this.changed.event;

  constructor(
    private readonly associations: SqlFileAssociations,
    private readonly getProfile: (id: string) => Promise<SqlCodeLensProfile | undefined>,
  ) {}

  /** Re-resolves the association for one document and triggers a re-render. */
  async refresh(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const association = this.associations.getAssociation(uri);
    if (!association) {
      this.cache.set(key, undefined);
      this.changed.fire();
      return;
    }
    const profile = await this.getProfile(association.connectionId);
    this.cache.set(
      key,
      profile
        ? {
            name: profile.name,
            engine: profile.engine,
            database: association.database ?? profile.database,
          }
        : undefined,
    );
    this.changed.fire();
  }

  /** Re-resolves every cached document (e.g. after profiles were edited). */
  refreshAll(): void {
    for (const key of this.cache.keys()) {
      void this.refresh(vscode.Uri.parse(key));
    }
  }

  provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
    if (document.languageId !== 'sql') {
      return [];
    }
    const key = document.uri.toString();
    if (!this.cache.has(key)) {
      // First paint: the association is resolved in the background and the
      // change event below makes VS Code re-request once it is known.
      void this.refresh(document.uri);
      return [];
    }
    const entry = this.cache.get(key);
    const statements = splitSqlStatements(document.getText(), entry?.engine ?? 'mysql');
    const blocks: SqlBlockInput[] = statements.map((statement) => ({
      line: document.positionAt(statement.start).line,
      start: statement.start,
      end: statement.end,
    }));
    const descriptors = buildBlockLensDescriptors(
      blocks,
      {
        connectionName: entry?.name,
        engine: entry?.engine,
        database: entry?.database,
      },
      { uri: key },
    );
    return descriptors.map(
      (descriptor) =>
        new vscode.CodeLens(
          new vscode.Range(descriptor.line, 0, descriptor.line, 0),
          {
            title: descriptor.title,
            command: descriptor.command,
            arguments: descriptor.arguments,
          },
        ),
    );
  }
}