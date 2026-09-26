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
import { RelationNode } from '../explorer/nodes';
import {
  clearHistoryEntries,
  historyEntryLabel,
  historyEntryWhen,
  readHistoryState,
  recordHistoryEntries,
  removeHistoryEntry,
  setHistoryEnabled,
  writeHistoryState,
  type QueryHistoryEntry,
  type QueryHistoryInput,
  type QueryHistoryState,
  type QueryHistoryStorage,
} from '../sql/queryHistory';
import { sqlFileAssociations, type SqlFileAssociation } from '../sql/sqlFileState';
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

/** Bound during activation (`initQueryHistory`) so every run records here. */
let historyStorage: QueryHistoryStorage | undefined;

/** Binds the workspace Memento used by the query history (called once). */
export function initQueryHistory(state: QueryHistoryStorage): void {
  historyStorage = state;
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
 * Completes the first-time configuration of a SQL file by guaranteeing the
 * freshly-picked connection has an active database, so a MySQL/MariaDB
 * connection without a default database never fails with the raw server error
 * "No database selected".
 *
 * Only called right after the connection QuickPick (new file). The effective
 * database is the file override, else the profile default. When neither exists
 * on a multi-database engine, the user is asked to pick one; the choice is
 * remembered for the file (`fileUri`) and the returned override is applied as
 * the batch's implicit session context (visible nowhere).
 */
export interface RunDatabaseResolution {
  /** True when the batch must be aborted (no database could be chosen). */
  readonly aborted: boolean;
  /** Override to hand to `runStatements`; undefined keeps the profile default. */
  readonly override: string | undefined;
}

async function ensureRunDatabase(
  target: QueryTarget,
  fileUri: vscode.Uri | undefined,
  override: string | undefined,
): Promise<RunDatabaseResolution> {
  if (!target.driver.capabilities.multipleDatabases) {
    // SQLite: the file IS the database; no USE can or should be injected.
    return { aborted: false, override: undefined };
  }
  const effective = override ?? target.profile.database;
  if (typeof effective === 'string' && effective.length > 0) {
    return { aborted: false, override };
  }
  let databases: string[];
  try {
    databases = await target.driver.listDatabases();
  } catch (error) {
    catchTargetError(error);
    return { aborted: true, override: undefined };
  }
  const picked = await vscode.window.showQuickPick(
    databases.map((database) => ({ label: database, database })),
    {
      title: 'DataDock: database for this SQL file',
      placeHolder: 'This connection has no default database. Pick one to run against.',
    },
  );
  if (!picked) {
    void vscode.window.showInformationMessage('Query cancelled: no database selected for this run.');
    return { aborted: true, override: undefined };
  }
  if (fileUri) {
    await sqlFileAssociations().setDatabase(fileUri, picked.database);
  }
  return { aborted: false, override: picked.database };
}

/**
 * Resolves the connection for an editor: an explicit tree node wins, then the
 * remembered per-file association, otherwise a QuickPick that is persisted so
 * later runs on the same file need no question.
 *
 * Selectors appear ONLY while the file is being configured for the first time.
 * A run on a file that already has an association (or on an explicit tree
 * node) never re-opens a picker: the stored database override - or the
 * profile/session default when none is configured - scopes the batch
 * implicitly, and a user-written `USE` inside the SQL still works.
 */
async function pickTargetForDocument(
  services: CommandServices,
  editor: vscode.TextEditor,
  node?: unknown,
): Promise<QueryTarget | undefined> {
  const state = sqlFileAssociations();
  const uri = editor.document.uri;

  let override: string | undefined;
  let profile: ConnectionProfile | undefined;
  let hadContext = false;

  let association: SqlFileAssociation | undefined;
  const directId = connectionIdOf(node);
  if (directId) {
    profile = await services.store.get(directId);
    hadContext = true;
  } else {
    association = state.getAssociation(uri);
    if (association) {
      override = association.database;
      profile = await services.store.get(association.connectionId);
      // A stored association whose profile no longer exists is not a context:
      // the file goes through the guided first-time configuration again.
      hadContext = !!profile;
    }
  }

  if (!profile) {
    profile = await pickProfile(services, 'Select a DataDock connection for this SQL file');
    if (!profile) {
      return undefined;
    }
    // Any override left over belonged to a connection that may be gone; the
    // fresh association starts from the profile default.
    override = undefined;
    await state.set(uri, profile.id);
    void vscode.window.setStatusBarMessage(`DataDock: this SQL file will use '${profile.name}'.`, 4000);
  }

  const target = await ensureDriver(services, profile);
  if (hadContext) {
    return { ...target, database: override };
  }
  // First-time configuration of a brand-new SQL file: the connection was just
  // picked, so the database question completes the flow and is remembered.
  const resolution = await ensureRunDatabase(target, uri, override);
  if (resolution.aborted) {
    return undefined;
  }
  return { ...target, database: resolution.override };
}

function catchTargetError(error: unknown): void {
  void vscode.window.showErrorMessage(`DataDock connection failed: ${userMessage(error)}`);
}

/**
 * Opens the database picker for an existing per-file association and persists
 * the chosen database as the file's override. Engines without multiple
 * databases are skipped silently (SQLite keeps its file as the database);
 * `informNonMulti` decides whether that case is explained to the user instead.
 */
async function pickAndSetDatabase(
  services: CommandServices,
  uri: vscode.Uri,
  association: SqlFileAssociation,
  informNonMulti: boolean,
): Promise<void> {
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
    if (informNonMulti) {
      void vscode.window.showInformationMessage(
        `${profile.engine === 'sqlite' ? 'SQLite' : engineLabel(profile.engine)} uses its file as the database; nothing to select.`,
      );
    }
    return;
  }
  let databases: string[];
  try {
    databases = await target.driver.listDatabases();
  } catch (error) {
    catchTargetError(error);
    return;
  }
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
  await sqlFileAssociations().setDatabase(uri, picked.database);
  services.cache.invalidate(`profile:${profile.id}`);
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
 * The file's active database is applied implicitly first (through the driver's
 * `selectDatabase`, never rendered as a statement) so unqualified names resolve
 * against the chosen database without an artificial `USE` in the results.
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
  // The database for this file (override first, profile default second) is the
  // session context, not a statement: scoping happens inside the driver and the
  // batch contains only what the user wrote. Without a configured database the
  // socket keeps the profile default scoping.
  const effectiveDatabase = defaultDatabase ?? target.profile.database;
  if (
    target.driver.capabilities.multipleDatabases &&
    typeof target.driver.selectDatabase === 'function' &&
    typeof effectiveDatabase === 'string' &&
    effectiveDatabase.length > 0
  ) {
    try {
      await target.driver.selectDatabase(effectiveDatabase);
    } catch (error) {
      catchTargetError(error);
      return;
    }
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
      recordBatchHistory(services, target, effectiveDatabase, displays);
      QueryResultPanel.show(
        {
          key: `sql:${uri.toString()}`,
          panelTitle: `DataDock - ${basename(uri.fsPath) || 'Query Result'}`,
          connectionName: target.profile.name,
          database: defaultDatabase ?? target.profile.database,
          engine: target.profile.engine,
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

/** Persists every executed statement of the batch in the query history. */
function recordBatchHistory(
  services: CommandServices,
  target: QueryTarget,
  database: string | undefined,
  displays: readonly QueryStatementDisplay[],
): void {
  const storage = historyStorage;
  if (!storage) {
    return;
  }
  const state = readHistoryState(storage);
  if (!state.enabled) {
    return;
  }
  const databaseName = database && database.length > 0 ? database : undefined;
  const inputs: QueryHistoryInput[] = displays
    .filter((display) => !display.skipped)
    .map((display) => ({
      sql: display.text,
      connectionId: target.profile.id,
      connectionName: target.profile.name,
      database: databaseName,
      timestamp: Date.now(),
      durationMs: display.durationMs,
      status: display.error !== undefined ? ('error' as const) : ('ok' as const),
      error: display.error,
    }));
  if (inputs.length === 0) {
    return;
  }
  void writeHistoryState(storage, recordHistoryEntries(state, inputs)).catch((error: unknown) => {
    services.logger.error('Failed to persist query history.', { error: String(error) });
  });
}

/** Inserts the recorded statement at the cursor (DBCode "Load"). */
async function loadHistoryIntoEditor(sql: string): Promise<void> {
  try {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const position = editor.selection.active;
      const applied = await editor.edit((builder) => builder.insert(position, sql));
      if (applied) {
        return;
      }
    }
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: sql });
    await vscode.window.showTextDocument(document, { preview: false });
  } catch {
    void vscode.window.showErrorMessage('DataDock: could not load the query into the editor.');
  }
}

