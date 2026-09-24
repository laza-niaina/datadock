import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import { classifySqliteMessage, toSqliteError } from '../../src/db/drivers/sqlite/sqliteErrors';

function nodeError(code: string, message: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

describe('toSqliteError: node file errors', () => {
  it('maps a missing file to DATABASE_NOT_FOUND', () => {
    const error = toSqliteError(nodeError('ENOENT', "ENOENT: no such file or directory, open 'app.db'"));
    assert.equal(error.code, 'DATABASE_NOT_FOUND');
  });

  it('maps permission failures to PERMISSION_DENIED', () => {
    assert.equal(toSqliteError(nodeError('EACCES', 'permission denied')).code, 'PERMISSION_DENIED');
    assert.equal(toSqliteError(nodeError('EPERM', 'operation not permitted')).code, 'PERMISSION_DENIED');
  });

  it('maps path shape errors to CONFIG_ERROR', () => {
    assert.equal(toSqliteError(nodeError('EISDIR', 'illegal operation on a directory')).code, 'CONFIG_ERROR');
    assert.equal(
      toSqliteError(nodeError('ENOTDIR', 'not a directory')).code,
      'CONFIG_ERROR',
    );
  });
});

describe('toSqliteError: sqlite messages', () => {
  it('classifies the raw sqlite messages without a native code', () => {
    assert.equal(toSqliteError(new Error('file is not a database')).code, 'QUERY_ERROR');
    assert.equal(toSqliteError(new Error('malformed database schema (users)')).code, 'QUERY_ERROR');
    assert.equal(toSqliteError(new Error('out of memory')).code, 'QUERY_ERROR');
    assert.equal(toSqliteError(new Error('cannot enlarge memory')).code, 'QUERY_ERROR');
    assert.equal(toSqliteError(new Error('no such table: users')).code, 'QUERY_ERROR');
    assert.equal(toSqliteError(new Error('no such column: age')).code, 'QUERY_ERROR');
    assert.equal(toSqliteError(new Error('database is locked')).code, 'TIMEOUT');
  });

  it('keeps the original message', () => {
    const error = toSqliteError(new Error('file is not a database'));
    assert.equal(error.message, 'file is not a database');
  });

  it('falls back when nothing matches', () => {
    assert.equal(toSqliteError(new Error('totally unexpected'), 'QUERY_ERROR').code, 'QUERY_ERROR');
    assert.equal(toSqliteError(new Error('totally unexpected')).code, 'UNKNOWN');
  });

  it('passes a DbError through unchanged', () => {
    const original = new DbError('CANCELLED', 'The operation was cancelled.');
    assert.equal(toSqliteError(original), original);
  });
});

describe('classifySqliteMessage', () => {
  it('returns undefined for an unrelated message', () => {
    assert.equal(classifySqliteMessage('totally unexpected'), undefined);
  });
});
