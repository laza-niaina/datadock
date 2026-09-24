import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import { nativeMssqlNumber, toMssqlError } from '../../src/db/drivers/mssql/mssqlErrors';

/** Shapes an mssql/tedious error: `number` rides as an own property. */
function mssqlError(number: number | undefined, message: string): Error {
  return Object.assign(new Error(message), number === undefined ? {} : { number });
}

describe('nativeMssqlNumber', () => {
  it('only reads finite non-zero numeric numbers', () => {
    assert.equal(nativeMssqlNumber(mssqlError(18456, 'boom')), 18456);
    assert.equal(nativeMssqlNumber(mssqlError(0, 'boom')), undefined);
    assert.equal(nativeMssqlNumber(mssqlError(undefined, 'boom')), undefined);
    assert.equal(nativeMssqlNumber(Object.assign(new Error('boom'), { number: '18456' })), undefined);
    assert.equal(nativeMssqlNumber(new Error('boom')), undefined);
  });
});

describe('toMssqlError', () => {
  it('passes a DbError through unchanged', () => {
    const error = new DbError('CANCELLED', 'The operation was cancelled.');
    assert.equal(toMssqlError(error), error);
  });

  it('maps SQL Server error numbers to shared codes', () => {
    assert.equal(toMssqlError(mssqlError(18456, 'Login failed for user x'), 'UNKNOWN').code, 'AUTH_FAILED');
    assert.equal(toMssqlError(mssqlError(4060, 'Cannot open database "app"'), 'UNKNOWN').code, 'DATABASE_NOT_FOUND');
    assert.equal(toMssqlError(mssqlError(2627, 'Violation of PRIMARY KEY'), 'UNKNOWN').code, 'DUPLICATE_OBJECT');
    assert.equal(toMssqlError(mssqlError(2601, 'Cannot insert duplicate key'), 'UNKNOWN').code, 'DUPLICATE_OBJECT');
    assert.equal(toMssqlError(mssqlError(102, 'Incorrect syntax near "x"'), 'UNKNOWN').code, 'SYNTAX_ERROR');
    assert.equal(toMssqlError(mssqlError(229, 'The permission was denied'), 'UNKNOWN').code, 'PERMISSION_DENIED');
    assert.equal(toMssqlError(mssqlError(208, 'Invalid object name'), 'UNKNOWN').code, 'QUERY_ERROR');
    assert.equal(toMssqlError(mssqlError(207, 'Invalid column name'), 'UNKNOWN').code, 'QUERY_ERROR');
  });

  it('falls back on message text when no usable number is present', () => {
    assert.equal(toMssqlError(new Error('Login failed for user x'), 'UNKNOWN').code, 'AUTH_FAILED');
    assert.equal(toMssqlError(new Error('Cannot open database "app"'), 'UNKNOWN').code, 'DATABASE_NOT_FOUND');
    assert.equal(toMssqlError(new Error('Incorrect syntax near "x"'), 'UNKNOWN').code, 'SYNTAX_ERROR');
    assert.equal(toMssqlError(new Error('The permission was denied on the object'), 'UNKNOWN').code, 'PERMISSION_DENIED');
  });

  it('keeps the fallback when nothing matches', () => {
    assert.equal(toMssqlError(new Error('boom'), 'QUERY_ERROR').code, 'QUERY_ERROR');
    assert.equal(toMssqlError(new Error('boom')).code, 'UNKNOWN');
  });
});