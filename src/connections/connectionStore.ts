/**
 * Connection profile persistence.
 *
 * Storage split (see `.internal/TECHNICAL.md`):
 *  - **profiles** (host, port, user, engine, SSL/SSH settings) live in
 *    `vscode.Memento` (`globalState`) as plain JSON. They never contain a
 *    password.
 *  - **secrets** (password, SSH password, private key, passphrase) live in
 *    `vscode.SecretStorage`, one key per profile and field.
 *
 * The class depends on structural interfaces rather than `vscode` types so it
 * can be unit-tested with in-memory fakes. `vscode.Memento` and
 * `vscode.SecretStorage` satisfy those interfaces as-is.
 */

import { randomUUID } from 'node:crypto';
import type { DriverFactory } from '../db/driverRegistry';
import { DbError } from '../db/errors';
import { NULL_LOGGER } from '../db/types';
import type { ConnectionConfig, ConnectionProfile, ConnectionSecrets, Logger } from '../db/types';
import { Emitter, type Event } from '../util/emitter';
import { globalRedactor, type Redactor } from '../util/redaction';
import { applyFactoryDefaults, validateProfile } from './validation';

/** Versioned key so a future schema change can migrate instead of corrupting. */
export const PROFILE_STORAGE_KEY = 'dbclient.connections.v1';
export const SECRET_KEY_PREFIX = 'dbclient.secret.v1.';

/** Secret fields persisted per profile. Order is stable for migration. */
export const SECRET_FIELDS = ['password', 'sshPassword', 'sshPrivateKey', 'sshPassphrase'] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

/** Subset of `vscode.Memento` used by this store. */
export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

/** Subset of `vscode.SecretStorage` used by this store. */
export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined> | string | undefined;
  store(key: string, value: string): PromiseLike<void> | void;
  delete(key: string): PromiseLike<void> | void;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function secretKeyFor(profileId: string, field: SecretField): string {
  return `${SECRET_KEY_PREFIX}${profileId}.${field}`;
}

/**
 * Coerces whatever was in storage into well-formed profiles.
 * Unparseable entries are dropped with a warning rather than crashing
 * activation; the raw value is left untouched in storage so nothing is lost.
 */
export function normalizeStoredProfiles(raw: unknown, logger: Logger = NULL_LOGGER): ConnectionProfile[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined && raw !== null) {
      logger.warn('Stored connection list is not an array; ignoring it.', { type: typeof raw });
    }
    return [];
  }
  const profiles: ConnectionProfile[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const candidate = entry as Partial<ConnectionProfile>;
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      logger.warn('Skipping a stored connection without an id.');
      continue;
    }
    if (seenIds.has(candidate.id)) {
      logger.warn('Skipping a stored connection with a duplicated id.', { id: candidate.id });
      continue;
    }
    if (typeof candidate.name !== 'string' || typeof candidate.engine !== 'string') {
      logger.warn('Skipping an incomplete stored connection.', { id: candidate.id });
      continue;
    }
    seenIds.add(candidate.id);
    const now = Date.now();
    profiles.push({
      ...(candidate as ConnectionProfile),
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : now,
      updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : now,
    });
  }
  return profiles;
}

export class ConnectionStore {
  private cache: ConnectionProfile[] | undefined;
  private readonly changed = new Emitter<void>();

  /** Fires after any create/update/delete so views can refresh. */
  readonly onDidChange: Event<void> = this.changed.event;

  constructor(
    private readonly storage: MementoLike,
    private readonly secretStorage: SecretStorageLike,
    private readonly logger: Logger = NULL_LOGGER,
    private readonly redactor: Redactor = globalRedactor,
  ) {}

  // -- reads ---------------------------------------------------------------

  async list(): Promise<ConnectionProfile[]> {
    return (await this.load()).map(clone);
  }

  async count(): Promise<number> {
    return (await this.load()).length;
  }

  async get(id: string): Promise<ConnectionProfile | undefined> {
    const found = (await this.load()).find((profile) => profile.id === id);
    return found ? clone(found) : undefined;
  }

