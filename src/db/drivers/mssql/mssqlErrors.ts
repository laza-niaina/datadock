/**
 * Translates `mssql`/tedious errors into `DbError`.
 *
 * SQL Server reports failures with an integer `number` (18456 login failed,
 * 4060 cannot open database, 2627/2601 duplicate key, 102 syntax, 229
 * permission) that the shared string-code classifier cannot see; this module
 * adds those overrides before falling back to the shared `toDbError` for
 * transport-level shapes (ECONNREFUSED, ETIMEDOUT, ...).
 */

import { DbError, toDbError, type DbErrorCode } from '../../errors';

/** SQL Server error numbers mapped to a shared `DbErrorCode`. */
const MSSQL_NUMBER_OVERRIDES: Readonly<Record<number, DbErrorCode>> = {
  18456: 'AUTH_FAILED', // Login failed for user 'x'.
  18461: 'AUTH_FAILED', // Login failed (account disabled / no mapping).
  18452: 'AUTH_FAILED', // Login failed (non-SQL authentication attempted).
  4060: 'DATABASE_NOT_FOUND', // Cannot open database "x" requested by the login.
  2627: 'DUPLICATE_OBJECT', // PRIMARY KEY violation.
  2601: 'DUPLICATE_OBJECT', // Unique index violation.
  102: 'SYNTAX_ERROR', // Incorrect syntax near 'x'.
  229: 'PERMISSION_DENIED', // The permission was denied on the object.
  208: 'QUERY_ERROR', // Invalid object name.
  207: 'QUERY_ERROR', // Invalid column name.
};

/** Reads the SQL Server error `number` (0 and null mean "no error number"). */
export function nativeMssqlNumber(error: unknown): number | undefined {
  const candidate = (error as { number?: unknown } | null | undefined)?.number;
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate !== 0
    ? candidate
    : undefined;
}

export function toMssqlError(error: unknown, fallback: DbErrorCode = 'UNKNOWN'): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);

  const number = nativeMssqlNumber(error);
  if (number !== undefined) {
    const byNumber = MSSQL_NUMBER_OVERRIDES[number];
    if (byNumber) {
      return new DbError(byNumber, message, error);
    }
  }

  // Message-level fallbacks for servers that report without a usable number
  // (older TDS drivers or proxies that rewrite the payload).
  if (/login failed/i.test(message)) {
    return new DbError('AUTH_FAILED', message, error);
  }
  if (/cannot open database/i.test(message)) {
    return new DbError('DATABASE_NOT_FOUND', message, error);
  }
  if (/incorrect syntax near/i.test(message)) {
    return new DbError('SYNTAX_ERROR', message, error);
  }
  if (/permission was denied|permission denied/i.test(message)) {
    return new DbError('PERMISSION_DENIED', message, error);
  }

  return toDbError(error, fallback);
}