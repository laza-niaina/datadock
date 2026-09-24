import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import {
  classifyMysqlCode,
  isFatalMysqlError,
  mysqlNativeCode,
  toMysqlError,
} from '../../src/db/drivers/mysql/mysqlErrors';

/** Shapes a mysql2 error: `code`/`errno`/`fatal` ride as own properties. */
function mysqlError(fields: Record<string, unknown>, message = 'boom'): Error {
  return Object.assign(new Error(message), fields);
}

describe('classifyMysqlCode', () => {
  it('maps protocol drops and shutdowns to CONNECTION_LOST', () => {
    assert.equal(classifyMysqlCode('PROTOCOL_CONNECTION_LOST'), 'CONNECTION_LOST');
    assert.equal(classifyMysqlCode('PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'), 'CONNECTION_LOST');
    assert.equal(classifyMysqlCode('PROTOCOL_ENQUEUE_AFTER_QUIT'), 'CONNECTION_LOST');
    assert.equal(classifyMysqlCode('ER_SERVER_SHUTDOWN'), 'CONNECTION_LOST');
  });

  it('maps query shape errors to QUERY_ERROR', () => {
    assert.equal(classifyMysqlCode('ER_NO_SUCH_TABLE'), 'QUERY_ERROR');
    assert.equal(classifyMysqlCode('ER_BAD_FIELD_ERROR'), 'QUERY_ERROR');
  });

  it('maps access errors to PERMISSION_DENIED', () => {
    assert.equal(classifyMysqlCode('ER_SPECIFIC_ACCESS_DENIED_ERROR'), 'PERMISSION_DENIED');
    assert.equal(classifyMysqlCode('ER_HOST_NOT_PRIVILEGED'), 'PERMISSION_DENIED');
  });

  it('keeps the shared classifier for generic codes', () => {
    assert.equal(classifyMysqlCode('ER_ACCESS_DENIED_ERROR'), 'AUTH_FAILED');
    assert.equal(classifyMysqlCode('3D000'), 'DATABASE_NOT_FOUND');
    assert.equal(classifyMysqlCode('ER_DUP_ENTRY'), 'DUPLICATE_OBJECT');
    assert.equal(classifyMysqlCode('ETIMEDOUT'), 'TIMEOUT');
  });

  it('returns undefined for unknown or absent codes', () => {
    assert.equal(classifyMysqlCode(undefined), undefined);
    assert.equal(classifyMysqlCode('TOTALLY_UNKNOWN_CODE'), undefined);
  });
});

describe('toMysqlError', () => {
  it('passes a DbError through unchanged', () => {
    const error = new DbError('CANCELLED', 'The operation was cancelled.');
    assert.equal(toMysqlError(error), error);
  });

  it('translates an overridden mysql code and keeps the message', () => {
    const error = toMysqlError(mysqlError({ code: 'PROTOCOL_CONNECTION_LOST' }, 'The connection was lost.'));
    assert.equal(error.code, 'CONNECTION_LOST');
    assert.equal(error.message, 'The connection was lost.');
  });

  it('translates a full mysql2 authentication failure', () => {
    const error = toMysqlError(
      mysqlError(
        { errno: 1045, code: 'ER_ACCESS_DENIED_ERROR', sqlState: '28000' },
        "Access denied for user 'app'@'db.example.com' (using password: YES)",
      ),
    );
    assert.equal(error.code, 'AUTH_FAILED');
  });

  it('translates the sqlState for a missing database', () => {
    const error = toMysqlError(
      mysqlError({ errno: 1049, code: '3D000', sqlState: '3D000' }, 'Unknown database'),
    );
    assert.equal(error.code, 'DATABASE_NOT_FOUND');
  });

  it('keeps the fallback when nothing matches', () => {
    assert.equal(toMysqlError(new Error('boom'), 'QUERY_ERROR').code, 'QUERY_ERROR');
    assert.equal(toMysqlError(new Error('boom')).code, 'UNKNOWN');
  });

  it('treats a fatal error without a code as CONNECTION_LOST', () => {
    const error = toMysqlError(mysqlError({ fatal: true }, 'packets out of order'));
    assert.equal(error.code, 'CONNECTION_LOST');
  });

  it('does not let the fatal flag override a classified code', () => {
    const error = toMysqlError(
      mysqlError({ code: 'ER_NO_SUCH_TABLE', fatal: true }, "Table 'app.users' doesn't exist"),
    );
    assert.equal(error.code, 'QUERY_ERROR');
  });
});

describe('mysqlNativeCode / isFatalMysqlError', () => {
  it('only reads string codes and a literal fatal flag', () => {
    assert.equal(mysqlNativeCode(mysqlError({ code: 'ER_X' })), 'ER_X');
    assert.equal(mysqlNativeCode(mysqlError({ code: 1045 })), undefined);
    assert.equal(mysqlNativeCode(new Error('x')), undefined);
    assert.equal(isFatalMysqlError(mysqlError({ fatal: true })), true);
    assert.equal(isFatalMysqlError(mysqlError({ fatal: 'yes' })), false);
    assert.equal(isFatalMysqlError(new Error('x')), false);
  });
});
