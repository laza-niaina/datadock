/**
 * Query history (the DataDock take on DBCode's "Query history" panel).
 *
 * Every executed statement of a batch is recorded newest-first with its
 * connection, database, duration and status, capped at a fixed limit, and the
 * whole state persists in `workspaceState` behind a structural storage
 * interface so `node --test` can lock the behaviour without VS Code.
 *
 * The feature can be disabled (DBCode's "enable" toggle) without losing the
 * already recorded entries.
 */

/** Versioned key so a schema change can migrate instead of corrupt. */
export const QUERY_HISTORY_STORAGE_KEY = 'dbclient.queryHistory.v1';

/** Upper bound of retained statements; oldest entries fall off first. */
export const QUERY_HISTORY_LIMIT = 500;

/** One executed statement. Never contains a credential. */
export interface QueryHistoryEntry {
  readonly id: string;
  /** Full statement text exactly as executed. */
  readonly sql: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly database?: string;
  /** Epoch milliseconds of the execution. */
  readonly timestamp: number;
  readonly durationMs: number;
  readonly status: 'ok' | 'error';
  /** Redacted driver message when the statement failed. */
  readonly error?: string;
}

export interface QueryHistoryState {
  readonly enabled: boolean;
  /** Newest first. */
  readonly entries: readonly QueryHistoryEntry[];
}

/** What a caller passes to record one executed statement. */
export interface QueryHistoryInput {
  readonly sql: string;
  readonly connectionId: string;
  readonly connectionName: string;
  readonly database?: string;
  readonly timestamp: number;
  readonly durationMs: number;
  readonly status: 'ok' | 'error';
  readonly error?: string;
}

/** Minimal Memento shape (structurally satisfied by `vscode.Memento`). */
export interface QueryHistoryStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): unknown;
}

export function createQueryHistoryState(): QueryHistoryState {
  return { enabled: true, entries: [] };
}

/** Minimal PRNG salt so same-millisecond batches and repeated runs get unique ids. */
let idSaltCounter = 0;

function makeId(timestamp: number, salt: number): string {
  idSaltCounter = (idSaltCounter + 1) % 1_047_29;
  const mixed = (salt * 31 + idSaltCounter * 6_559) % 1_047_29;
  return `qh-${timestamp.toString(36)}-${mixed.toString(36)}`;
}

/**
 * Prepends the batch (chronological, so the last executed statement ends up
 * on top) to the stored entries, caps the list and keeps `enabled`.
 */
export function recordHistoryEntries(
  state: QueryHistoryState,
  inputs: readonly QueryHistoryInput[],
): QueryHistoryState {
  if (inputs.length === 0) {
    return state;
  }
  const added: QueryHistoryEntry[] = inputs.map((input, index) => ({
    id: makeId(input.timestamp, index * 7 + (input.timestamp % 9973)),
    sql: input.sql,
    connectionId: input.connectionId,
    connectionName: input.connectionName,
    database: input.database,
    timestamp: input.timestamp,
    durationMs: input.durationMs,
    status: input.status,
    error: input.error,
  }));
  const entries = [...added.reverse(), ...state.entries].slice(0, QUERY_HISTORY_LIMIT);
  return { ...state, entries };
}

export function removeHistoryEntry(state: QueryHistoryState, id: string): QueryHistoryState {
  return { ...state, entries: state.entries.filter((entry) => entry.id !== id) };
}

export function clearHistoryEntries(state: QueryHistoryState): QueryHistoryState {
  return { ...state, entries: [] };
}

export function setHistoryEnabled(state: QueryHistoryState, enabled: boolean): QueryHistoryState {
  return { ...state, enabled };
}

/** Sanitizes whatever `workspaceState` holds into a valid state. */
export function parseQueryHistoryState(raw: unknown): QueryHistoryState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createQueryHistoryState();
  }
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled !== false;
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const entries: QueryHistoryEntry[] = [];
  for (const candidate of rawEntries) {
    const entry = normalizeEntry(candidate);
    if (entry) {
      entries.push(entry);
    }
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return { enabled, entries: entries.slice(0, QUERY_HISTORY_LIMIT) };
}

function normalizeEntry(candidate: unknown): QueryHistoryEntry | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record.sql !== 'string' || record.sql.trim() === '') {
    return undefined;
  }
  if (typeof record.connectionId !== 'string' || typeof record.connectionName !== 'string') {
    return undefined;
  }
  if (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) {
    return undefined;
  }
  const status = record.status === 'error' ? 'error' : 'ok';
  return {
    id: typeof record.id === 'string' && record.id !== '' ? record.id : makeId(record.timestamp, 0),
    sql: record.sql,
    connectionId: record.connectionId,
    connectionName: record.connectionName,
    database: typeof record.database === 'string' && record.database !== '' ? record.database : undefined,
    timestamp: record.timestamp,
    durationMs: typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) ? record.durationMs : 0,
    status,
    error: typeof record.error === 'string' && record.error !== '' ? record.error : undefined,
  };
}

/** Reads the state from storage (tolerating absent or corrupt values). */
export function readHistoryState(storage: QueryHistoryStorage): QueryHistoryState {
  try {
    return parseQueryHistoryState(storage.get<unknown>(QUERY_HISTORY_STORAGE_KEY));
  } catch {
    return createQueryHistoryState();
  }
}

/** Persists the state; resolves when the write settles. */
export function writeHistoryState(storage: QueryHistoryStorage, state: QueryHistoryState): Promise<void> {
  return Promise.resolve(storage.update(QUERY_HISTORY_STORAGE_KEY, state)).then(() => undefined);
}

/** One-line QuickPick label: first non-empty line of the statement. */
export function historyEntryLabel(entry: QueryHistoryEntry): string {
  const line = entry.sql
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '' && !part.startsWith('--')) ?? entry.sql.trim();
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
}

/** `Today 14:32` / `Yesterday 14:32` / `2026-09-25 14:32`, computed from `now`. */
export function historyEntryWhen(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const current = new Date(now);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay(date, current)) {
    return `Today ${clock}`;
  }
  const yesterday = new Date(current.getTime() - 86_400_000);
  if (sameDay(date, yesterday)) {
    return `Yesterday ${clock}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