/** One QuickPick row: a recorded statement or the clear action. */
interface HistoryPick extends vscode.QuickPickItem {
  readonly action: 'entry' | 'clear';
  readonly entry?: QueryHistoryEntry;
}

/** Clear action first, then every entry newest first (DBCode history list). */
function historyItems(state: QueryHistoryState): HistoryPick[] {
  const clear: HistoryPick = {
    label: '$(clear-all) Clear History',
    description: `${state.entries.length} recorded`,
    action: 'clear',
  };
  const entries: HistoryPick[] = state.entries.map((entry) => ({
    label: `${entry.status === 'error' ? '$(error)' : '$(database)'} ${historyEntryLabel(entry)}`,
    description: `${entry.connectionName}${entry.database ? ` : ${entry.database}` : ''}`,
    detail: `${historyEntryWhen(entry.timestamp)} · ${Math.round(entry.durationMs)}ms${
      entry.status === 'error' && entry.error ? ` · ${entry.error}` : ''
    }`,
    action: 'entry',
    entry,
    buttons: [
      { iconPath: new vscode.ThemeIcon('file-code'), tooltip: 'Load into editor' },
      { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy query' },
      { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete from history' },
    ],
  }));
  return [clear, ...entries];
}

/**
 * History panel (DBCode's query history): Enter loads the statement into the
 * editor, the item buttons load / copy / delete inline, and the pinned Clear
 * History action empties the list after a confirmation.
 */
async function showHistoryPicker(
  services: CommandServices,
  storage: QueryHistoryStorage,
  initial: QueryHistoryState,
): Promise<void> {
  let state = initial;
  const picker = vscode.window.createQuickPick<HistoryPick>();
  picker.placeholder = 'Query history, newest first. Select an entry to load it into the editor.';
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.items = historyItems(state);

  const refresh = (): void => {
    picker.items = historyItems(state);
  };
  const persist = async (): Promise<void> => {
    try {
      await writeHistoryState(storage, state);
    } catch {
      services.logger.error('Failed to persist query history.');
    }
  };

  picker.onDidTriggerItemButton(async (event) => {
    const item = event.item;
    if (item.action !== 'entry' || !item.entry) {
      return;
    }
    if (event.button.tooltip === 'Load into editor') {
      picker.hide();
      await loadHistoryIntoEditor(item.entry.sql);
      return;
    }
    if (event.button.tooltip === 'Copy query') {
      await vscode.env.clipboard.writeText(item.entry.sql);
      return;
    }
    if (event.button.tooltip === 'Delete from history') {
      state = removeHistoryEntry(state, item.entry.id);
      await persist();
      refresh();
    }
  });

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      picker.dispose();
      resolve();
    };
    picker.onDidAccept(async () => {
      const selected = picker.selectedItems[0];
      if (!selected) {
        picker.hide();
        return;
      }
      if (selected.action === 'clear') {
        const confirm = await vscode.window.showWarningMessage('Clear the whole query history?', { modal: true }, 'Clear');
        if (confirm === 'Clear') {
          state = clearHistoryEntries(state);
          await persist();
          refresh();
        }
        return;
      }
      if (selected.entry) {
        picker.hide();
        await loadHistoryIntoEditor(selected.entry.sql);
      }
    });
    picker.onDidHide(() => finish());
    picker.show();
  });
}

