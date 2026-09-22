import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError, classifyNativeError, describeErrorCode } from '../../src/db/errors';

describe('DbError', () => {
  it('carries a code and keeps the cause', () => {
    const cause = new Error('socket hang up');
    const error = new DbError('CONNECTION_LOST', 'gone', cause);
    assert.equal(error.code, 'CONNECTION_LOST');
    assert.equal(error.message, 'gone');
    assert.equal(error.cause, cause);
  });

  it('returns the same instance when already a DbError', () => {
    const original = new DbError('TIMEOUT', 'slow');
    assert.equal(DbError.from(original), original);
  });

  it('wraps an unknown thrown value with a fallback code', () => {
    const wrapped = DbError.from('plain string failure', 'QUERY_ERROR');
    assert.equal(wrapped.code, 'QUERY_ERROR');
    assert.equal(wrapped.message, 'plain string failure');
  });

  it('wraps an Error instance preserving its message', () => {
    const wrapped = DbError.from(new Error('ECONNREFUSED'), 'CONNECTION_REFUSED');
    assert.equal(wrapped.message, 'ECONNREFUSED');
    assert.equal(wrapped.code, 'CONNECTION_REFUSED');
  });
});

describe('classifyNativeError', () => {
  const cases: Array<[string | number | undefined, string, string]> = [
    ['ER_ACCESS_DENIED_ERROR', 'Access denied for user', 'AUTH_FAILED'],
    ['28P01', 'password authentication failed', 'AUTH_FAILED'],
    ['ER_BAD_DB_ERROR', 'Unknown database', 'DATABASE_NOT_FOUND'],
    ['3D000', 'database does not exist', 'DATABASE_NOT_FOUND'],
    ['ECONNREFUSED', 'connect ECONNREFUSED', 'CONNECTION_REFUSED'],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND db', 'CONNECTION_REFUSED'],
    ['ETIMEDOUT', 'connect ETIMEDOUT', 'TIMEOUT'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate', 'TLS_ERROR'],
    ['ER_PARSE_ERROR', 'You have an error in your SQL syntax', 'SYNTAX_ERROR'],
    ['ER_DUP_ENTRY', 'Duplicate entry', 'DUPLICATE_OBJECT'],
    ['ER_TABLEACCESS_DENIED_ERROR', 'SELECT command denied', 'PERMISSION_DENIED'],
  ];

  for (const [code, message, expected] of cases) {
    it(`maps ${String(code)} to ${expected}`, () => {
      assert.equal(classifyNativeError(code, message), expected);
    });
  }

  it('falls back to message inspection when no code is provided', () => {
    assert.equal(classifyNativeError(undefined, 'connect ETIMEDOUT 10.0.0.1'), 'TIMEOUT');
    assert.equal(classifyNativeError(undefined, 'Access denied for user'), 'AUTH_FAILED');
  });

  it('reports UNKNOWN for an unrecognised failure', () => {
    assert.equal(classifyNativeError(undefined, 'something entirely unexpected'), 'UNKNOWN');
  });

  it('tolerates a numeric code', () => {
    assert.equal(classifyNativeError(2627, 'Violation of PRIMARY KEY constraint'), 'DUPLICATE_OBJECT');
  });
});

describe('describeErrorCode', () => {
  it('provides an actionable hint for known codes', () => {
    assert.match(describeErrorCode('AUTH_FAILED'), /credential/i);
    assert.match(describeErrorCode('CONNECTION_REFUSED'), /host, port/i);
    assert.match(describeErrorCode('UNSUPPORTED_OPERATION'), /does not support/i);
  });

  it('never returns an empty string', () => {
    const codes = ['CONFIG_ERROR', 'DRIVER_NOT_FOUND', 'DRIVER_NOT_IMPLEMENTED', 'UNKNOWN'] as const;
    for (const code of codes) {
      assert.notEqual(describeErrorCode(code).length, 0);
    }
  });
});
