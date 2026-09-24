/**
 * Builds the `mssql` pool config from a `ConnectionConfig`.
 *
 * Pure (file contents arrive through the injected SSL reader), so the wizard's
 * decisions are unit-testable without a server and without a socket.
 */

import type { ConnectionConfig, ConnectionProfile } from '../../types';
import type { config as MssqlConfig } from 'mssql';
import { loadMssqlSsl, type SslFileReader } from './mssqlSsl';

export const DEFAULT_MSSQL_PORT = 1433;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const MAX_CONNECT_TIMEOUT_MS = 120_000;

/** Reads `options.connectTimeoutMs`, clamped to `[1, MAX_CONNECT_TIMEOUT_MS]`. */
export function connectTimeoutMsFrom(profile: ConnectionProfile): number {
  const raw = profile.options?.['connectTimeoutMs'];
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CONNECT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(parsed), MAX_CONNECT_TIMEOUT_MS);
}

/**
 * Builds the options object handed to `new ConnectionPool(config)`.
 *
 * `requestTimeout` is disabled (0): long SQL runs must stay cancellable by the
 * user instead of being auto-killed by the 15s mssql default. TLS follows the
 * shared `SslConfig`, and the pool is capped at one connection like the MySQL
 * driver, so a cancelled query cannot silently share a socket.
 */
export function buildMssqlConnectionOptions(
  config: ConnectionConfig,
  readFile: SslFileReader,
): MssqlConfig {
  const profile = config.profile;
  const ssl = loadMssqlSsl(profile.ssl, readFile);

  const mssqlConfig: MssqlConfig = {
    server: profile.host?.trim() || 'localhost',
    port: profile.port ?? DEFAULT_MSSQL_PORT,
    user: profile.user?.trim() || undefined,
    password: config.secrets.password ?? undefined,
    database: profile.database?.trim() || undefined,
    connectionTimeout: connectTimeoutMsFrom(profile),
    requestTimeout: 0,
    pool: {
      max: 1,
      min: 0,
      idleTimeoutMillis: 30_000,
    },
  };

  // TLS options only when the user asked for them; `encrypt: false` must still
  // reach tedious because its default would otherwise demand TLS.
  const options: NonNullable<MssqlConfig['options']> = {};
  options.encrypt = ssl.encrypt;
  options.trustServerCertificate = ssl.trustServerCertificate;
  if (ssl.cryptoCredentialsDetails) {
    options.cryptoCredentialsDetails = ssl.cryptoCredentialsDetails;
  }
  if (ssl.serverName) {
    options.serverName = ssl.serverName;
  }
  mssqlConfig.options = options;
  return mssqlConfig;
}