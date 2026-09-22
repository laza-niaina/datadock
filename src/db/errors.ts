/**
 * Error model for the data layer.
 *
 * Drivers must translate native library errors into `DbError` so the UI can
 * present a useful, redacted message without leaking credentials.
 */

export type DbErrorCode =
  | 'CONFIG_ERROR'
  | 'DRIVER_NOT_FOUND'
  | 'DRIVER_NOT_IMPLEMENTED'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_LOST'
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'DATABASE_NOT_FOUND'
  | 'TLS_ERROR'
  | 'SSH_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'QUERY_ERROR'
  | 'SYNTAX_ERROR'
  | 'DUPLICATE_OBJECT'
  | 'UNSUPPORTED_OPERATION'
  | 'UNKNOWN';

export class DbError extends Error {
  readonly code: DbErrorCode;

  constructor(code: DbErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }

  static from(error: unknown, fallbackCode: DbErrorCode = 'UNKNOWN'): DbError {
    if (error instanceof DbError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new DbError(fallbackCode, message, error);
  }
}

/** Native error-code sets, kept deliberately small and easy to extend. */
const AUTH_CODES = new Set([
  'ER_ACCESS_DENIED_ERROR',
  'ER_ACCESS_DENIED_NO_PASSWORD_ERROR',
  'ER_DBACCESS_DENIED_ERROR',
  '28P01',
  '28000',
  'ELOGIN',
  'ER_NOT_SUPPORTED_AUTH_MODE',
]);

const DB_NOT_FOUND_CODES = new Set(['ER_BAD_DB_ERROR', '3D000', '42000']);

const TLS_CODES = new Set([
  'HANDSHAKE_SSL_ERROR',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
]);

const SOCKET_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EADDRNOTAVAIL']);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ESOCKETTIMEDOUT', 'ETIMEOUT']);

const SYNTAX_CODES = new Set(['ER_PARSE_ERROR', '42601', 'ER_SYNTAX_ERROR']);

const DUPLICATE_CODES = new Set(['ER_DUP_ENTRY', 'ER_DUP_KEYNAME', '23505', '2627', '2601']);

const PERMISSION_CODES = new Set(['ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', '42501', '42000']);

/**
 * Maps a native driver error onto a `DbErrorCode`.
 *
 * Drivers call this instead of duplicating the tables above, which keeps the
 * classification consistent across engines.
 */
export function classifyNativeError(code: string | number | undefined, message: string): DbErrorCode {
  const key = code === undefined ? '' : String(code).toUpperCase();
  if (key && AUTH_CODES.has(key)) return 'AUTH_FAILED';
  if (key && DB_NOT_FOUND_CODES.has(key)) return 'DATABASE_NOT_FOUND';
  if (key && TLS_CODES.has(key)) return 'TLS_ERROR';
  if (key && SOCKET_CODES.has(key)) return 'CONNECTION_REFUSED';
  if (key && TIMEOUT_CODES.has(key)) return 'TIMEOUT';
  if (key && SYNTAX_CODES.has(key)) return 'SYNTAX_ERROR';
  if (key && DUPLICATE_CODES.has(key)) return 'DUPLICATE_OBJECT';
  if (key && PERMISSION_CODES.has(key)) return 'PERMISSION_DENIED';

  const lowered = message.toLowerCase();
  if (lowered.includes('econnrefused') || lowered.includes('connect failed')) return 'CONNECTION_REFUSED';
  if (lowered.includes('access denied') || lowered.includes('authentication failed')) return 'AUTH_FAILED';
  if (lowered.includes('password authentication')) return 'AUTH_FAILED';
  if (lowered.includes('certificate') || lowered.includes('self signed')) return 'TLS_ERROR';
  if (lowered.includes('timed out') || lowered.includes('timeout')) return 'TIMEOUT';
  if (lowered.includes('unknown database') || lowered.includes('does not exist')) return 'DATABASE_NOT_FOUND';
  if (lowered.includes('syntax')) return 'SYNTAX_ERROR';
  if (lowered.includes('permission denied') || lowered.includes('insufficient privilege')) return 'PERMISSION_DENIED';
  if (lowered.includes('already exists') || lowered.includes('duplicate')) return 'DUPLICATE_OBJECT';
  if (lowered.includes('closed') || lowered.includes('connection lost')) return 'CONNECTION_LOST';
  return 'UNKNOWN';
}

/**
 * Normalises anything a driver can throw into a `DbError`.
 *
 * A driver is expected to throw `DbError` itself; when a third-party library
 * error escapes instead, its native `code` is classified so the UI still gets an
 * actionable hint rather than a generic failure.
 */
export function toDbError(error: unknown, fallback: DbErrorCode = 'UNKNOWN'): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const nativeCode = (error as { code?: string | number } | undefined)?.code;
  const classified = classifyNativeError(nativeCode, message);
  return new DbError(classified === 'UNKNOWN' ? fallback : classified, message, error);
}

/** Short, user-facing hint shown next to a connection failure. */
export function describeErrorCode(code: DbErrorCode): string {
  switch (code) {
    case 'AUTH_FAILED':
      return 'The server rejected the credentials.';
    case 'CONNECTION_REFUSED':
      return 'The host refused the connection. Check host, port and firewall.';
    case 'DATABASE_NOT_FOUND':
      return 'The requested database or schema does not exist.';
    case 'TLS_ERROR':
      return 'The TLS handshake failed. Check the SSL settings and certificate files.';
    case 'SSH_ERROR':
      return 'The SSH tunnel could not be established.';
    case 'TIMEOUT':
      return 'The operation timed out.';
    case 'CANCELLED':
      return 'The operation was cancelled.';
    case 'PERMISSION_DENIED':
      return 'The account lacks the required privileges.';
    case 'SYNTAX_ERROR':
      return 'The statement contains a syntax error.';
    case 'DUPLICATE_OBJECT':
      return 'The object already exists.';
    case 'UNSUPPORTED_OPERATION':
      return 'The driver does not support this operation.';
    case 'DRIVER_NOT_FOUND':
      return 'No driver is registered for this engine.';
    case 'DRIVER_NOT_IMPLEMENTED':
      return 'This engine is declared in the roadmap but has no implementation yet.';
    case 'CONFIG_ERROR':
      return 'The connection profile is incomplete or invalid.';
    default:
      return 'An unexpected error occurred.';
  }
}
