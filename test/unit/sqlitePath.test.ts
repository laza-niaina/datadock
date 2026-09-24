import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import {
  DEFAULT_SQLITE_SCHEMA,
  expandHome,
  resolveSqlitePath,
  sqliteDatabaseLabel,
} from '../../src/db/drivers/sqlite/sqlitePath';
import type { ConnectionProfile } from '../../src/db/types';

function profile(filePath?: unknown, database?: string): ConnectionProfile {
  return {
    id: 'p1',
    name: 'p1',
    engine: 'sqlite',
    database,
    options: filePath === undefined ? undefined : { filePath },
    createdAt: 0,
    updatedAt: 0,
  };
}

const HOME = '/home/tester';

function isConfigError(error: unknown): boolean {
  return error instanceof DbError && error.code === 'CONFIG_ERROR';
}

describe('resolveSqlitePath', () => {
  it('rejects a missing, blank or non-string file path', () => {
    assert.throws(() => resolveSqlitePath(profile(), HOME), isConfigError);
    assert.throws(() => resolveSqlitePath(profile(''), HOME), isConfigError);
    assert.throws(() => resolveSqlitePath(profile('   '), HOME), isConfigError);
    assert.throws(() => resolveSqlitePath(profile(123), HOME), isConfigError);
  });

  it('trims the configured path', () => {
    assert.equal(resolveSqlitePath(profile('  C:\\data\\app.db  '), HOME), 'C:\\data\\app.db');
  });

  it('expands the home directory shortcuts', () => {
    assert.equal(resolveSqlitePath(profile('~'), HOME), HOME);
    assert.equal(resolveSqlitePath(profile('~/data/app.db'), HOME), `${HOME}/data/app.db`);
    assert.equal(resolveSqlitePath(profile('~\\data\\app.db'), HOME), `${HOME}\\data\\app.db`);
  });

  it('leaves other paths and ~other prefixes untouched', () => {
    assert.equal(resolveSqlitePath(profile('app.db'), HOME), 'app.db');
    assert.equal(resolveSqlitePath(profile('~other/data/app.db'), HOME), '~other/data/app.db');
  });
});

describe('expandHome', () => {
  it('only expands a standalone tilde or a tilde followed by a separator', () => {
    assert.equal(expandHome('~', HOME), HOME);
    assert.equal(expandHome('~/x.db', HOME), `${HOME}/x.db`);
    assert.equal(expandHome('~\\x.db', HOME), `${HOME}\\x.db`);
    assert.equal(expandHome('~other/x.db', HOME), '~other/x.db');
    assert.equal(expandHome('/abs/x.db', HOME), '/abs/x.db');
  });
});

describe('sqliteDatabaseLabel', () => {
  it('uses the configured database name, trimmed', () => {
    assert.equal(sqliteDatabaseLabel(profile('x.db', ' shop ')), 'shop');
  });

  it('falls back to the default schema when absent or blank', () => {
    assert.equal(sqliteDatabaseLabel(profile('x.db')), DEFAULT_SQLITE_SCHEMA);
    assert.equal(sqliteDatabaseLabel(profile('x.db', '   ')), DEFAULT_SQLITE_SCHEMA);
  });
});