  async getByName(name: string): Promise<ConnectionProfile | undefined> {
    const wanted = name.trim().toLowerCase();
    const found = (await this.load()).find((profile) => profile.name.trim().toLowerCase() === wanted);
    return found ? clone(found) : undefined;
  }

  /** Profile plus its secrets, ready to hand to a driver factory. */
  async readConfig(id: string): Promise<ConnectionConfig | undefined> {
    const profile = await this.get(id);
    if (!profile) {
      return undefined;
    }
    return { profile, secrets: await this.getSecrets(id) };
  }

  /** Clears the in-memory cache; the next read reloads from storage. */
  invalidate(): void {
    this.cache = undefined;
  }

  // -- writes --------------------------------------------------------------

  /** Blank profile with a fresh id, ready for the connection form. */
  newProfile(engine: ConnectionProfile['engine'], factory?: DriverFactory): ConnectionProfile {
    const now = Date.now();
    const base: ConnectionProfile = {
      id: randomUUID(),
      name: factory ? `New ${factory.label} Connection` : 'New Connection',
      engine,
      createdAt: now,
      updatedAt: now,
    };
    return applyFactoryDefaults(base, factory);
  }

  /**
   * Inserts or updates a profile.
   * Throws `DbError('CONFIG_ERROR')` when validation fails or the name clashes.
   */
  async save(input: ConnectionProfile, factory?: DriverFactory): Promise<ConnectionProfile> {
    const profiles = await this.load();
    const profile: ConnectionProfile = { ...input, name: input.name.trim(), updatedAt: Date.now() };

    const problems = validateProfile(profile, factory);
    if (problems.length > 0) {
      throw new DbError('CONFIG_ERROR', problems.join('\n'));
    }

    const clash = profiles.find(
      (existing) => existing.id !== profile.id && existing.name.trim().toLowerCase() === profile.name.toLowerCase(),
    );
    if (clash) {
      throw new DbError('CONFIG_ERROR', `A connection named '${profile.name}' already exists.`);
    }

    const index = profiles.findIndex((existing) => existing.id === profile.id);
    if (index >= 0) {
      // Preserve the original creation timestamp on update.
      const created = profiles[index].createdAt;
      profiles[index] = { ...profiles[index], ...profile, createdAt: created };
      await this.persist(profiles, 'update');
      this.logger.info(`Connection '${profile.name}' updated.`, { id: profile.id, engine: profile.engine });
      return clone(profiles[index]);
    }

    profiles.push(profile);
    await this.persist(profiles, 'create');
    this.logger.info(`Connection '${profile.name}' created.`, { id: profile.id, engine: profile.engine });
    return clone(profile);
  }

  /**
   * Deletes a profile and every secret attached to it.
   * Returns `false` when the id is unknown.
   */
  async remove(id: string): Promise<boolean> {
    const profiles = await this.load();
    const index = profiles.findIndex((profile) => profile.id === id);
    if (index < 0) {
      return false;
    }
    const [removed] = profiles.splice(index, 1);
    const secrets = await this.getSecrets(id);
    await this.clearSecrets(id);
    // Stop masking values that no longer belong to any profile.
    for (const field of SECRET_FIELDS) {
      this.redactor.deleteSecret(secrets[field]);
    }
    await this.persist(profiles, 'remove');
    this.logger.info(`Connection '${removed.name}' deleted.`, { id });
    return true;
  }

  /** Copies a profile and its secrets under a new id and name. */
  async duplicate(id: string, name?: string): Promise<ConnectionProfile | undefined> {
    const source = await this.get(id);
    if (!source) {
      return undefined;
    }
    const profiles = await this.load();
    const now = Date.now();
    const copy: ConnectionProfile = {
      ...clone(source),
      id: randomUUID(),
      name: name?.trim() || this.nextAvailableName(`${source.name} (copy)`, profiles),
      createdAt: now,
      updatedAt: now,
    };
    profiles.push(copy);
    await this.persist(profiles, 'duplicate');

    const secrets = await this.getSecrets(id);
    await this.setSecrets(copy.id, secrets);
    this.logger.info(`Connection '${source.name}' duplicated as '${copy.name}'.`, { id: copy.id });
    return clone(copy);
  }

