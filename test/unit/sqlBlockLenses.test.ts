import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBlockLensDescriptors, type SqlBlockInput } from '../../src/sql/sqlBlockLenses';
import { engineIcon, engineLabel } from '../../src/util/engineDisplay';

const blocks: SqlBlockInput[] = [
  { line: 0, start: 0, end: 9 },
  { line: 4, start: 34, end: 60 },
];

describe('SQL block CodeLens descriptors', () => {
  it('builds the full action bar per block when a connection is known', () => {
    const descriptors = buildBlockLensDescriptors(
      blocks,
      { connectionName: 'Local MariaDB', engine: 'mariadb', database: 'restaurant' },
      { uri: 'file:///app/seed.sql' },
    );
    assert.equal(descriptors.length, 8);
    const first = descriptors[0];
    assert.equal(first.line, 0);
    assert.equal(first.title, '$(run-all) Run all queries');
    assert.equal(first.command, 'dbclient.query.runAll');
    const second = descriptors[1];
    assert.deepEqual(second.arguments, ['file:///app/seed.sql', 0, 9]);
    assert.equal(second.command, 'dbclient.query.runStatement');
    assert.equal(descriptors[2].title, '$(database) Local MariaDB');
    assert.equal(descriptors[2].command, 'dbclient.query.selectConnection');
    const info = descriptors[3];
    assert.equal(info.line, 0);
    assert.equal(info.title, '$(server) MariaDB: restaurant');
    assert.equal(info.command, 'dbclient.query.selectDatabase');
    assert.deepEqual(info.arguments, ['file:///app/seed.sql']);
    // Second block reuses the same facts on its own line.
    assert.equal(descriptors[4].line, 4);
    assert.equal(descriptors[7].title, '$(server) MariaDB: restaurant');
  });

  it('shows "Connect" and hides the database lens when there is no connection', () => {
    const descriptors = buildBlockLensDescriptors(blocks, {}, { uri: 'file:///app/seed.sql' });
    assert.equal(descriptors.length, 6);
    assert.equal(descriptors[2].title, '$(database) Connect');
    assert.equal(descriptors[2].command, 'dbclient.query.selectConnection');
    assert.ok(!descriptors.some((descriptor) => descriptor.command === 'dbclient.query.selectDatabase'));
  });

  it('renders an engine / database lens even without a database override', () => {
    const descriptors = buildBlockLensDescriptors(
      [{ line: 2, start: 10, end: 20 }],
      { connectionName: 'Local MySQL', engine: 'mysql' },
      { uri: 'file:///app/seed.sql' },
    );
    assert.equal(descriptors[3].title, '$(server) MySQL');
  });

  it('returns nothing for an empty document', () => {
    assert.deepEqual(buildBlockLensDescriptors([], {}, { uri: 'file:///app/seed.sql' }), []);
  });
});

describe('engine display helpers', () => {
  it('labels engines readably', () => {
    assert.equal(engineLabel('mariadb'), 'MariaDB');
    assert.equal(engineLabel('mysql'), 'MySQL');
    assert.equal(engineLabel('sqlite'), 'SQLite');
    assert.equal(engineLabel('postgresql'), 'PostgreSQL');
  });

  it('picks icons by engine family', () => {
    assert.equal(engineIcon('mysql'), '$(server)');
    assert.equal(engineIcon('mariadb'), '$(server)');
    assert.equal(engineIcon('sqlite'), '$(file)');
  });
});