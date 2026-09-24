/**
 * SQL execution and table-viewer commands.
 *
 * The host owns connection selection and execution. A webview/editor never
 * receives a stored credential, and a query can only run against an already
 * validated profile exposed by the registry.
 *
 * SQL file behaviour:
 *  - `dbclient.query.runSelection` runs the current selection, or the statement
 *    under the cursor when nothing is selected.
 *  - `dbclient.query.runAll` splits the whole document with the engine-aware
 *    splitter and executes every statement in order, stopping at the first
 *    error.
 *  - `dbclient.query.selectConnection` picks the connection remembered for the
 *    active SQL file (workspaceState, never written into the file).
 */

import { basename } from 'node:path';
import * as vscode from 'vscode';
import { DbError } from '../db/errors';
import type { ConnectionProfile, DatabaseDriver, QueryExecutionResult } from '../db/types';
import { quoteMysqlIdentifier } from '../db/drivers/mysql/mysqlDriver';
import { RelationNode } from '../explorer/nodes';
import { sqlFileAssociations } from '../sql/sqlFileState';
import { splitSqlStatements, statementAtOffset, type SqlStatement } from '../sql/sqlStatements';
import { QueryResultPanel, type QueryStatementDisplay } from '../ui/queryResultPanel';
import { TableViewerPanel } from '../ui/tableViewerPanel';
import { globalRedactor } from '../util/redaction';
import { engineLabel } from '../util/engineDisplay';
import { connectionIdOf } from './connectionCommands';
import type { CommandServices, Register } from './types';

interface QueryTarget {
  readonly profile: ConnectionProfile;
  readonly driver: DatabaseDriver;
  /**
   * Database override remembered for the file (association), or `undefined` to
   * keep the profile's default database.
   */
  readonly database: string | undefined;
}

/** One statement to execute, with absolute offsets in the source document. */
interface RunnableStatement {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

async function ensureDriver(services: CommandServices, profile: ConnectionProfile): Promise<QueryTarget> {
  const status = services.manager.statusOf(profile.id);
  if (status?.state !== 'connected') {
    const config = await services.store.readConfig(profile.id);
    if (!config) {
      throw new DbError('CONFIG_ERROR', `Connection '${profile.name}' no longer exists.`);
    }
    await services.manager.connect(config);
  }
  const driver = services.manager.getDriver(profile.id);
  if (!driver) {
    throw new DbError('CONNECTION_LOST', `Connection '${profile.name}' is not open.`);
  }
  // No file-level database override here: callers with an association replace
  // `database` after this resolves.
  return { profile, driver, database: undefined };
}

function userMessage(error: unknown): string {
  const dbError = DbError.from(error, 'QUERY_ERROR');
  return globalRedactor.redact(dbError.message);
}

function requireSqlEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'sql') {
    void vscode.window.showInformationMessage('Open a .sql document before running a DataDock query.');
    return undefined;
  }
  return editor;
}

async function pickProfile(services: CommandServices, title: string): Promise<ConnectionProfile | undefined> {
  const profiles = await services.store.list();
  if (profiles.length === 0) {
    void vscode.window.showInformationMessage('Create a DataDock connection before running SQL.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    profiles.map((profile) => ({
      label: profile.name,
      description: profile.host ? `${profile.engine} · ${profile.host}` : profile.engine,
      profile,
    })),
    { title, placeHolder: 'Connection' },
  );
  return picked?.profile;
}

/**
 * Resolves the connection for an editor: an explicit tree node wins, then the
 * remembered per-file association, otherwise a QuickPick that is persisted so
 * later runs on the same file need no question.
 */
async function pickTargetForDocument(
  services: CommandServices,
  editor: vscode.TextEditor,
  node?: unknown,
): Promise<QueryTarget | undefined> {
  const directId = connectionIdOf(node);
  if (directId) {
    const profile = await services.store.get(directId);
    if (profile) {
      return ensureDriver(services, profile);
    }
  }

  const state = sqlFileAssociations();
  const uri = editor.document.uri;
  const association = state.getAssociation(uri);
  if (association) {
    const profile = await services.store.get(association.connectionId);
    if (profile) {
      const target = await ensureDriver(services, profile);
      return { ...target, database: association.database };
    }
    // The association points at a deleted profile; let the picker replace it.
  }

  const profile = await pickProfile(services, 'Select a DataDock connection for this SQL file');
  if (!profile) {
    return undefined;
  }
  await state.set(uri, profile.id);
  void vscode.window.setStatusBarMessage(
    `DataDock: this SQL file will use '${profile.name}'.`,
    4000,
  );
  return ensureDriver(services, profile);
}

