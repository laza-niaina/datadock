import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_POSTGRES_PORT,
  MAX_CONNECT_TIMEOUT_MS,
  buildPostgresConnectionOptions,
  connectTimeoutMsFrom,
} from '../../src/db/drivers/postgresql/postgresqlConnectionOptions';
import { DbError } from '../../src/db/errors';
import type { ConnectionConfig, ConnectionProfile } from '../../src/db/types';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p1',
    name: 'p1',
    engine: 'postgresql',
    host: ' db.example.com ',
    port: 5433,
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
    assert.equal(connectTimeoutMsFrom(profile({ options: { connectTimeoutMs: 20_000 } })), 20_000);
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

describe('buildPostgresConnectionOptions', () => {
  it('builds the pg options from the profile and the secrets', () => {
    const options = buildPostgresConnectionOptions(config({}, 's3cret'), () => 'PEM');
    assert.equal(options.host, 'db.example.com');
    assert.equal(options.port, 5433);
    assert.equal(options.user, 'app');
    assert.equal(options.password, 's3cret');
    assert.equal(options.database, 'shop');
  });

  it('defaults the host and the port', () => {
    const options = buildPostgresConnectionOptions(config({ host: '  ', port: undefined }), () => 'PEM');
    assert.equal(options.host, 'localhost');
    assert.equal(options.port, DEFAULT_POSTGRES_PORT);
  });

  it('sends no database when the profile has none', () => {
    const options = buildPostgresConnectionOptions(config({ database: undefined }), () => 'PEM');
    assert.equal(options.database, undefined);
  });

  it('keeps the password out of the profile and in the secrets only', () => {
    const cfg = config({ user: 'app' }, 'pa55w0rd');
    assert.equal(JSON.stringify(cfg.profile).includes('pa55w0rd'), false);
    const options = buildPostgresConnectionOptions(cfg, () => 'PEM');
    assert.equal(options.password, 'pa55w0rd');
  });

  it('sets a sane application name and timeout by default', () => {
    const options = buildPostgresConnectionOptions(config(), () => 'PEM');
    assert.equal(options.application_name, 'DataDock');
    assert.equal(options.connectionTimeoutMillis, DEFAULT_CONNECT_TIMEOUT_MS);
  });

  it('omits the ssl key entirely when SSL is disabled', () => {
    const options = buildPostgresConnectionOptions(config({ ssl: { enabled: false } }), () => 'PEM');
    assert.equal(options.ssl, undefined);
  });

  it('demands certificate validation by default and honours verify: false', () => {
    const on = buildPostgresConnectionOptions(config({ ssl: { enabled: true } }), () => 'PEM');
    assert.deepEqual(on.ssl, { rejectUnauthorized: true });

    const loose = buildPostgresConnectionOptions(
      config({ ssl: { enabled: true, verify: false } }),
      () => 'PEM',
    );
    assert.deepEqual(loose.ssl, { rejectUnauthorized: false });
  });

  it('attaches CA, client cert and key contents read through the injected reader', () => {
    const options = buildPostgresConnectionOptions(
      config({ ssl: { enabled: true, caFile: '/pki/ca.pem', certFile: '/pki/cert.pem', keyFile: '/pki/key.pem' } }),
      (_filePath) => 'PEM',
    );
    assert.equal((options.ssl as { ca?: string }).ca, 'PEM');
    assert.equal((options.ssl as { cert?: string }).cert, 'PEM');
    assert.equal((options.ssl as { key?: string }).key, 'PEM');
  });

  it('passes an SNI override through as servername', () => {
    const options = buildPostgresConnectionOptions(
      config({ ssl: { enabled: true, serverName: 'db.internal' } }),
      () => 'PEM',
    );
    assert.equal((options.ssl as { servername?: string }).servername, 'db.internal');
  });

  it('wraps unreadable certificate files in a TLS_ERROR', () => {
    assert.throws(
      () => buildPostgresConnectionOptions(config({ ssl: { enabled: true, caFile: '/missing.pem' } }), () => {
        throw new Error('ENOENT');
      }),
      (error: unknown) => error instanceof DbError && error.code === 'TLS_ERROR',
    );
  });
});