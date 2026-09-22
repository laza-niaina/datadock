import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DriverFactory } from '../../src/db/driverRegistry';
import type { ConnectionProfile, DatabaseDriver, DriverCapabilities } from '../../src/db/types';
import { FILE_PATH_OPTION, applyFactoryDefaults, validateProfile } from '../../src/connections/validation';

const CAPABILITIES: DriverCapabilities = {
  schemas: false,
  multipleDatabases: true,
  views: true,
  routines: false,
  editableData: true,
  serverSidePagination: true,
  countRows: true,
  transactions: true,
  ssl: true,
  sshTunnel: true,
};

function serverFactory(): DriverFactory {
  return {
    engine: 'mysql',
    label: 'MySQL',
    status: 'stable',
    capabilities: CAPABILITIES,
    defaultPort: 3306,
    create: (): DatabaseDriver => {
      throw new Error('unused');
    },
  };
}

function fileFactory(): DriverFactory {
  return {
    engine: 'sqlite',
    label: 'SQLite',
    status: 'stable',
    capabilities: { ...CAPABILITIES, multipleDatabases: false, ssl: false, sshTunnel: false },
    fileBased: true,
    create: (): DatabaseDriver => {
      throw new Error('unused');
    },
  };
}

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Local MySQL',
    engine: 'mysql',
    host: 'localhost',
    port: 3306,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('validateProfile', () => {
  it('accepts a complete server profile', () => {
    assert.deepEqual(validateProfile(profile(), serverFactory()), []);
  });

  it('requires a name', () => {
    assert.deepEqual(validateProfile(profile({ name: '   ' }), serverFactory()), [
      'A connection name is required.',
    ]);
  });

  it('rejects an over-long name', () => {
    const problems = validateProfile(profile({ name: 'x'.repeat(201) }), serverFactory());
    assert.equal(problems.length, 1);
    assert.match(problems[0], /at most 200 characters/);
  });

  it('requires a host for a server engine', () => {
    assert.deepEqual(validateProfile(profile({ host: undefined }), serverFactory()), ['A host is required.']);
  });

  it('rejects out-of-range and non-numeric ports', () => {
    assert.match(String(validateProfile(profile({ port: 0 }), serverFactory())[0]), /between 1 and 65535/);
    assert.match(String(validateProfile(profile({ port: 70_000 }), serverFactory())[0]), /between 1 and 65535/);
    assert.match(
      String(validateProfile(profile({ port: 'not-a-port' as unknown as number }), serverFactory())[0]),
      /whole number/,
    );
  });

  it('allows a profile with no port (driver default applies)', () => {
    assert.deepEqual(validateProfile(profile({ port: undefined }), serverFactory()), []);
  });

  it('reports when no driver is installed for the engine', () => {
    assert.deepEqual(validateProfile(profile({ engine: 'redis' }), undefined), [
      "No driver is installed for engine 'redis'.",
    ]);
  });

  it('requires a file path for a file based engine', () => {
    const problems = validateProfile(profile({ engine: 'sqlite', host: undefined }), fileFactory());
    assert.deepEqual(problems, ['A database file path is required for this engine.']);
  });

  it('accepts a file based profile with a file path and ignores host/port', () => {
    const candidate = profile({
      engine: 'sqlite',
      host: undefined,
      port: undefined,
      options: { [FILE_PATH_OPTION]: 'C:/data/example.db' },
    });
    assert.deepEqual(validateProfile(candidate, fileFactory()), []);
  });

  it('validates the SSH section only when the tunnel is enabled', () => {
    const disabled = profile({
      ssh: { enabled: false, host: '', username: '' },
    });
    assert.deepEqual(validateProfile(disabled, serverFactory()), []);

    const enabled = profile({ ssh: { enabled: true, host: '', username: '' } });
    assert.deepEqual(validateProfile(enabled, serverFactory()), [
      'An SSH host is required when the tunnel is enabled.',
      'An SSH username is required when the tunnel is enabled.',
    ]);
  });

  it('validates SSH ports and the authentication method', () => {
    const candidate = profile({
      ssh: {
        enabled: true,
        host: 'bastion',
        username: 'ops',
        port: 99_999,
        remotePort: -1,
        authMethod: 'kerberos' as unknown as 'password',
      },
    });
    const problems = validateProfile(candidate, serverFactory());
    assert.equal(problems.length, 3);
    assert.ok(problems.some((problem) => problem.includes('SSH port')));
    assert.ok(problems.some((problem) => problem.includes('SSH remote port')));
    assert.ok(problems.some((problem) => problem.includes('Unsupported SSH authentication method')));
  });

  it('rejects a non-boolean read-only flag', () => {
    const candidate = profile({ readOnly: 'yes' as unknown as boolean });
    assert.deepEqual(validateProfile(candidate, serverFactory()), ['The read-only flag must be a boolean.']);
  });
});

describe('applyFactoryDefaults', () => {
  it('fills the default port for a server engine', () => {
    const result = applyFactoryDefaults({ ...profile(), port: undefined }, serverFactory());
    assert.equal(result.port, 3306);
  });

  it('never overrides a port the user already set', () => {
    const result = applyFactoryDefaults({ ...profile(), port: 13306 }, serverFactory());
    assert.equal(result.port, 13306);
  });

  it('drops the port for a file based engine', () => {
    const result = applyFactoryDefaults({ ...profile(), engine: 'sqlite', port: 3306 }, fileFactory());
    assert.equal(result.port, undefined);
  });

  it('returns the profile untouched when there is no factory', () => {
    const original = { ...profile(), port: undefined };
    assert.equal(applyFactoryDefaults(original, undefined), original);
  });
});