function catchTargetError(error: unknown): void {
  void vscode.window.showErrorMessage(`DataDock connection failed: ${userMessage(error)}`);
}

function toRunnableStatements(statements: readonly SqlStatement[], baseOffset: number): RunnableStatement[] {
  return statements.map((statement) => ({
    text: statement.text,
    start: baseOffset + statement.start,
    end: baseOffset + statement.end,
  }));
}

/** Opens the document and selects the statement range a result belongs to. */
export async function revealSqlRange(uri: vscode.Uri, start: number, end: number): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true,
    });
    const limit = document.getText().length;
    const from = Math.min(Math.max(0, start), limit);
    const to = Math.min(Math.max(from, end), limit);
    const range = new vscode.Range(document.positionAt(from), document.positionAt(to));
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch {
    // Best effort: the file may have been closed, renamed or moved meanwhile.
  }
}

/**
 * Executes a list of statements sequentially against one driver and renders a
 * batch result panel. Stops at the first failure; the remaining statements are
 * marked as skipped so the user sees exactly where the batch halted.
 *
 * When the file remembers a database override (`defaultDatabase`) for a
 * MySQL/MariaDB connection, a `USE` statement is executed first so unqualified
 * names resolve against the chosen database.
 */
async function runStatements(
  services: CommandServices,
  target: QueryTarget,
  uri: vscode.Uri,
  items: readonly RunnableStatement[],
  progressTitle: string,
  defaultDatabase?: string,
): Promise<void> {
  const statements: RunnableStatement[] = [...items];
  const mysqlFamily = target.profile.engine === 'mysql' || target.profile.engine === 'mariadb';
  if (
    mysqlFamily &&
    typeof defaultDatabase === 'string' &&
    defaultDatabase.length > 0 &&
    defaultDatabase !== target.profile.database
  ) {
    statements.unshift({
      text: `USE ${quoteMysqlIdentifier(defaultDatabase)}`,
      start: 0,
      end: 0,
    });
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: progressTitle,
      cancellable: true,
    },
    async (_progress, token) => {
      const started = Date.now();
      const displays: QueryStatementDisplay[] = [];
      let cancelled = false;

      for (let index = 0; index < statements.length; index += 1) {
        if (token.isCancellationRequested) {
          cancelled = true;
          for (let rest = index; rest < statements.length; rest += 1) {
            displays.push({
              index: rest + 1,
              text: statements[rest].text,
              start: statements[rest].start,
              end: statements[rest].end,
              results: [],
              skipped: true,
              durationMs: 0,
            });
          }
          break;
        }
        const item = statements[index];
        try {
          const result: QueryExecutionResult = await target.driver.execute(item.text, token);
          if (result.results.some((resultSet) => resultSet.isMutation)) {
            services.cache.invalidate(`profile:${target.profile.id}`);
          }
          displays.push({
            index: index + 1,
            text: item.text,
            start: item.start,
            end: item.end,
            results: result.results,
            durationMs: result.durationMs,
          });
        } catch (error) {
          const dbError = DbError.from(error, 'QUERY_ERROR');
          const message = globalRedactor.redact(dbError.message);
          displays.push({
            index: index + 1,
            text: item.text,
            start: item.start,
            end: item.end,
            results: [],
            error: message,
            durationMs: 0,
          });
          for (let rest = index + 1; rest < statements.length; rest += 1) {
            displays.push({
              index: rest + 1,
              text: statements[rest].text,
              start: statements[rest].start,
              end: statements[rest].end,
              results: [],
              skipped: true,
              durationMs: 0,
            });
          }
          services.logger.error('SQL statement failed.', { code: dbError.code, connection: target.profile.id });
          break;
        }
      }

      const durationMs = Date.now() - started;
      const hasError = displays.some((display) => display.error !== undefined);
      QueryResultPanel.show(
        {
          key: `sql:${uri.toString()}`,
          panelTitle: `DataDock - ${basename(uri.fsPath) || 'Query Result'}`,
          connectionName: target.profile.name,
          database: target.profile.database,
          durationMs,
          notices: [],
          statements: displays,
          hasError,
        },
        (start, end) => void revealSqlRange(uri, start, end),
      );
      services.logger.info('SQL batch completed.', {
        connection: target.profile.id,
        statements: items.length,
        executed: displays.length - displays.filter((display) => display.skipped).length,
        durationMs,
      });

      if (cancelled) {
        void vscode.window.showInformationMessage('DataDock query cancelled.');
      }
    },
  );
}

