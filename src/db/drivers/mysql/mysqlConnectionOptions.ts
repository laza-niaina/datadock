/**
 * Builds mysql2 connection options from a `ConnectionConfig`.
 *
 * Pure (file contents arrive through the injected SSL reader), so the wizard's
 * decisions are unit-testable without a server and without a socket. The
 * connection is deliberately conservative: no multi-statements, no named
 * placeholders, and numbers that could lose precision arrive as strings.
 */

import type { ConnectionOptions } from 'mysql2/promise';
import type { ConnectionConfig, ConnectionProfile } from '../../types';
import { loadMysqlSsl, type SslFileReader } from './mysqlSsl';

export const DEFAULT_MYSQL_PORT = 3306;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const MAX_CONNECT_TIMEOUT_MS = 120_000;
export const DEFAULT_CHARSET = 'utf8mb4';

/** Reads `options.connectTimeoutMs`, clamped to `[1, MAX_CONNECT_TIMEOUT_MS]`. */
export function connectTimeoutFrom(profile: ConnectionProfile): number {
  const raw = profile.options?.['connectTimeoutMs'];
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CONNECT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(parsed), MAX_CONNECT_TIMEOUT_MS);
}

/** Reads `options.charset`, falling back to `utf8mb4`. */
export function charsetFrom(profile: ConnectionProfile): string {
  const raw = profile.options?.['charset'];
  const charset = typeof raw === 'string' ? raw.trim() : '';
  return charset === '' ? DEFAULT_CHARSET : charset;
}

/**
 * Builds the options object handed to `mysql2/promise.createConnection`.
 *
 * `multipleStatements` stays off on purpose: the extension never lets one round
 * trip carry a statement batch, and a future SQL editor will split statements
 * client-side (matching `QueryExecutionResult.results[].statementIndex`).
 */
export function buildMysqlConnectionOptions(
  config: ConnectionConfig,
  readFile: SslFileReader,
): ConnectionOptions {
  const profile = config.profile;
  const database = profile.database?.trim();
  return {
    host: profile.host?.trim() || '127.0.0.1',
    port: profile.port ?? DEFAULT_MYSQL_PORT,
    user: profile.user,
    password: config.secrets.password,
    database: database === '' ? undefined : database,
    connectTimeout: connectTimeoutFrom(profile),
    charset: charsetFrom(profile),
    // Numbers first: text dates without timezone surprises, big integers as
    // strings so a BIGINT above 2^53 never silently loses precision.
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    enableKeepAlive: true,
    multipleStatements: false,
    namedPlaceholders: false,
    ssl: loadMysqlSsl(profile.ssl, readFile),
  };
}
