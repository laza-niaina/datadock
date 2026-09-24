import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sqlStatusLabels } from '../../src/util/engineDisplay';

describe('sqlStatusLabels', () => {
  it('shows only the Connect entry point when the file has no connection', () => {
    assert.deepEqual(sqlStatusLabels({}), {
      connection: '$(database) Connect',
    });
  });

  it('renders the connection item with the exact separator when connected', () => {
    assert.deepEqual(sqlStatusLabels({ connectionName: 'Local MariaDB' }), {
      connection: '$(database) : Local MariaDB',
    });
  });

  it('shows a Select DB placeholder while the connection has no database', () => {
    assert.deepEqual(sqlStatusLabels({ connectionName: 'Local MariaDB', engine: 'mariadb' }), {
      connection: '$(database) : Local MariaDB',
      database: '$(server) MariaDB : Select DB',
    });
  });

  it('renders the full per-file context as one visual unit', () => {
    assert.deepEqual(sqlStatusLabels({ connectionName: 'Local MariaDB', engine: 'mariadb', database: 'learn' }), {
      connection: '$(database) : Local MariaDB',
      database: '$(server) MariaDB : learn',
    });
  });

  it('uses the engine icon and label per driver', () => {
    assert.deepEqual(sqlStatusLabels({ connectionName: 'MySQL Local', engine: 'mysql', database: 'ecommerce' }), {
      connection: '$(database) : MySQL Local',
      database: '$(server) MySQL : ecommerce',
    });
    assert.deepEqual(sqlStatusLabels({ connectionName: 'SQLite Local', engine: 'sqlite', database: 'application.db' }), {
      connection: '$(database) : SQLite Local',
      database: '$(file) SQLite : application.db',
    });
  });
});