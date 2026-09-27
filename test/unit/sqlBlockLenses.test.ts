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
    // Two statements: three document lenses on the first block, one run lens
    // per statement, and nothing repeated above the second statement.
    assert.equal(descriptors.length, 5);
    const first = descriptors[0];
    assert.equal(first.line, 0);
    assert.equal(first.title, '$(run-all) Run all queries');
    assert.equal(first.command, 'dbclient.query.runAll');
    const connection = descriptors[1];
    assert.equal(connection.title, '$(database) : Local MariaDB');
    assert.equal(connection.command, 'dbclient.query.selectConnection');
    assert.deepEqual(connection.arguments, ['file:///app/seed.sql']);
    const info = descriptors[2];
    assert.equal(info.line, 0);
    assert.equal(info.title, '$(server) MariaDB : restaurant');
    assert.equal(info.command, 'dbclient.query.selectDatabase');
    assert.deepEqual(info.arguments, ['file:///app/seed.sql']);
    const run = descriptors[3];
    assert.equal(run.line, 0);
    assert.deepEqual(run.arguments, ['file:///app/seed.sql', 0, 9]);
    assert.equal(run.command, 'dbclient.query.runStatement');
    // The second block only gets its own run lens.
    assert.equal(descriptors.length - 1, 4);
    assert.equal(descriptors[4].line, 4);
    assert.equal(descriptors[4].command, 'dbclient.query.runStatement');
    assert.equal(
      descriptors.filter((d) => d.command === 'dbclient.query.runAll').length,
      1,
    );
  });

  it('shows "Connect" and hides the database lens when there is no connection', () => {
    const descriptors = buildBlockLensDescriptors(blocks, {}, { uri: 'file:///app/seed.sql' });
    assert.equal(descriptors.length, 4);
    assert.equal(descriptors[1].title, '$(database) Connect');
    assert.equal(descriptors[1].command, 'dbclient.query.selectConnection');
    assert.deepEqual(descriptors[1].arguments, ['file:///app/seed.sql']);
    assert.ok(!descriptors.some((descriptor) => descriptor.command === 'dbclient.query.selectDatabase'));
  });

  it('renders an engine / database lens with a Select DB placeholder when missing', () => {
    const descriptors = buildBlockLensDescriptors(
      [{ line: 2, start: 10, end: 20 }],
      { connectionName: 'Local MySQL', engine: 'mysql' },
      { uri: 'file:///app/seed.sql' },
    );
    // One block: run-all, connection, engine+database, then its own run lens.
    assert.equal(descriptors.length, 4);
    assert.equal(descriptors[2].title, '$(server) MySQL : Select DB');
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