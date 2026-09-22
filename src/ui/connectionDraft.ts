/**
 * Connection form draft model and its conversion to/from `ConnectionProfile`.
 *
 * Everything the webview binds to is a string or a boolean, which keeps the
 * HTML form simple and makes the conversion pure and unit-testable.
 *
 * Security: secret fields exist in the draft **only** on the way in. The host
 * never sends a stored secret back to the webview; it sends booleans saying
 * whether a secret is set, so a user can keep or explicitly clear it.
 */

import type { DriverFactory } from '../db/driverRegistry';
import type {
  ConnectionProfile,
  ConnectionSecrets,
  SshAuthMethod,
} from '../db/types';
import { FILE_PATH_OPTION } from '../connections/validation';
import type { SecretField } from '../connections/connectionStore';

export interface FormDraft {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: string;
  user: string;
  database: string;
  schema: string;
  filePath: string;
  readOnly: boolean;
  sslEnabled: boolean;
  sslVerify: boolean;
  sslCaFile: string;
  sslCertFile: string;
  sslKeyFile: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuthMethod: SshAuthMethod;
  sshPrivateKeyPath: string;
  sshRemoteHost: string;
  sshRemotePort: string;
  /** Write-only: empty means "leave the stored value untouched". */
  password: string;
  sshPassword: string;
  sshPrivateKey: string;
  sshPassphrase: string;
  /** Explicit removal requests, so an empty box never silently deletes a secret. */
  clearPassword: boolean;
  clearSshPassword: boolean;
  clearSshPrivateKey: boolean;
  clearSshPassphrase: boolean;
}

/** Which secret fields already have a value in `SecretStorage`. */
export type SecretPresence = Record<SecretField, boolean>;

export function emptySecretPresence(): SecretPresence {
  return { password: false, sshPassword: false, sshPrivateKey: false, sshPassphrase: false };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function draftFromProfile(profile: ConnectionProfile): FormDraft {
  const filePath = text(profile.options?.[FILE_PATH_OPTION]);
  return {
    id: profile.id,
    name: profile.name,
    engine: profile.engine,
    host: text(profile.host),
    port: profile.port === undefined ? '' : String(profile.port),
    user: text(profile.user),
    database: text(profile.database),
    schema: text(profile.schema),
    filePath,
    readOnly: !!profile.readOnly,
    sslEnabled: !!profile.ssl?.enabled,
    sslVerify: profile.ssl?.verify !== false,
    sslCaFile: text(profile.ssl?.caFile),
    sslCertFile: text(profile.ssl?.certFile),
    sslKeyFile: text(profile.ssl?.keyFile),
    sshEnabled: !!profile.ssh?.enabled,
    sshHost: text(profile.ssh?.host),
    sshPort: profile.ssh?.port === undefined ? '' : String(profile.ssh.port),
    sshUser: text(profile.ssh?.username),
    sshAuthMethod: profile.ssh?.authMethod ?? 'password',
    sshPrivateKeyPath: text(profile.ssh?.privateKeyPath),
    sshRemoteHost: text(profile.ssh?.remoteHost),
    sshRemotePort: profile.ssh?.remotePort === undefined ? '' : String(profile.ssh.remotePort),
    password: '',
    sshPassword: '',
    sshPrivateKey: '',
    sshPassphrase: '',
    clearPassword: false,
    clearSshPassword: false,
    clearSshPrivateKey: false,
    clearSshPassphrase: false,
  };
}

export function emptyDraft(id: string, engine: string, factory?: DriverFactory): FormDraft {
  const profile: ConnectionProfile = {
    id,
    name: factory ? `New ${factory.label} Connection` : 'New Connection',
    engine: engine as ConnectionProfile['engine'],
    port: factory?.defaultPort,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return draftFromProfile(profile);
}

/**
 * Builds the profile to persist.
 *
 * `base` supplies `createdAt` and any driver-specific option the form does not
 * manage, so saving never silently drops settings this UI does not know about.
 *
 * SSL and SSH blocks are written even while disabled, as long as they hold at
 * least one value: toggling a section off must not erase what the user typed.
 */
export function profileFromDraft(draft: FormDraft, base: ConnectionProfile): ConnectionProfile {
  const options: Record<string, unknown> = { ...(base.options ?? {}) };
  const filePath = draft.filePath.trim();
  if (filePath) {
    options[FILE_PATH_OPTION] = filePath;
  } else {
    delete options[FILE_PATH_OPTION];
  }

  const caFile = draft.sslCaFile.trim();
  const certFile = draft.sslCertFile.trim();
  const keyFile = draft.sslKeyFile.trim();
  const hasSslValues = draft.sslEnabled || !!caFile || !!certFile || !!keyFile;

  const sshHost = draft.sshHost.trim();
  const sshUser = draft.sshUser.trim();
  const sshKeyPath = draft.sshPrivateKeyPath.trim();
  const sshRemoteHost = draft.sshRemoteHost.trim();
  const hasSshValues =
    draft.sshEnabled || !!sshHost || !!sshUser || !!sshKeyPath || !!sshRemoteHost;

  return {
    id: draft.id,
    name: draft.name.trim(),
    engine: draft.engine as ConnectionProfile['engine'],
    host: draft.host.trim() || undefined,
    port: optionalNumber(draft.port),
    user: draft.user.trim() || undefined,
    database: draft.database.trim() || undefined,
    schema: draft.schema.trim() || undefined,
    options,
    ssl: hasSslValues
      ? {
          enabled: draft.sslEnabled,
          verify: draft.sslVerify,
          caFile: caFile || undefined,
          certFile: certFile || undefined,
          keyFile: keyFile || undefined,
        }
      : undefined,
    ssh: hasSshValues
      ? {
          enabled: draft.sshEnabled,
          host: sshHost,
          port: optionalNumber(draft.sshPort),
          username: sshUser,
          authMethod: draft.sshAuthMethod,
          privateKeyPath: sshKeyPath || undefined,
          remoteHost: sshRemoteHost || undefined,
          remotePort: optionalNumber(draft.sshRemotePort),
        }
      : undefined,
    color: base.color,
    readOnly: draft.readOnly,
    createdAt: base.createdAt,
    updatedAt: Date.now(),
  };
}

export interface SecretUpdate {
  /** Values to store. Fields that are absent are left untouched. */
  set: ConnectionSecrets;
  /** Fields the user explicitly asked to erase. */
  clear: SecretField[];
}

/**
 * Extracts the secret changes described by a draft.
 *
 * An empty input means "keep the stored secret", which is why clearing requires
 * an explicit flag: a browser autofill or an accidental clear must never wipe a
 * password the user cannot see.
 */
export function secretsFromDraft(draft: FormDraft): SecretUpdate {
  const set: ConnectionSecrets = {};
  const clear: SecretField[] = [];

  const consider = (field: SecretField, value: string, clearRequested: boolean): void => {
    if (value.trim() !== '') {
      // Passwords are stored verbatim: leading/trailing spaces can be valid.
      set[field] = value;
      return;
    }
    if (clearRequested) {
      clear.push(field);
    }
  };

  consider('password', draft.password, draft.clearPassword);
  consider('sshPassword', draft.sshPassword, draft.clearSshPassword);
  consider('sshPrivateKey', draft.sshPrivateKey, draft.clearSshPrivateKey);
  consider('sshPassphrase', draft.sshPassphrase, draft.clearSshPassphrase);

  return { set, clear };
}