export function registerQueryCommands(register: Register, services: CommandServices): void {
  register('dbclient.query.showHistory', async () => {
    const storage = historyStorage;
    if (!storage) {
      return;
    }
    let state = readHistoryState(storage);
    if (!state.enabled) {
      const choice = await vscode.window.showInformationMessage('DataDock query history recording is disabled.', 'Enable');
      if (choice === 'Enable') {
        state = setHistoryEnabled(state, true);
        await writeHistoryState(storage, state);
        void vscode.window.showInformationMessage('DataDock: query history recording enabled.');
      }
      return;
    }
    if (state.entries.length === 0) {
      void vscode.window.showInformationMessage('Query history is empty. Run a SQL query to record it.');
      return;
    }
    await showHistoryPicker(services, storage, state);
  });

  register('dbclient.query.toggleHistory', async () => {
    const storage = historyStorage;
    if (!storage) {
      return;
    }
    const state = readHistoryState(storage);
    const next = setHistoryEnabled(state, !state.enabled);
    await writeHistoryState(storage, next);
    void vscode.window.showInformationMessage(`DataDock: query history recording ${next.enabled ? 'enabled' : 'disabled'}.`);
  });

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
    let association = state.getAssociation(activeUri);
    if (association) {
      const existing = await services.store.get(association.connectionId);
      if (!existing) {
        // The stored connection is gone: reconfigure the file end to end.
        await vscode.commands.executeCommand('dbclient.query.selectConnection', activeUri);
        return;
      }
    } else {
      const picked = await pickProfile(services, 'Select a DataDock connection for this SQL file');
      if (!picked) {
        return;
      }
      await state.set(activeUri, picked.id);
      association = { connectionId: picked.id, database: undefined };
    }
    await pickAndSetDatabase(services, activeUri, association, true);
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
    // Database Client-style flow: a connection pick is followed immediately by
    // the database picker so the file gets a full run context in one step.
    // Engines without multiple databases (SQLite) are skipped silently.
    await pickAndSetDatabase(services, activeUri, { connectionId: picked.profile.id, database: undefined }, false);
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
      engine: services.manager.getDriver(node.ref.connectionId)?.engine,
      title: `${node.ref.database}.${node.ref.table}`,
    });
  });

  /**
   * Opens a menu to manage the SQL file's connection/database context.
   * Replaces the two separate status bar clicks with a single unified action.
   */
  register('dbclient.query.manageContext', async (uriArg?: unknown) => {
    const editor = vscode.window.activeTextEditor;
    const activeUri =
      uriArg instanceof vscode.Uri
        ? uriArg
        : typeof uriArg === 'string' && uriArg.length > 0
        ? vscode.Uri.parse(uriArg)
        : editor?.document.uri;
    if (!activeUri) {
      void vscode.window.showInformationMessage('Open a .sql document before managing the DataDock context.');
      return;
    }
    if (uriArg instanceof vscode.Uri || typeof uriArg === 'string') {
      try {
        const candidate = await vscode.workspace.openTextDocument(activeUri);
        if (candidate.languageId !== 'sql') {
          void vscode.window.showInformationMessage('Open a .sql document before managing the DataDock context.');
          return;
        }
      } catch {
        void vscode.window.showInformationMessage('The SQL document could not be opened.');
        return;
      }
    } else if (editor && editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a .sql document before managing the DataDock context.');
      return;
    }

    const state = sqlFileAssociations();
    const association = state.getAssociation(activeUri);
    // A stale association (deleted connection) is treated as no context so the
    // menu reconfigures the file instead of showing an empty picker.
    const profile = association ? await services.store.get(association.connectionId) : undefined;
    const profiles = await services.store.list();

    const items: { label: string; description?: string; action: 'connection' | 'database' | 'disconnect' }[] = [];

    if (profile && association) {
      items.push({
        label: '$(pencil) Change Connection',
        description: `Current: ${profile.name}`,
        action: 'connection',
      });
      if (profile.engine !== 'sqlite') {
        const currentDb = association.database ?? profile.database;
        items.push({
          label: '$(database) Change Database',
          description: currentDb ? `Current: ${currentDb}` : 'No database selected',
          action: 'database',
        });
      }
      items.push({
        label: '$(trash) Disconnect',
        description: `Remove context for this file`,
        action: 'disconnect',
      });
    } else {
      if (profiles.length === 0) {
        void vscode.window.showInformationMessage('Create a DataDock connection first.');
        return;
      }
      items.push({
        label: '$(plug) Select Connection',
        description: 'Choose a connection for this SQL file',
        action: 'connection',
      });
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'DataDock: manage context for this SQL file',
      placeHolder: profile ? 'Choose an action' : 'Select a connection',
    });

    if (!picked) {
      return;
    }

    if (picked.action === 'connection') {
      // Reuse the existing selectConnection logic
      await vscode.commands.executeCommand('dbclient.query.selectConnection', activeUri);
    } else if (picked.action === 'database') {
      await vscode.commands.executeCommand('dbclient.query.selectDatabase', activeUri);
    } else if (picked.action === 'disconnect') {
      await state.set(activeUri, undefined);
      void vscode.window.showInformationMessage('DataDock context cleared for this SQL file.');
    }
  });
}