  // -- secrets -------------------------------------------------------------

  /**
   * Reads the secrets of a profile and registers them with the redactor so
   * they can never reach a log or an error notification.
   */
  async getSecrets(id: string): Promise<ConnectionSecrets> {
    const result: ConnectionSecrets = {};
    for (const field of SECRET_FIELDS) {
      const value = await Promise.resolve(this.secretStorage.get(secretKeyFor(id, field)));
      if (typeof value === 'string' && value.length > 0) {
        result[field] = value;
        this.redactor.addSecret(value);
      }
    }
    return result;
  }

  /** Stores non-empty secrets and deletes keys for empty ones. */
  async setSecrets(id: string, secrets: ConnectionSecrets): Promise<void> {
    for (const field of SECRET_FIELDS) {
      const key = secretKeyFor(id, field);
      const value = secrets[field];
      if (typeof value === 'string' && value.length > 0) {
        await Promise.resolve(this.secretStorage.store(key, value));
        this.redactor.addSecret(value);
      } else {
        await Promise.resolve(this.secretStorage.delete(key));
      }
    }
  }

  /** Removes every secret of a profile without touching the profile itself. */
  async clearSecrets(id: string): Promise<void> {
    for (const field of SECRET_FIELDS) {
      await Promise.resolve(this.secretStorage.delete(secretKeyFor(id, field)));
    }
  }

  /**
   * Applies a partial secret update.
   *
   * Unlike `setSecrets`, a field absent from `set` is **left untouched**; only
   * fields listed in `clear` are erased. This is what lets the connection form
   * show an empty password box meaning "keep the stored one".
   */
  async applySecretUpdate(
    id: string,
    update: { set: ConnectionSecrets; clear?: readonly SecretField[] },
  ): Promise<void> {
    for (const field of update.clear ?? []) {
      await Promise.resolve(this.secretStorage.delete(secretKeyFor(id, field)));
    }
    for (const field of SECRET_FIELDS) {
      const value = update.set[field];
      if (typeof value === 'string' && value.length > 0) {
        await Promise.resolve(this.secretStorage.store(secretKeyFor(id, field), value));
        this.redactor.addSecret(value);
      }
    }
  }

  /** Reports which secret fields currently hold a value, without reading them. */
  async secretPresence(id: string): Promise<Record<SecretField, boolean>> {
    const presence = {} as Record<SecretField, boolean>;
    for (const field of SECRET_FIELDS) {
      const value = await Promise.resolve(this.secretStorage.get(secretKeyFor(id, field)));
      presence[field] = typeof value === 'string' && value.length > 0;
    }
    return presence;
  }

  // -- helpers -------------------------------------------------------------

  /** `base`, then `base 2`, `base 3`, ... until the name is free. */
  nextAvailableName(base: string, existing?: ConnectionProfile[]): string {
    const pool = existing ?? this.cache ?? [];
    const taken = new Set(pool.map((profile) => profile.name.trim().toLowerCase()));
    if (!taken.has(base.trim().toLowerCase())) {
      return base.trim();
    }
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base.trim()} ${suffix}`;
      if (!taken.has(candidate.toLowerCase())) {
        return candidate;
      }
    }
    return `${base.trim()} ${randomUUID().slice(0, 8)}`;
  }

  private async load(): Promise<ConnectionProfile[]> {
    if (!this.cache) {
      this.cache = normalizeStoredProfiles(this.storage.get<unknown>(PROFILE_STORAGE_KEY), this.logger);
    }
    return this.cache;
  }

  private async persist(profiles: ConnectionProfile[], reason: string): Promise<void> {
    this.cache = profiles;
    await Promise.resolve(this.storage.update(PROFILE_STORAGE_KEY, profiles));
    this.logger.debug(`Connection list persisted (${reason}).`, { count: profiles.length });
    this.changed.fire();
  }
}

