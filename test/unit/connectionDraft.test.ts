import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DriverFactory } from '../../src/db/driverRegistry';
import type { ConnectionProfile, DatabaseDriver, DriverCapabilities } from '../../src/db/types';
import { FILE_PATH_OPTION } from '../../src/connections/validation';
import {
  draftFromProfile,
  emptyDraft,
  emptySecretPresence,
  profileFromDraft,
  secretsFromDraft,
} from '../../src/ui/connectionDraft';

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

const MYSQL: DriverFactory = {
  engine: 'mysql',
  label: 'MySQL',
  status: 'stable',
  capabilities: CAPABILITIES,
  defaultPort: 3306,
  create: (): DatabaseDriver => {
    throw new Error('unused');
  },
};

const SQLITE: DriverFactory = {
  engine: 'sqlite',
  label: 'SQLite',
  status: 'stable',
  capabilities: { ...CAPABILITIES, multipleDatabases: false, ssl: false, sshTunnel: false },
  fileBased: true,
  create: (): DatabaseDriver => {
    throw new Error('unused');
  },
};

const BASE: ConnectionProfile = {
  id: 'profile-1',
  name: 'Local',
  engine: 'mysql',
  host: 'localhost',
  port: 3306,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

describe('draftFromProfile', () => {
  it('exposes every field as a string or boolean', () => {
    const draft = draftFromProfile(BASE);
    assert.equal(draft.name, 'Local');
    assert.equal(draft.engine, 'mysql');
    assert.equal(draft.host, 'localhost');
    assert.equal(draft.port, '3306');
    assert.equal(draft.readOnly, false);
    assert.equal(draft.sslEnabled, false);
    assert.equal(draft.sshEnabled, false);
  });

  it('never carries a stored secret', () => {
    const draft = draftFromProfile(BASE);
    assert.equal(draft.password, '');
    assert.equal(draft.sshPassword, '');
    assert.equal(draft.sshPrivateKey, '');
    assert.equal(draft.sshPassphrase, '');
  });

  it('reads the file path out of engine options', () => {
    const draft = draftFromProfile({ ...BASE, options: { [FILE_PATH_OPTION]: 'C:/a.db' } });
    assert.equal(draft.filePath, 'C:/a.db');
  });

  it('defaults SSL verification to on', () => {
    assert.equal(draftFromProfile({ ...BASE, ssl: { enabled: true } }).sslVerify, true);
    assert.equal(draftFromProfile({ ...BASE, ssl: { enabled: true, verify: false } }).sslVerify, false);
  });

  it('defaults the SSH authentication method to password', () => {
    const draft = draftFromProfile({ ...BASE, ssh: { enabled: true, host: 'b', username: 'u' } });
    assert.equal(draft.sshAuthMethod, 'password');
  });
});

describe('emptyDraft', () => {
  it('pre-fills the engine defaults', () => {
    const draft = emptyDraft('profile-9', 'mysql', MYSQL);
    assert.equal(draft.id, 'profile-9');
    assert.equal(draft.engine, 'mysql');
    assert.equal(draft.port, '3306');
    assert.match(draft.name, /New MySQL Connection/);
  });

  it('leaves a file engine without a port', () => {
    assert.equal(emptyDraft('profile-9', 'sqlite', SQLITE).port, '');
  });
});

describe('profileFromDraft', () => {
  it('round-trips a server profile', () => {
    const draft = draftFromProfile({ ...BASE, user: 'root', database: 'app', schema: 'public' });
    const profile = profileFromDraft(draft, BASE);

    assert.equal(profile.id, BASE.id);
    assert.equal(profile.name, 'Local');
    assert.equal(profile.host, 'localhost');
    assert.equal(profile.port, 3306);
    assert.equal(profile.user, 'root');
    assert.equal(profile.database, 'app');
    assert.equal(profile.schema, 'public');
    assert.equal(profile.createdAt, BASE.createdAt);
  });

  it('turns empty text into undefined rather than empty strings', () => {
    const profile = profileFromDraft({ ...draftFromProfile(BASE), host: '', user: '   ', port: '' }, BASE);
    assert.equal(profile.host, undefined);
    assert.equal(profile.user, undefined);
    assert.equal(profile.port, undefined);
  });

  it('stores the file path in options and removes it when emptied', () => {
    const withFile = profileFromDraft({ ...draftFromProfile(BASE), filePath: ' C:/a.db ' }, BASE);
    assert.equal(withFile.options?.[FILE_PATH_OPTION], 'C:/a.db');

    const withoutFile = profileFromDraft({ ...draftFromProfile(withFile), filePath: '' }, withFile);
    assert.equal(withoutFile.options?.[FILE_PATH_OPTION], undefined);
  });

  it('preserves driver-specific options it does not manage', () => {
    const base: ConnectionProfile = { ...BASE, options: { customFlag: true } };
    const profile = profileFromDraft({ ...draftFromProfile(base), filePath: '' }, base);
    assert.equal(profile.options?.customFlag, true);
  });

  it('keeps SSL settings when the section is switched off', () => {
    const enabled = profileFromDraft(
      { ...draftFromProfile(BASE), sslEnabled: true, sslCaFile: 'ca.pem', sslVerify: false },
      BASE,
    );
    assert.equal(enabled.ssl?.enabled, true);
    assert.equal(enabled.ssl?.verify, false);
    assert.equal(enabled.ssl?.caFile, 'ca.pem');

    const disabled = profileFromDraft({ ...draftFromProfile(enabled), sslEnabled: false }, enabled);
    assert.equal(disabled.ssl?.enabled, false);
    assert.equal(disabled.ssl?.caFile, 'ca.pem', 'turning SSL off must not erase the file paths');
  });

  it('drops the SSL block entirely when nothing was ever entered', () => {
    assert.equal(profileFromDraft(draftFromProfile(BASE), BASE).ssl, undefined);
  });

  it('keeps SSH settings when the tunnel is switched off', () => {
    const enabled = profileFromDraft(
      {
        ...draftFromProfile(BASE),
        sshEnabled: true,
        sshHost: 'bastion',
        sshUser: 'ops',
        sshAuthMethod: 'privateKey',
        sshPrivateKeyPath: '~/.ssh/id_ed25519',
        sshRemoteHost: '127.0.0.1',
        sshRemotePort: '3306',
      },
      BASE,
    );

    assert.equal(enabled.ssh?.enabled, true);
    assert.equal(enabled.ssh?.host, 'bastion');
    assert.equal(enabled.ssh?.username, 'ops');
    assert.equal(enabled.ssh?.authMethod, 'privateKey');
    assert.equal(enabled.ssh?.privateKeyPath, '~/.ssh/id_ed25519');
    assert.equal(enabled.ssh?.remoteHost, '127.0.0.1');
    assert.equal(enabled.ssh?.remotePort, 3306);

    const disabled = profileFromDraft({ ...draftFromProfile(enabled), sshEnabled: false }, enabled);
    assert.equal(disabled.ssh?.enabled, false);
    assert.equal(disabled.ssh?.host, 'bastion', 'turning the tunnel off must not erase the settings');
  });

  it('drops the SSH block entirely when nothing was ever entered', () => {
    assert.equal(profileFromDraft(draftFromProfile(BASE), BASE).ssh, undefined);
  });

  it('carries the read-only flag', () => {
    assert.equal(profileFromDraft({ ...draftFromProfile(BASE), readOnly: true }, BASE).readOnly, true);
  });
});

describe('secretsFromDraft', () => {
  it('collects values the user typed', () => {
    const update = secretsFromDraft({
      ...draftFromProfile(BASE),
      password: 'pa55w0rd',
      sshPassword: 'ssh-pass',
    });

    assert.deepEqual(update.set, { password: 'pa55w0rd', sshPassword: 'ssh-pass' });
    assert.deepEqual(update.clear, []);
  });

  it('treats an empty box as "leave the stored value alone"', () => {
    const update = secretsFromDraft(draftFromProfile(BASE));
    assert.deepEqual(update.set, {});
    assert.deepEqual(update.clear, []);
  });

  it('records an explicit clear request', () => {
    const update = secretsFromDraft({
      ...draftFromProfile(BASE),
      clearPassword: true,
      clearSshPrivateKey: true,
    });

    assert.deepEqual(update.set, {});
    assert.deepEqual(update.clear, ['password', 'sshPrivateKey']);
  });

  it('never trims a password, because spaces can be significant', () => {
    const update = secretsFromDraft({ ...draftFromProfile(BASE), password: '  spaced  ' });
    assert.equal(update.set.password, '  spaced  ');
  });

  it('ignores whitespace-only input unless a clear was requested', () => {
    const update = secretsFromDraft({ ...draftFromProfile(BASE), password: '   ' });
    assert.deepEqual(update.set, {});
    assert.deepEqual(update.clear, []);
  });

  it('supports typing a private key inline', () => {
    const update = secretsFromDraft({
      ...draftFromProfile(BASE),
      sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----x-----END OPENSSH PRIVATE KEY-----',
    });
    assert.match(String(update.set.sshPrivateKey), /BEGIN OPENSSH PRIVATE KEY/);
  });
});

describe('emptySecretPresence', () => {
  it('reports nothing stored', () => {
    assert.deepEqual(emptySecretPresence(), {
      password: false,
      sshPassword: false,
      sshPrivateKey: false,
      sshPassphrase: false,
    });
  });
});


