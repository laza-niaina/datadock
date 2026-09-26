import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ExplorerObjectItem,
  explorerObjectItems,
  filterExplorerObjects,
  folderCountLabel,
  folderTooltip,
  fuzzyScore,
  matchObject,
  qualifiedName,
  toQuickPickItem,
} from '../../src/explorer/explorerSearch';

function item(overrides: Partial<ExplorerObjectItem> = {}): ExplorerObjectItem {
  return {
    connectionId: 'conn-1',
    connectionName: 'local-docker',
    database: 'appdb',
    table: 'users',
    kind: 'table',
    ...overrides,
  };
}

describe('qualifiedName', () => {
  it('joins database, schema and table', () => {
    assert.equal(qualifiedName({ database: 'db', schema: 'public', table: 'users' }), 'db.public.users');
  });

  it('omits absent schema and table segments', () => {
    assert.equal(qualifiedName({ database: 'db', table: 'users' }), 'db.users');
    assert.equal(qualifiedName({ database: 'db' }), 'db');
    assert.equal(qualifiedName({ database: 'db', schema: '' }), 'db');
  });
});

describe('fuzzyScore', () => {
  it('matches empty queries as zero', () => {
    assert.equal(fuzzyScore('', 'anything'), 0);
  });

  it('rejects non-matching patterns', () => {
    assert.equal(fuzzyScore('xyz', 'users'), undefined);
    assert.equal(fuzzyScore('usr', 'orders'), undefined);
  });

  it('scores compact and prefix matches higher', () => {
    const prefix = fuzzyScore('us', 'users');
    const scattered = fuzzyScore('us', 'status_report');
    assert.ok(prefix !== undefined && scattered !== undefined);
    assert.ok(prefix > scattered);
    assert.ok(fuzzyScore('users', 'users')! > fuzzyScore('users', 'users_backup')!);
  });
});

describe('matchObject', () => {
  it('ranks name matches above database-only matches', () => {
    const byName = matchObject('use', item());
    const byDb = matchObject('app', item());
    assert.ok(byName !== undefined && byDb !== undefined);
    assert.ok(byName > byDb);
  });

  it('falls back to connection names for cross-profile search', () => {
    assert.ok(matchObject('docker', item()) !== undefined);
  });

  it('returns undefined when nothing matches', () => {
    assert.equal(matchObject('qqq', item()), undefined);
  });
});

describe('filterExplorerObjects', () => {
  const items = [
    item({ table: 'users' }),
    item({ table: 'user_roles', connectionId: 'c2', connectionName: 'prod', database: 'shop' }),
    item({ table: 'orders', kind: 'view' }),
    item({ table: 'audit_log', connectionName: 'warehouse' }),
  ];

  it('returns everything for an empty query', () => {
    assert.equal(filterExplorerObjects('', items).length, 4);
  });

  it('filters and ranks the best match first', () => {
    const hits = filterExplorerObjects('users', items);
    assert.equal(hits[0].table, 'users');
    assert.ok(hits.some((hit) => hit.table === 'user_roles'));
    assert.ok(hits.every((hit) => hit.table !== 'orders'));
  });

  it('breaks score ties alphabetically', () => {
    const hits = filterExplorerObjects('o', [item({ table: 'orders' }), item({ table: 'roles' })]);
    assert.deepEqual(hits.map((hit) => hit.table), ['orders', 'roles']);
  });
});

describe('explorerObjectItems', () => {
  it('flattens every profile into searchable items', async () => {
    const listTables = async (ref: { connectionId: string }) =>
      ref.connectionId === 'a'
        ? [
            { name: 'users', kind: 'table' as const },
            { name: 'v_users', kind: 'view' as const },
          ]
        : [{ name: 'logs', kind: 'table' as const }];
    const items = await explorerObjectItems(
      [
        { id: 'a', name: 'alpha', database: 'db1' },
        { id: 'b', name: 'beta', database: 'db2' },
      ],
      listTables,
    );
    assert.deepEqual(items.map((entry) => `${entry.database}.${entry.table}`), [
      'db1.users',
      'db1.v_users',
      'db2.logs',
    ]);
    assert.equal(items[1].kind, 'view');
  });

  it('skips profiles that fail to list instead of failing the whole search', async () => {
    const listTables = async (ref: { connectionId: string }) => {
      if (ref.connectionId === 'bad') {
        throw new Error('connection refused');
      }
      return [{ name: 'users', kind: 'table' as const }];
    };
    const items = await explorerObjectItems(
      [
        { id: 'bad', name: 'broken', database: 'db' },
        { id: 'good', name: 'healthy', database: 'db' },
      ],
      listTables,
    );
    assert.deepEqual(items.map((entry) => entry.connectionName), ['healthy']);
  });
});

describe('toQuickPickItem', () => {
  it('labels tables and views with the right icons and qualified description', () => {
    const table = toQuickPickItem(item());
    assert.match(table.label, /\$\(table\) users/);
    assert.equal(table.description, 'appdb.users');
    assert.equal(table.detail, 'local-docker');

    const view = toQuickPickItem(item({ table: 'v_users', kind: 'view' }));
    assert.match(view.label, /\$\(eye\)/);
  });

  it('surfaces comments in the detail line', () => {
    const withComment = toQuickPickItem(item({ comment: 'user accounts' }));
    assert.equal(withComment.detail, 'local-docker · user accounts');
  });
});

describe('folder labels', () => {
  it('renders the right-aligned count description', () => {
    assert.equal(folderCountLabel(12), '12');
    assert.equal(folderCountLabel(0), '0');
  });

  it('singularizes the folder tooltip for one object', () => {
    assert.equal(folderTooltip('Tables', 1), '1 table');
    assert.equal(folderTooltip('Tables', 12), '12 tables');
    assert.equal(folderTooltip('Functions', 1), '1 function');
  });
});
