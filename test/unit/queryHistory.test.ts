import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  QUERY_HISTORY_LIMIT,
  QUERY_HISTORY_STORAGE_KEY,
  clearHistoryEntries,
  createQueryHistoryState,
  historyEntryLabel,
  historyEntryWhen,
  parseQueryHistoryState,
  readHistoryState,
  recordHistoryEntries,
  removeHistoryEntry,
  setHistoryEnabled,
  writeHistoryState,
} from '../../src/sql/queryHistory';
import type {
  QueryHistoryInput,
  QueryHistoryStorage,
} from '../../src/sql/queryHistory';

function input(overrides: Partial<QueryHistoryInput> = {}): QueryHistoryInput {
  return {
    sql: 'SELECT 1',
    connectionId: 'conn-1',
    connectionName: 'local',
    database: 'app',
    timestamp: 1_700_000_000_000,
    durationMs: 12,
    status: 'ok',
    ...overrides,
  };
}

function memoryStorage(initial?: unknown): QueryHistoryStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  if (initial !== undefined) {
    data.set(QUERY_HISTORY_STORAGE_KEY, initial);
  }
  return {
    data,
    get<T>(key: string): T | undefined {
      return data.get(key) as T | undefined;
    },
    update(key: string, value: unknown): unknown {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('recordHistoryEntries', () => {
  it('starts from an empty enabled state', () => {
    const state = createQueryHistoryState();
    assert.equal(state.enabled, true);
    assert.deepEqual(state.entries, []);
  });

  it('returns the same state when the batch is empty', () => {
    const state = createQueryHistoryState();
    assert.equal(recordHistoryEntries(state, []), state);
  });

  it('puts the last executed statement of a batch on top', () => {
    const state = recordHistoryEntries(createQueryHistoryState(), [
      input({ sql: 'SELECT 1', timestamp: 1_000 }),
      input({ sql: 'SELECT 2', timestamp: 2_000 }),
      input({ sql: 'SELECT 3', timestamp: 3_000 }),
    ]);
    assert.deepEqual(
      state.entries.map((entry) => entry.sql),
      ['SELECT 3', 'SELECT 2', 'SELECT 1'],
    );
  });

  it('keeps new batches ahead of older ones and preserves enabled', () => {
    let state = recordHistoryEntries(createQueryHistoryState(), [input({ sql: 'older' })]);
    state = recordHistoryEntries(state, [input({ sql: 'newer', timestamp: 2_000 })]);
    assert.equal(state.entries[0].sql, 'newer');
    assert.equal(state.enabled, true);
  });

  it('caps the list at the history limit, dropping the oldest', () => {
    let state = createQueryHistoryState();
    const batch = Array.from({ length: QUERY_HISTORY_LIMIT + 25 }, (_, index) =>
      input({ sql: `SELECT ${index}`, timestamp: 1_000 + index }),
    );
    state = recordHistoryEntries(state, batch);
    assert.equal(state.entries.length, QUERY_HISTORY_LIMIT);
    assert.equal(state.entries[0].sql, `SELECT ${QUERY_HISTORY_LIMIT + 24}`);
    assert.equal(
      state.entries[state.entries.length - 1].sql,
      `SELECT ${25}`,
    );
  });

  it('records ok and error status plus the driver message', () => {
    const state = recordHistoryEntries(createQueryHistoryState(), [
      input({ status: 'error', error: 'syntax error near FROM', sql: 'SELECT FROM' }),
    ]);
    assert.equal(state.entries[0].status, 'error');
    assert.equal(state.entries[0].error, 'syntax error near FROM');
  });

  it('generates distinct ids across batches', () => {
    let state = recordHistoryEntries(createQueryHistoryState(), [input({ timestamp: 5_000 })]);
    state = recordHistoryEntries(state, [input({ timestamp: 5_000 })]);
    assert.notEqual(state.entries[0].id, state.entries[1].id);
  });
});

describe('removeHistoryEntry / clearHistoryEntries / setHistoryEnabled', () => {
  it('removes only the targeted entry', () => {
    const state = recordHistoryEntries(createQueryHistoryState(), [
      input({ sql: 'a', timestamp: 1 }),
      input({ sql: 'b', timestamp: 2 }),
    ]);
    const next = removeHistoryEntry(state, state.entries[0].id);
    assert.deepEqual(
      next.entries.map((entry) => entry.sql),
      ['a'],
    );
    assert.equal(next.enabled, true);
  });

  it('clearing keeps the enabled flag', () => {
    let state = setHistoryEnabled(createQueryHistoryState(), false);
    state = recordHistoryEntries(state, [input()]);
    state = clearHistoryEntries(state);
    assert.deepEqual(state.entries, []);
    assert.equal(state.enabled, false);
  });

  it('toggling off and on flips only enabled', () => {
    let state = recordHistoryEntries(createQueryHistoryState(), [input()]);
    state = setHistoryEnabled(state, false);
    assert.equal(state.enabled, false);
    assert.equal(state.entries.length, 1);
    state = setHistoryEnabled(state, true);
    assert.equal(state.enabled, true);
  });
});

describe('parseQueryHistoryState', () => {
  it('falls back to a fresh state for absent or corrupt input', () => {
    for (const raw of [undefined, null, 'nope', 42, [], true]) {
      const state = parseQueryHistoryState(raw);
      assert.equal(state.enabled, true);
      assert.deepEqual(state.entries, []);
    }
  });

  it('keeps enabled unless explicitly false', () => {
    assert.equal(parseQueryHistoryState({ enabled: false, entries: [] }).enabled, false);
    assert.equal(parseQueryHistoryState({ enabled: true, entries: [] }).enabled, true);
    assert.equal(parseQueryHistoryState({ entries: [] }).enabled, true);
  });

  it('drops malformed entries and keeps valid ones sorted newest first', () => {
    const state = parseQueryHistoryState({
      enabled: true,
      entries: [
        { sql: '', connectionId: 'c', connectionName: 'n', timestamp: 1, durationMs: 1, status: 'ok' },
        { sql: 'no connection', timestamp: 1 },
        { sql: 'bad timestamp', connectionId: 'c', connectionName: 'n', timestamp: 'x' },
        { sql: 'older', connectionId: 'c', connectionName: 'n', timestamp: 100, durationMs: 5, status: 'ok' },
        { sql: 'newer', connectionId: 'c', connectionName: 'n', timestamp: 200, durationMs: 5, status: 'error', error: 'boom' },
        null,
        'junk',
      ],
    });
    assert.deepEqual(
      state.entries.map((entry) => entry.sql),
      ['newer', 'older'],
    );
    assert.equal(state.entries[0].status, 'error');
    assert.equal(state.entries[0].error, 'boom');
    assert.equal(state.entries[1].status, 'ok');
    assert.equal(state.entries[1].error, undefined);
  });

  it('normalizes missing optional fields and synthesizes ids', () => {
    const state = parseQueryHistoryState({
      entries: [{ sql: 'SELECT 1', connectionId: 'c', connectionName: 'n', timestamp: 50 }],
    });
    const [entry] = state.entries;
    assert.ok(entry.id.startsWith('qh-'));
    assert.equal(entry.database, undefined);
    assert.equal(entry.durationMs, 0);
    assert.equal(entry.error, undefined);
  });

  it('caps the restored list at the history limit', () => {
    const entries = Array.from({ length: QUERY_HISTORY_LIMIT + 10 }, (_, index) => ({
      sql: `SELECT ${index}`,
      connectionId: 'c',
      connectionName: 'n',
      timestamp: index,
      durationMs: 1,
      status: 'ok',
    }));
    const state = parseQueryHistoryState({ entries });
    assert.equal(state.entries.length, QUERY_HISTORY_LIMIT);
  });
});

describe('readHistoryState / writeHistoryState', () => {
  it('reads what was written', async () => {
    const storage = memoryStorage();
    const state = recordHistoryEntries(createQueryHistoryState(), [input({ sql: 'SELECT 42' })]);
    await writeHistoryState(storage, state);
    const restored = readHistoryState(storage);
    assert.equal(restored.entries[0].sql, 'SELECT 42');
    assert.equal(restored.enabled, true);
  });

  it('returns a fresh state when storage is empty or the getter throws', () => {
    const empty = readHistoryState(memoryStorage());
    assert.deepEqual(empty.entries, []);

    const throwing: QueryHistoryStorage = {
      get() {
        throw new Error('storage unavailable');
      },
      update() {
        return undefined;
      },
    };
    const state = readHistoryState(throwing);
    assert.equal(state.enabled, true);
    assert.deepEqual(state.entries, []);
  });

  it('uses the versioned storage key', () => {
    const storage = memoryStorage({ enabled: false, entries: [] });
    assert.equal(storage.get(QUERY_HISTORY_STORAGE_KEY) !== undefined, true);
    assert.equal(readHistoryState(storage).enabled, false);
  });
});

describe('historyEntryLabel', () => {
  it('uses the first non-comment line', () => {
    assert.equal(
      historyEntryLabel({
        id: 'x',
        sql: '-- note\nSELECT * FROM users',
        connectionId: 'c',
        connectionName: 'n',
        timestamp: 0,
        durationMs: 1,
        status: 'ok',
      }),
      'SELECT * FROM users',
    );
  });

  it('flattens whitespace inside the chosen line', () => {
    assert.equal(
      historyEntryLabel({
        id: 'x',
        sql: 'SELECT   a,   b\nFROM t',
        connectionId: 'c',
        connectionName: 'n',
        timestamp: 0,
        durationMs: 1,
        status: 'ok',
      }),
      'SELECT a, b',
    );
  });

  it('caps long statements with an ellipsis', () => {
    const label = historyEntryLabel({
      id: 'x',
      sql: 'SELECT ' + 'x'.repeat(300),
      connectionId: 'c',
      connectionName: 'n',
      timestamp: 0,
      durationMs: 1,
      status: 'ok',
    });
    assert.equal(label.length, 101);
    assert.ok(label.endsWith('…'));
  });

  it('falls back to the raw statement when every line is a comment', () => {
    const label = historyEntryLabel({
      id: 'x',
      sql: '-- only\n-- comments',
      connectionId: 'c',
      connectionName: 'n',
      timestamp: 0,
      durationMs: 1,
      status: 'ok',
    });
    assert.notEqual(label, '');
  });
});

describe('historyEntryWhen', () => {
  const now = new Date(2026, 8, 26, 15, 0, 0).getTime();

  it('formats today', () => {
    const at = new Date(2026, 8, 26, 14, 32).getTime();
    assert.equal(historyEntryWhen(at, now), 'Today 14:32');
  });

  it('formats yesterday', () => {
    const at = new Date(2026, 8, 25, 9, 5).getTime();
    assert.equal(historyEntryWhen(at, now), 'Yesterday 09:05');
  });

  it('formats older dates as ISO-like timestamps', () => {
    const at = new Date(2026, 0, 3, 7, 4).getTime();
    assert.equal(historyEntryWhen(at, now), '2026-01-03 07:04');
  });
});
