/**
 * Translates mysql2 errors into `DbError`.
 *
 * The shared classifier in `src/db/errors.ts` already knows the generic MySQL
 * codes; this module only adds what that table lacks, so the mapping stays
 * consistent across engines.
 */

import { classifyNativeError, DbError, type DbErrorCode } from '../../errors';

/** mysql2 error codes the shared table does not cover. */
const MYSQL_CODE_OVERRIDES: Readonly<Record<string, DbErrorCode>> = {
  PROTOCOL_CONNECTION_LOST: 'CONNECTION_LOST',
  PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR: 'CONNECTION_LOST',
  PROTOCOL_ENQUEUE_AFTER_QUIT: 'CONNECTION_LOST',
  ER_SERVER_SHUTDOWN: 'CONNECTION_LOST',
  ER_NO_SUCH_TABLE: 'QUERY_ERROR',
  ER_BAD_FIELD_ERROR: 'QUERY_ERROR',
  ER_SPECIFIC_ACCESS_DENIED_ERROR: 'PERMISSION_DENIED',
  ER_HOST_NOT_PRIVILEGED: 'PERMISSION_DENIED',
};

export function mysqlNativeCode(error: unknown): string | undefined {
  const candidate = (error as { code?: unknown } | undefined)?.code;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** mysql2 marks protocol-level drops as fatal; a non-fatal error is a query issue. */
export function isFatalMysqlError(error: unknown): boolean {
  return (error as { fatal?: unknown } | undefined)?.fatal === true;
}

/**
 * Returns a `DbErrorCode` for a mysql2 error, or `undefined` when nothing matched.
 *
 * `errors.ts` is deliberately not modified by the driver milestone; this lookup
 * layers engine-specific codes on top of the shared classifier.
 */
export function classifyMysqlCode(code: string | undefined): DbErrorCode | undefined {
  if (!code) {
    return undefined;
  }
  const override = MYSQL_CODE_OVERRIDES[code];
  if (override) {
    return override;
  }
  const shared = classifyNativeError(code, code);
  return shared === 'UNKNOWN' ? undefined : shared;
}

/**
 * Normalises anything mysql2 can throw into a `DbError`.
 *
 * `fallback` is used when no code and no message pattern matches. A mysql2
 * error flagged `fatal` becomes `CONNECTION_LOST` rather than a generic failure,
 * because the session is genuinely gone at that point.
 */
export function toMysqlError(error: unknown, fallback: DbErrorCode = 'UNKNOWN'): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = mysqlNativeCode(error);

  const classified =
    classifyMysqlCode(code) ?? classifyNativeError(code, message) ?? 'UNKNOWN';

  if (classified === 'UNKNOWN' && isFatalMysqlError(error)) {
    return new DbError('CONNECTION_LOST', message, error);
  }
  return new DbError(classified === 'UNKNOWN' ? fallback : classified, message, error);
}