export function registerQueryCommands(register: Register, services: CommandServices): void {
  register('dbclient.query.open', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: '-- DataDock SQL editor\n',
    });
    await vscode.window.showTextDocument(document, { preview: false });
  });

  register('dbclient.query.runSelection', async (node?: unknown) => {
    const editor = requireSqlEditor();
    if (!editor) {
      return;
    }
    let target: QueryTarget | undefined;
    try {
      target = await pickTargetForDocument(services, editor, node);
    } catch (error) {
      catchTargetError(error);
      return;
    }
    if (!target) {
      return;
    }

    const document = editor.document;
    let items: RunnableStatement[];
    if (!editor.selection.isEmpty) {
      const base = document.offsetAt(editor.selection.start);
      items = toRunnableStatements(splitSqlStatements(document.getText(editor.selection), target.profile.engine), base);
    } else {
      const statements = splitSqlStatements(document.getText(), target.profile.engine);
      const current = statementAtOffset(statements, document.offsetAt(editor.selection.active));
      items = current ? toRunnableStatements([current], 0) : [];
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Enter a SQL statement before running the query.');
      return;
    }
    await runStatements(services, target, document.uri, items, `Running selected SQL on ${target.profile.name}`, target.database);
  });

  register('dbclient.query.runAll', async (node?: unknown) => {
    const editor = requireSqlEditor();
    if (!editor) {
      return;
    }
    let target: QueryTarget | undefined;
    try {
      target = await pickTargetForDocument(services, editor, node);
    } catch (error) {
      catchTargetError(error);
      return;
    }
    if (!target) {
      return;
    }

    const document = editor.document;
    const items = toRunnableStatements(splitSqlStatements(document.getText(), target.profile.engine), 0);
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Enter at least one SQL statement before running the queries.');
      return;
    }
    await runStatements(services, target, document.uri, items, `Running all queries on ${target.profile.name}`, target.database);
  });

  // Historical alias kept for compatibility: behaves like Run All Queries.
  register('dbclient.query.execute', async (node?: unknown) => {
    const editor = requireSqlEditor();
    if (!editor) {
      return;
    }
    let target: QueryTarget | undefined;
    try {
      target = await pickTargetForDocument(services, editor, node);
    } catch (error) {
      catchTargetError(error);
      return;
    }
    if (!target) {
      return;
    }
    const document = editor.document;
    const items = toRunnableStatements(splitSqlStatements(document.getText(), target.profile.engine), 0);
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Enter at least one SQL statement before running the query.');
      return;
    }
    await runStatements(services, target, document.uri, items, `Running SQL on ${target.profile.name}`, target.database);
  });

  register('dbclient.query.runStatement', async (...args: unknown[]) => {
    let editor = vscode.window.activeTextEditor;
    let rangeStart: number | undefined;
    let rangeEnd: number | undefined;
    const uriArg = args[0];
    if (uriArg instanceof vscode.Uri || (typeof uriArg === 'string' && uriArg.length > 0)) {
      const document = await vscode.workspace.openTextDocument(
        uriArg instanceof vscode.Uri ? uriArg : vscode.Uri.parse(uriArg),
      );
      editor = await vscode.window.showTextDocument(document, { preview: false });
      rangeStart = typeof args[1] === 'number' ? args[1] : undefined;
      rangeEnd = typeof args[2] === 'number' ? args[2] : undefined;
    }
    if (!editor || editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a .sql document before running a DataDock query.');
      return;
    }
    let target: QueryTarget | undefined;
    try {
      target = await pickTargetForDocument(services, editor);
    } catch (error) {
      catchTargetError(error);
      return;
    }
    if (!target) {
      return;
    }

    const document = editor.document;
    let items: RunnableStatement[];
    if (rangeStart !== undefined && rangeEnd !== undefined) {
      const from = Math.min(Math.max(0, rangeStart), document.getText().length);
      const to = Math.min(Math.max(from, rangeEnd), document.getText().length);
      items = [{ text: document.getText(new vscode.Range(document.positionAt(from), document.positionAt(to))), start: from, end: to }];
    } else if (!editor.selection.isEmpty) {
      const base = document.offsetAt(editor.selection.start);
      items = toRunnableStatements(splitSqlStatements(document.getText(editor.selection), target.profile.engine), base);
    } else {
      const statements = splitSqlStatements(document.getText(), target.profile.engine);
      const current = statementAtOffset(statements, document.offsetAt(editor.selection.active));
      items = current ? toRunnableStatements([current], 0) : [];
    }
    if (items.length === 0) {
      void vscode.window.showInformationMessage('Enter a SQL statement before running the query.');
      return;
    }
    await runStatements(services, target, document.uri, items, `Running this query on ${target.profile.name}`, target.database);
  });

  register('dbclient.query.selectDatabase', async (uriArg?: unknown) => {
    const editor = vscode.window.activeTextEditor;
    const activeUri =
      uriArg instanceof vscode.Uri
        ? uriArg
        : typeof uriArg === 'string' && uriArg.length > 0
          ? vscode.Uri.parse(uriArg)
          : editor?.document.uri;
    if (!activeUri) {
      void vscode.window.showInformationMessage('Open a .sql document before selecting a database.');
      return;
    }
    if (uriArg instanceof vscode.Uri || typeof uriArg === 'string') {
      try {
        const candidate = await vscode.workspace.openTextDocument(activeUri);
        if (candidate.languageId !== 'sql') {
          void vscode.window.showInformationMessage('Open a .sql document before selecting a database.');
          return;
        }
      } catch {
        void vscode.window.showInformationMessage('The SQL document could not be opened.');
        return;
      }
    } else if (editor && editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a .sql document before selecting a database.');
      return;
    }
    const state = sqlFileAssociations();
    const association = state.getAssociation(activeUri);
    if (!association) {
      void vscode.window.showInformationMessage('Select a DataDock connection for this SQL file first.');
      return;
    }
    const profile = await services.store.get(association.connectionId);
    if (!profile) {
      void vscode.window.showInformationMessage('The connection for this SQL file no longer exists.');
      return;
    }
    let target: QueryTarget | undefined;
    try {
      target = await ensureDriver(services, profile);
    } catch (error) {
      catchTargetError(error);
      return;
    }
    if (!target?.driver.capabilities.multipleDatabases) {
      void vscode.window.showInformationMessage(
        `${profile.engine === 'sqlite' ? 'SQLite' : engineLabel(profile.engine)} uses its file as the database; nothing to select.`,
      );
      return;
    }
    const databases = await target.driver.listDatabases();
    const current = association.database ?? profile.database;
    const picked = await vscode.window.showQuickPick(
      databases.map((database) => ({
        label: database === current ? `${database} (current)` : database,
        database,
      })),
      { title: 'DataDock: database for this SQL file', placeHolder: 'Database' },
    );
    if (!picked) {
      return;
    }
    await state.setDatabase(activeUri, picked.database);
    services.cache.invalidate(`profile:${profile.id}`);
    void vscode.window.showInformationMessage(`This SQL file will use database '${picked.database}'.`);
  });

  register('dbclient.query.selectConnection', async (uriOrNode?: unknown) => {
    const activeUri =
      uriOrNode instanceof vscode.Uri
        ? uriOrNode
        : typeof uriOrNode === 'string' && uriOrNode.length > 0
          ? vscode.Uri.parse(uriOrNode)
          : vscode.window.activeTextEditor?.document.uri;
    if (!activeUri) {
      void vscode.window.showInformationMessage('Open a .sql document before selecting a DataDock connection.');
      return;
    }
    if (uriOrNode instanceof vscode.Uri || typeof uriOrNode === 'string') {
      try {
        const candidate = await vscode.workspace.openTextDocument(activeUri);
        if (candidate.languageId !== 'sql') {
          void vscode.window.showInformationMessage('Open a .sql document before selecting a DataDock connection.');
          return;
        }
      } catch {
        void vscode.window.showInformationMessage('The SQL document could not be opened.');
        return;
      }
    } else if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a .sql document before selecting a DataDock connection.');
      return;
    }
    const state = sqlFileAssociations();
    const profiles = await services.store.list();
    if (profiles.length === 0) {
      void vscode.window.showInformationMessage('Create a DataDock connection before running SQL.');
      return;
    }
    const currentId = connectionIdOf(uriOrNode) ?? state.get(activeUri);
    const picked = await vscode.window.showQuickPick(
      profiles.map((profile) => ({
        label: profile.id === currentId ? `${profile.name} (current)` : profile.name,
        description: profile.host ? `${profile.engine} · ${profile.host}` : profile.engine,
        profile,
      })),
      { title: 'DataDock: connection for this SQL file', placeHolder: 'Connection (remembered for this file)' },
    );
    if (!picked) {
      return;
    }
    await state.set(activeUri, picked.profile.id);
    void vscode.window.showInformationMessage(`This SQL file will use '${picked.profile.name}'.`);
  });

  register('dbclient.table.view', (node?: unknown) => {
    if (!(node instanceof RelationNode)) {
      void vscode.window.showInformationMessage('Select a table or view in DataDock to browse its data.');
      return;
    }
    TableViewerPanel.show({
      manager: services.manager,
      logger: services.logger,
      ref: node.ref,
      title: `${node.ref.database}.${node.ref.table}`,
    });
  });
}