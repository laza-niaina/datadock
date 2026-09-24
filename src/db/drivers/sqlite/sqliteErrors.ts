/**
 * Translation of SQLite (sql.js) failures into `DbError`.
 *
 * sql.js throws plain `Error`s with native SQLite messages, and file access
 * fails with Node error codes, so classification runs code-first and then falls
 * back to message sniffing.
 */

import { classifyNativeError, DbError, type DbErrorCode } from '../../errors';

const NODE_CODE_OVERRIDES: Readonly<Record<string, DbErrorCode>> = {
  ENOENT: 'DATABASE_NOT_FOUND',
  EACCES: 'PERMISSION_DENIED',
  EPERM: 'PERMISSION_DENIED',
  EISDIR: 'CONFIG_ERROR',
  ENOTDIR: 'CONFIG_ERROR',
};

/** Message-based classification for the errors sql.js raises without a code. */
export function classifySqliteMessage(message: string): DbErrorCode | undefined {
  const lowered = message.toLowerCase();
  if (lowered.includes('file is not a database') || lowered.includes('malformed')) {
    return 'QUERY_ERROR';
  }
  if (lowered.includes('out of memory') || lowered.includes('cannot enlarge memory')) {
    return 'QUERY_ERROR';
  }
  if (lowered.includes('no such table') || lowered.includes('no such column')) {
    return 'QUERY_ERROR';
  }
  if (lowered.includes('database is locked')) {
    return 'TIMEOUT';
  }
  return undefined;
}

export function toSqliteError(error: unknown, fallback: DbErrorCode = 'UNKNOWN'): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = (error as { code?: unknown } | undefined)?.code;
  const code = typeof nativeCode === 'string' ? nativeCode : undefined;

  // `classifyNativeError` returns 'UNKNOWN' — not undefined — when nothing
  // matched, which must not short-circuit the message and fallback stages.
  const shared = classifyNativeError(code, message);
  const classified =
    (code !== undefined ? NODE_CODE_OVERRIDES[code] : undefined) ??
    (shared === 'UNKNOWN' ? undefined : shared) ??
    classifySqliteMessage(message) ??
    fallback;

  return new DbError(classified, message, error);
}
