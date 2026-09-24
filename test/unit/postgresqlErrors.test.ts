import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import { toPostgresError } from '../../src/db/drivers/postgresql/postgresqlErrors';

/** Shapes a node-postgres error: `code` (SQLSTATE or system code) rides as an own property. */
function pgError(code: string | undefined, message: string): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe('toPostgresError', () => {
  it('passes a DbError through unchanged', () => {
    const error = new DbError('CANCELLED', 'The operation was cancelled.');
    assert.equal(toPostgresError(error, 'QUERY_ERROR'), error);
  });

  it('classifies SQLSTATE auth failures', () => {
    const error = toPostgresError(pgError('28P01', 'password authentication failed for user "app"'), 'UNKNOWN');
    assert.equal(error.code, 'AUTH_FAILED');
  });

  it('classifies SQLSTATE missing-database failures', () => {
    const error = toPostgresError(pgError('3D000', 'database "nope" does not exist'), 'UNKNOWN');
    assert.equal(error.code, 'DATABASE_NOT_FOUND');
  });

  it('classifies SQLSTATE syntax and duplicate-key failures', () => {
    assert.equal(toPostgresError(pgError('42601', 'syntax error at end of input'), 'UNKNOWN').code, 'SYNTAX_ERROR');
    assert.equal(toPostgresError(pgError('23505', 'duplicate key value'), 'UNKNOWN').code, 'DUPLICATE_OBJECT');
  });

  it('classifies transport failures from the system code', () => {
    assert.equal(toPostgresError(pgError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'), 'UNKNOWN').code, 'CONNECTION_REFUSED');
    assert.equal(toPostgresError(pgError('ETIMEDOUT', 'connect ETIMEDOUT'), 'UNKNOWN').code, 'TIMEOUT');
  });

  it('keeps the fallback when nothing matches', () => {
    assert.equal(toPostgresError(pgError(undefined, 'boom'), 'QUERY_ERROR').code, 'QUERY_ERROR');
    assert.equal(toPostgresError(pgError(undefined, 'boom')).code, 'UNKNOWN');
  });
});