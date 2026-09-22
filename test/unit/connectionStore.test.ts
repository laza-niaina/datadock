import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DriverFactory } from '../../src/db/driverRegistry';
import type { ConnectionProfile, DatabaseDriver, DriverCapabilities } from '../../src/db/types';
import { NULL_LOGGER } from '../../src/db/types';
import {
  ConnectionStore,
  PROFILE_STORAGE_KEY,
  normalizeStoredProfiles,
  secretKeyFor,
  type MementoLike,
  type SecretStorageLike,
} from '../../src/connections/connectionStore';
import { Redactor } from '../../src/util/redaction';

/** In-memory stand-in for `vscode.Memento`; clones on read and write. */
class FakeMemento implements MementoLike {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (structuredClone(this.values.get(key)) as T) : defaultValue;
  }

  update(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }
}

/** In-memory stand-in for `vscode.SecretStorage`. */
class FakeSecretStorage implements SecretStorageLike {
  readonly values = new Map<string, string>();

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  store(key: string, value: string): void {
    this.values.set(key, value);
  }

  delete(key: string): void {
    this.values.delete(key);
  }
}

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

const MYSQL_FACTORY: DriverFactory = {
  engine: 'mysql',
  label: 'MySQL',
  status: 'stable',
  capabilities: CAPABILITIES,
  defaultPort: 3306,
  create: (): DatabaseDriver => {
    throw new Error('unused');
  },
};

function setup(): {
  store: ConnectionStore;
  memento: FakeMemento;
  secrets: FakeSecretStorage;
  redactor: Redactor;
} {
  const memento = new FakeMemento();
  const secrets = new FakeSecretStorage();
  const redactor = new Redactor();
  const store = new ConnectionStore(memento, secrets, NULL_LOGGER, redactor);
  return { store, memento, secrets, redactor };
}

function draftProfile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'profile-1',
    name: 'Local MySQL',
    engine: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('ConnectionStore: profiles', () => {
  it('starts empty', async () => {
    const { store } = setup();
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.count(), 0);
  });

  it('creates a profile and returns it from list/get/getByName', async () => {
    const { store } = setup();
    const saved = await store.save(draftProfile(), MYSQL_FACTORY);

    assert.equal(saved.name, 'Local MySQL');
    assert.equal((await store.list()).length, 1);
    assert.equal((await store.get('profile-1'))?.host, '127.0.0.1');
    assert.equal((await store.getByName('  local mysql '))?.id, 'profile-1');
    assert.equal(await store.count(), 1);
  });

  it('persists only serialisable profile fields, never a credential', async () => {
    const { store, memento } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);

    const raw = memento.values.get(PROFILE_STORAGE_KEY);
    assert.ok(Array.isArray(raw));
    const serialised = JSON.stringify(raw);
    assert.ok(serialised.includes('127.0.0.1'));
    assert.ok(!/password|secret|privatekey/i.test(serialised));
  });

  it('updates in place, preserving createdAt and the list length', async () => {
    const { store } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    const updated = await store.save(
      draftProfile({ name: 'Renamed', host: 'db.internal', createdAt: 1 }),
      MYSQL_FACTORY,
    );

    const all = await store.list();
    assert.equal(all.length, 1);
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.host, 'db.internal');
    assert.equal(updated.createdAt, 1_700_000_000_000, 'createdAt must not be replaced by the caller');
  });

  it('refuses a duplicate name, ignoring case and surrounding spaces', async () => {
    const { store } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);

    await assert.rejects(
      store.save(draftProfile({ id: 'profile-2', name: '  local mysql  ' }), MYSQL_FACTORY),
      (error: unknown) => (error as { code?: string }).code === 'CONFIG_ERROR',
    );
    assert.equal(await store.count(), 1);
  });

  it('refuses a profile that fails validation', async () => {
    const { store } = setup();
    await assert.rejects(store.save(draftProfile({ name: '' }), MYSQL_FACTORY), /name is required/);
    assert.equal(await store.count(), 0);
  });

  it('trims the stored name', async () => {
    const { store } = setup();
    const saved = await store.save(draftProfile({ name: '  Padded  ' }), MYSQL_FACTORY);
    assert.equal(saved.name, 'Padded');
  });

  it('emits onDidChange after a write', async () => {
    const { store } = setup();
    let notifications = 0;
    store.onDidChange(() => {
      notifications += 1;
    });

    await store.save(draftProfile(), MYSQL_FACTORY);
    assert.equal(notifications, 1);
  });

  it('builds a new profile with the factory default port', async () => {
    const { store } = setup();
    const profile = store.newProfile('mysql', MYSQL_FACTORY);
    assert.equal(profile.port, 3306);
    assert.match(profile.name, /New MySQL Connection/);
    assert.notEqual(profile.id, '');
    assert.equal(profile.createdAt, profile.updatedAt);
  });

  it('returns undefined for an unknown id and an unknown name', async () => {
    const { store } = setup();
    assert.equal(await store.get('nope'), undefined);
    assert.equal(await store.getByName('nope'), undefined);
    assert.equal(await store.readConfig('nope'), undefined);
  });
});

