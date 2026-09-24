import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MSSQL_PORT,
  MAX_CONNECT_TIMEOUT_MS,
  buildMssqlConnectionOptions,
  connectTimeoutMsFrom,
} from '../../src/db/drivers/mssql/mssqlConnectionOptions';
import { DbError } from '../../src/db/errors';
import type { ConnectionConfig, ConnectionProfile } from '../../src/db/types';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p1',
    name: 'p1',
    engine: 'mssql',
    host: ' db.example.com ',
    port: 1434,
    user: 'app',
    database: ' shop ',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function config(overrides: Partial<ConnectionProfile> = {}, password?: string): ConnectionConfig {
  return { profile: profile(overrides), secrets: { password } };
}

describe('connectTimeoutMsFrom', () => {
  it('defaults to 10 seconds', () => {
    assert.equal(connectTimeoutMsFrom(profile()), DEFAULT_CONNECT_TIMEOUT_MS);
    assert.equal(connectTimeoutMsFrom(profile({ options: {} })), DEFAULT_CONNECT_TIMEOUT_MS);
  });

  it('reads options.connectTimeoutMs and clamps it', () => {
    assert.equal(connectTimeoutMsFrom(profile({ options: { connectTimeoutMs: 15_000 } })), 15_000);
    assert.equal(
      connectTimeoutMsFrom(profile({ options: { connectTimeoutMs: MAX_CONNECT_TIMEOUT_MS * 5 } })),
      MAX_CONNECT_TIMEOUT_MS,
    );
  });

  it('falls back on non-positive or non-numeric values', () => {
    assert.equal(connectTimeoutMsFrom(profile({ options: { connectTimeoutMs: 0 } })), DEFAULT_CONNECT_TIMEOUT_MS);
    assert.equal(connectTimeoutMsFrom(profile({ options: { connectTimeoutMs: -3 } })), DEFAULT_CONNECT_TIMEOUT_MS);
    assert.equal(connectTimeoutMsFrom(profile({ options: { connectTimeoutMs: 'nope' } })), DEFAULT_CONNECT_TIMEOUT_MS);
  });
});

describe('buildMssqlConnectionOptions', () => {
  it('builds the mssql config from the profile and the secrets', () => {
    const options = buildMssqlConnectionOptions(config({}, 's3cret'), () => 'PEM');
    assert.equal(options.server, 'db.example.com');
    assert.equal(options.port, 1434);
    assert.equal(options.user, 'app');
    assert.equal(options.password, 's3cret');
    assert.equal(options.database, 'shop');
  });

  it('defaults the server and the port', () => {
    const options = buildMssqlConnectionOptions(config({ host: '  ', port: undefined }), () => 'PEM');
    assert.equal(options.server, 'localhost');
    assert.equal(options.port, DEFAULT_MSSQL_PORT);
  });

  it('sends no database when the profile has none', () => {
    const options = buildMssqlConnectionOptions(config({ database: undefined }), () => 'PEM');
    assert.equal(options.database, undefined);
  });

  it('keeps the password out of the profile and in the secrets only', () => {
    const cfg = config({ user: 'app' }, 'pa55w0rd');
    assert.equal(JSON.stringify(cfg.profile).includes('pa55w0rd'), false);
    const options = buildMssqlConnectionOptions(cfg, () => 'PEM');
    assert.equal(options.password, 'pa55w0rd');
  });

  it('keeps requests cancellable instead of auto-killed, on a single-socket pool', () => {
    const options = buildMssqlConnectionOptions(config(), () => 'PEM');
    assert.equal(options.requestTimeout, 0, 'long queries stay cancellable by the user');
    assert.equal(options.pool?.max, 1, 'one socket so a cancelled query cannot silently share');
  });

  it('maps SSL disabled to encrypt: false (tedious would otherwise demand TLS)', () => {
    const options = buildMssqlConnectionOptions(config({ ssl: { enabled: false } }), () => 'PEM');
    assert.equal(options.options?.encrypt, false);
    assert.equal(options.options?.trustServerCertificate, false);
    assert.equal(options.options?.cryptoCredentialsDetails, undefined);
  });

  it('demands TLS and validates the certificate when SSL is enabled', () => {
    const options = buildMssqlConnectionOptions(config({ ssl: { enabled: true } }), () => 'PEM');
    assert.equal(options.options?.encrypt, true);
    assert.equal(options.options?.trustServerCertificate, false);
  });

  it('skips certificate validation with verify: false', () => {
    const options = buildMssqlConnectionOptions(config({ ssl: { enabled: true, verify: false } }), () => 'PEM');
    assert.equal(options.options?.encrypt, true);
    assert.equal(options.options?.trustServerCertificate, true);
  });

  it('attaches CA, client cert and key as PEM buffers', () => {
    const options = buildMssqlConnectionOptions(
      config({ ssl: { enabled: true, caFile: '/pki/ca.pem', certFile: '/pki/cert.pem', keyFile: '/pki/key.pem' } }),
      (_filePath) => 'PEM',
    );
    assert.deepEqual(options.options?.cryptoCredentialsDetails, {
      ca: Buffer.from('PEM', 'utf8'),
      cert: Buffer.from('PEM', 'utf8'),
      key: Buffer.from('PEM', 'utf8'),
    });
  });

  it('passes an SNI override through as servername', () => {
    const options = buildMssqlConnectionOptions(
      config({ ssl: { enabled: true, serverName: 'db.internal' } }),
      () => 'PEM',
    );
    assert.equal(options.options?.serverName, 'db.internal');
  });

  it('wraps unreadable certificate files in a TLS_ERROR', () => {
    assert.throws(
      () => buildMssqlConnectionOptions(config({ ssl: { enabled: true, caFile: '/missing.pem' } }), () => {
        throw new Error('ENOENT');
      }),
      (error: unknown) => error instanceof DbError && error.code === 'TLS_ERROR',
    );
  });
});