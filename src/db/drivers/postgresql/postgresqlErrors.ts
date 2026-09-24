/**
 * Translates node-postgres errors into `DbError`.
 *
 * PostgreSQL reports errors via SQLSTATE codes (e.g. `28P01` auth, `3D000`
 * missing database, `42601` syntax, `23505` duplicate key) that the shared
 * classifier in `src/db/errors.ts` already knows; this module only adds the
 * transport-level shapes node-postgres produces around them.
 */

import { DbError, toDbError, type DbErrorCode } from '../../errors';

export function toPostgresError(error: unknown, fallback: DbErrorCode = 'UNKNOWN'): DbError {
  // node-postgres keeps the native `code` and rethrows it on transport
  // failures too (ECONNREFUSED, ETIMEDOUT, ...), so the shared classifier
  // covers everything; this module exists to keep the call sites readable.
  return toDbError(error, fallback);
}