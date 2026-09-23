/**
 * Pure resolution of a SQLite profile's database file path.
 *
 * The profile stores the path under `options.filePath` (see
 * `src/connections/validation.ts`); this module only normalises it. It stays
 * free of `fs`/`path` so `node --test` covers it without touching a disk.
 */

import { FILE_PATH_OPTION } from '../../../connections/validation';
import { DbError } from '../../errors';
import type { ConnectionProfile } from '../../types';

/** The one schema a SQLite file always has. */
export const DEFAULT_SQLITE_SCHEMA = 'main';

/** Expands a leading `~` (or `~\`, `~/`) to the given home directory. */
export function expandHome(filePath: string, homedir: string): string {
  if (filePath === '~') {
    return homedir;
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return `${homedir}${filePath.slice(1)}`;
  }
  return filePath;
}

/**
 * Returns the configured database file path.
 *
 * Blank input is a `CONFIG_ERROR`, not a crash later during `connect()`. The
 * returned path is *not* resolved against a working directory here — the driver
 * decides that, and the wizard's file picker always stores absolute paths.
 */
export function resolveSqlitePath(profile: ConnectionProfile, homedir: string): string {
  const raw = profile.options?.[FILE_PATH_OPTION];
  const filePath = typeof raw === 'string' ? raw.trim() : '';
  if (filePath === '') {
    throw new DbError('CONFIG_ERROR', 'A database file path is required for SQLite.');
  }
  return expandHome(filePath, homedir);
}

/** The pseudo-database name the explorer shows for a single-file engine. */
export function sqliteDatabaseLabel(profile: ConnectionProfile): string {
  const database = profile.database?.trim();
  return database === undefined || database === '' ? DEFAULT_SQLITE_SCHEMA : database;
}