describe('ConnectionStore: secrets', () => {
  it('stores and reads secrets outside the profile storage', async () => {
    const { store, memento, secrets } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: 'pa55w0rd' });

    assert.equal(secrets.values.get(secretKeyFor('profile-1', 'password')), 'pa55w0rd');
    assert.equal(JSON.stringify([...memento.values.values()]).includes('pa55w0rd'), false);
    assert.equal((await store.getSecrets('profile-1')).password, 'pa55w0rd');
  });

  it('registers read secrets with the redactor', async () => {
    const { store, redactor } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: 'pa55w0rd' });

    assert.equal(redactor.redact('failed for pa55w0rd'), 'failed for ***');
  });

  it('omits absent and empty secret fields', async () => {
    const { store } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: '', sshPassword: 'k' });

    assert.deepEqual(await store.getSecrets('profile-1'), { sshPassword: 'k' });
  });

  it('leaves untouched secrets alone during a partial update', async () => {
    const { store } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: 'first', sshPassword: 'second' });

    // Only the SSH password changes; the database password must survive.
    await store.applySecretUpdate('profile-1', { set: { sshPassword: 'rotated' } });

    assert.deepEqual(await store.getSecrets('profile-1'), { password: 'first', sshPassword: 'rotated' });
  });

  it('erases a secret only when it is explicitly cleared', async () => {
    const { store, secrets } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: 'first', sshPassword: 'second' });

    await store.applySecretUpdate('profile-1', { set: {}, clear: ['password'] });

    assert.equal(secrets.values.has(secretKeyFor('profile-1', 'password')), false);
    assert.deepEqual(await store.getSecrets('profile-1'), { sshPassword: 'second' });
  });

  it('reports secret presence without returning the value', async () => {
    const { store } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: 'pa55w0rd' });

    assert.deepEqual(await store.secretPresence('profile-1'), {
      password: true,
      sshPassword: false,
      sshPrivateKey: false,
      sshPassphrase: false,
    });
  });

  it('returns profile and secrets together from readConfig', async () => {
    const { store } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: 'pa55w0rd' });

    const config = await store.readConfig('profile-1');
    assert.equal(config?.profile.name, 'Local MySQL');
    assert.equal(config?.secrets.password, 'pa55w0rd');
  });

  it('clears a secret without deleting the profile', async () => {
    const { store, secrets } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: 'pa55w0rd' });

    await store.clearSecrets('profile-1');

    assert.equal(secrets.values.size, 0);
    assert.equal(await store.count(), 1);
  });
});

describe('ConnectionStore: deletion and duplication', () => {
  it('removes the profile, its secrets and its redaction entries', async () => {
    const { store, secrets, redactor } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: 'pa55w0rd' });
    assert.equal(redactor.redact('pa55w0rd'), '***');

    assert.equal(await store.remove('profile-1'), true);

    assert.equal(await store.count(), 0);
    assert.equal(secrets.values.size, 0);
    assert.equal(redactor.redact('pa55w0rd'), 'pa55w0rd', 'the value must stop being masked');
  });

  it('returns false when removing an unknown profile', async () => {
    const { store } = setup();
    assert.equal(await store.remove('nope'), false);
  });

  it('duplicates a profile and its secrets under a new id and name', async () => {
    const { store } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    await store.setSecrets('profile-1', { password: 'pa55w0rd' });

    const copy = await store.duplicate('profile-1');

    assert.ok(copy);
    assert.notEqual(copy.id, 'profile-1');
    assert.equal(copy.name, 'Local MySQL (copy)');
    assert.equal(copy.host, '127.0.0.1');
    assert.equal((await store.getSecrets(copy.id)).password, 'pa55w0rd');
    assert.equal(await store.count(), 2);
  });

  it('accepts an explicit name when duplicating', async () => {
    const { store } = setup();
    await store.save(draftProfile(), MYSQL_FACTORY);
    assert.equal((await store.duplicate('profile-1', 'Staging'))?.name, 'Staging');
  });

  it('returns undefined when duplicating an unknown profile', async () => {
    const { store } = setup();
    assert.equal(await store.duplicate('nope'), undefined);
  });
});

describe('ConnectionStore: naming', () => {
  it('returns the base name when it is free', () => {
    const { store } = setup();
    assert.equal(store.nextAvailableName('Fresh'), 'Fresh');
  });

  it('appends an increasing suffix when the name is taken', async () => {
    const { store } = setup();
    await store.save(draftProfile({ name: 'Local' }), MYSQL_FACTORY);
    await store.save(draftProfile({ id: 'profile-2', name: 'Local 2' }), MYSQL_FACTORY);

    assert.equal(store.nextAvailableName('Local'), 'Local 3');
  });

  it('ignores case and padding when checking availability', async () => {
    const { store } = setup();
    await store.save(draftProfile({ name: 'Local' }), MYSQL_FACTORY);
    assert.equal(store.nextAvailableName('  local  '), 'local 2');
  });
});

describe('normalizeStoredProfiles', () => {
  it('returns an empty list for a non-array value', () => {
    assert.deepEqual(normalizeStoredProfiles(undefined), []);
    assert.deepEqual(normalizeStoredProfiles(null), []);
    assert.deepEqual(normalizeStoredProfiles({ nope: true }), []);
  });

  it('drops entries that are not objects or lack an id/name/engine', () => {
    const result = normalizeStoredProfiles([
      null,
      'string',
      { name: 'no id', engine: 'mysql' },
      { id: 'a', engine: 'mysql' },
      { id: 'b', name: 'no engine' },
      { id: 'c', name: 'good', engine: 'mysql' },
    ]);

    assert.deepEqual(
      result.map((profile) => profile.id),
      ['c'],
    );
  });

  it('drops duplicated ids, keeping the first occurrence', () => {
    const result = normalizeStoredProfiles([
      { id: 'dup', name: 'first', engine: 'mysql' },
      { id: 'dup', name: 'second', engine: 'mysql' },
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'first');
  });

  it('backfills missing timestamps', () => {
    const result = normalizeStoredProfiles([{ id: 'a', name: 'A', engine: 'mysql' }]);
    assert.equal(typeof result[0].createdAt, 'number');
    assert.equal(typeof result[0].updatedAt, 'number');
  });
});


