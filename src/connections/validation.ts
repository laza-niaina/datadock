/**
 * Socket-free validation of connection profiles.
 *
 * This runs before any network activity so the wizard can show problems
 * immediately. Anything that requires opening a socket (credentials, database
 * existence, certificate contents) is validated at connect time by the driver.
 */

import type { DriverFactory } from '../db/driverRegistry';
import { SshAuthMethod } from '../db/types';
import type { ConnectionProfile } from '../db/types';

export const MAX_PROFILE_NAME = 200;
const SSH_AUTH_METHODS: readonly SshAuthMethod[] = ['password', 'privateKey', 'agent'];

/** Key used inside `profile.options` for file-based engines. */
export const FILE_PATH_OPTION = 'filePath';

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function portProblem(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port)) {
    return `${label} must be a whole number.`;
  }
  if (port < 1 || port > 65535) {
    return `${label} must be between 1 and 65535.`;
  }
  return undefined;
}

/**
 * Returns a list of human-readable problems. An empty array means the profile
 * is well formed; it does not mean the server will accept it.
 */
export function validateProfile(profile: ConnectionProfile, factory?: DriverFactory): string[] {
  const problems: string[] = [];

  if (isBlank(profile.name)) {
    problems.push('A connection name is required.');
  } else if (profile.name.trim().length > MAX_PROFILE_NAME) {
    problems.push(`The connection name must be at most ${MAX_PROFILE_NAME} characters.`);
  }

  if (isBlank(profile.engine)) {
    problems.push('A database engine is required.');
  } else if (!factory) {
    problems.push(`No driver is installed for engine '${profile.engine}'.`);
  }

  if (factory?.fileBased) {
    const filePath = profile.options?.[FILE_PATH_OPTION];
    if (isBlank(filePath)) {
      problems.push('A database file path is required for this engine.');
    }
  } else if (factory) {
    if (isBlank(profile.host)) {
      problems.push('A host is required.');
    }
    const hostPort = portProblem(profile.port, 'The port');
    if (hostPort) {
      problems.push(hostPort);
    }
  }

  if (profile.ssh?.enabled) {
    const ssh = profile.ssh;
    if (isBlank(ssh.host)) {
      problems.push('An SSH host is required when the tunnel is enabled.');
    }
    if (isBlank(ssh.username)) {
      problems.push('An SSH username is required when the tunnel is enabled.');
    }
    const sshPort = portProblem(ssh.port, 'The SSH port');
    if (sshPort) {
      problems.push(sshPort);
    }
    if (ssh.authMethod !== undefined && !SSH_AUTH_METHODS.includes(ssh.authMethod)) {
      problems.push(`Unsupported SSH authentication method '${ssh.authMethod}'.`);
    }
    const remotePort = portProblem(ssh.remotePort, 'The SSH remote port');
    if (remotePort) {
      problems.push(remotePort);
    }
  }

  if (profile.readOnly !== undefined && typeof profile.readOnly !== 'boolean') {
    problems.push('The read-only flag must be a boolean.');
  }

  return problems;
}

/**
 * Fills in the defaults a factory declares, without touching fields the user
 * already set. Keeps the wizard and any programmatic profile creation aligned.
 */
export function applyFactoryDefaults(profile: ConnectionProfile, factory?: DriverFactory): ConnectionProfile {
  if (!factory) {
    return profile;
  }
  const next: ConnectionProfile = { ...profile };
  if (!factory.fileBased && (next.port === undefined || next.port === 0) && factory.defaultPort !== undefined) {
    next.port = factory.defaultPort;
  }
  if (factory.fileBased && next.port === undefined) {
    delete next.port;
  }
  return next;
}
