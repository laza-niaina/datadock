/**
 * Builds node-postgres `ClientConfig` from a `ConnectionConfig`.
 *
 * Pure (file contents arrive through the injected SSL reader), so the wizard's
 * decisions are unit-testable without a server and without a socket.
 */

import type { ClientConfig } from 'pg';
import type { ConnectionConfig, ConnectionProfile } from '../../types';
import { loadPostgresSsl, type SslFileReader } from './postgresqlSsl';

export const DEFAULT_POSTGRES_PORT = 5432;
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
 * Builds the options object handed to `new Client(config)`.
 *
 * The `ssl` key is omitted entirely when disabled (no TLS attempt), matching
 * both the MySQL driver and `psql` defaults. The connect timeout is clamped
 * like MySQL so a dead host cannot hang the wizard forever.
 */
export function buildPostgresConnectionOptions(
  config: ConnectionConfig,
  readFile: SslFileReader,
): ClientConfig {
  const profile = config.profile;
  const ssl = loadPostgresSsl(profile.ssl, readFile);

  const options: ClientConfig = {
    host: profile.host?.trim() || 'localhost',
    port: profile.port ?? DEFAULT_POSTGRES_PORT,
    user: profile.user?.trim() || undefined,
    password: config.secrets.password ?? undefined,
    database: profile.database?.trim() || undefined,
    connectionTimeoutMillis: connectTimeoutMsFrom(profile),
    application_name: 'DataDock',
  };
  if (ssl !== false) {
    options.ssl = ssl;
  }
  return options;
}