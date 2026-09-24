import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CHARSET,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MYSQL_PORT,
  MAX_CONNECT_TIMEOUT_MS,
  buildMysqlConnectionOptions,
  charsetFrom,
  connectTimeoutFrom,
} from '../../src/db/drivers/mysql/mysqlConnectionOptions';
import type { ConnectionConfig, ConnectionProfile } from '../../src/db/types';

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'p1',
    name: 'p1',
    engine: 'mysql',
    host: ' db.example.com ',
    port: 3307,
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

describe('connectTimeoutFrom', () => {
  it('defaults to 10 seconds', () => {
    assert.equal(connectTimeoutFrom(profile()), DEFAULT_CONNECT_TIMEOUT_MS);
    assert.equal(connectTimeoutFrom(profile({ options: {} })), DEFAULT_CONNECT_TIMEOUT_MS);
  });

  it('reads options.connectTimeoutMs and clamps it', () => {
    assert.equal(connectTimeoutFrom(profile({ options: { connectTimeoutMs: 30_000 } })), 30_000);
    assert.equal(
      connectTimeoutFrom(profile({ options: { connectTimeoutMs: MAX_CONNECT_TIMEOUT_MS * 10 } })),
      MAX_CONNECT_TIMEOUT_MS,
    );
  });

  it('falls back on non-positive or non-numeric values', () => {
    assert.equal(connectTimeoutFrom(profile({ options: { connectTimeoutMs: 0 } })), DEFAULT_CONNECT_TIMEOUT_MS);
    assert.equal(connectTimeoutFrom(profile({ options: { connectTimeoutMs: -5 } })), DEFAULT_CONNECT_TIMEOUT_MS);
    assert.equal(connectTimeoutFrom(profile({ options: { connectTimeoutMs: 'abc' } })), DEFAULT_CONNECT_TIMEOUT_MS);
  });
});

describe('charsetFrom', () => {
  it('defaults to utf8mb4 and reads the override', () => {
    assert.equal(charsetFrom(profile()), DEFAULT_CHARSET);
    assert.equal(charsetFrom(profile({ options: { charset: 'latin1' } })), 'latin1');
    assert.equal(charsetFrom(profile({ options: { charset: '   ' } })), DEFAULT_CHARSET);
  });
});

describe('buildMysqlConnectionOptions', () => {
  it('builds the connection options from the profile and the secrets', () => {
    const options = buildMysqlConnectionOptions(config({}, 's3cret'), () => 'PEM');
    assert.equal(options.host, 'db.example.com');
    assert.equal(options.port, 3307);
    assert.equal(options.user, 'app');
    assert.equal(options.password, 's3cret');
    assert.equal(options.database, 'shop');
  });

  it('defaults the host and the port', () => {
    const options = buildMysqlConnectionOptions(config({ host: '  ', port: undefined }), () => 'PEM');
    assert.equal(options.host, '127.0.0.1');
    assert.equal(options.port, DEFAULT_MYSQL_PORT);
  });

  it('sends no database when the profile has none', () => {
    const options = buildMysqlConnectionOptions(config({ database: undefined }), () => 'PEM');
    assert.equal(options.database, undefined);
  });

  it('keeps the password out of the profile and in the secrets only', () => {
    const cfg = config({ user: 'app' }, 'pa55w0rd');
    assert.equal(cfg.profile.user, 'app');
    assert.equal(JSON.stringify(cfg.profile).includes('pa55w0rd'), false);
    const options = buildMysqlConnectionOptions(cfg, () => 'PEM');
    assert.equal(options.password, 'pa55w0rd');
  });

  it('enables the safety-first protocol defaults', () => {
    const options = buildMysqlConnectionOptions(config(), () => 'PEM');
    assert.equal(options.multipleStatements, false);
    assert.equal(options.namedPlaceholders, false);
    assert.equal(options.dateStrings, true);
    assert.equal(options.supportBigNumbers, true);
    assert.equal(options.bigNumberStrings, true);
    assert.equal(options.enableKeepAlive, true);
    assert.equal(options.charset, DEFAULT_CHARSET);
  });

  it('attaches SSL options only when SSL is enabled', () => {
    const off = buildMysqlConnectionOptions(config({ ssl: { enabled: false } }), () => 'PEM');
    assert.equal(off.ssl, undefined);

    const on = buildMysqlConnectionOptions(
      config({ ssl: { enabled: true, caFile: '/pki/ca.pem' } }),
      () => 'PEM',
    );
    assert.deepEqual(on.ssl, { rejectUnauthorized: true, ca: 'PEM' });
  });
});
