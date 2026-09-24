/**
 * Live connection (session) manager.
 *
 * Responsibilities
 *  - turn a `ConnectionConfig` into a connected `DatabaseDriver`;
 *  - keep one transport per profile (never open a second socket for the same id);
 *  - own the SSH tunnel lifecycle so tunnelling is implemented once for every
 *    engine instead of being duplicated inside each driver;
 *  - expose an observable status per connection so the explorer can render
 *    connecting / connected / error states;
 *  - guarantee that a failed connect never leaks a driver or a tunnel.
 *
 * There is **no limit on the number of connections**: the map grows as needed.
 */

import type { DriverRegistry } from '../db/driverRegistry';
import { DbError, describeErrorCode, toDbError } from '../db/errors';
import type { DbErrorCode } from '../db/errors';
import { NEVER_CANCELLED, NULL_LOGGER } from '../db/types';
import type {
  CancelToken,
  ConnectionConfig,
  ConnectionProfile,
  DatabaseDriver,
  EngineId,
  Logger,
  TunnelHandle,
  TunnelOpener,
} from '../db/types';
import { Emitter, type Event } from '../util/emitter';
import { globalRedactor, type Redactor } from '../util/redaction';
import { resolveAssetsDir } from '../db/drivers/assets';

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SessionError {
  code: DbErrorCode;
  /** Already redacted; safe to show in a notification or a webview. */
  message: string;
  /** Short actionable hint derived from the error code. */
  hint: string;
}

export interface SessionStatus {
  id: string;
  name: string;
  engine: EngineId;
  state: SessionState;
  readOnly: boolean;
  error?: SessionError;
  connectedAt?: number;
  latencyMs?: number;
  /**
   * Databases visible at connect time; `undefined` when the probe failed or
   * the engine browses a single database (the tree has no database level to
   * badge in that case, so " · 1 db" would be noise).
   */
  databaseCount?: number;
}

export interface TestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  databaseCount?: number;
  databases?: string[];
  error?: SessionError;
}

export interface ConnectionManagerOptions {
  registry: DriverRegistry;
  logger?: Logger;
  redactor?: Redactor;
  /** SSH tunnel factory; absent while the SSH service is not implemented. */
  openTunnel?: TunnelOpener;
  /**
   * Directory holding runtime assets that cannot be bundled (currently
   * `sql-wasm.wasm`). Defaults to the bundle directory (`__dirname` of the
   * compiled extension), which is where `esbuild.js` copies them.
   */
  assetsDir?: string;
}

interface Session {
  status: SessionStatus;
  config?: ConnectionConfig;
  driver?: DatabaseDriver;
  tunnel?: TunnelHandle;
  /** In-flight connect, so a double click cannot open two sockets. */
  pending?: Promise<DatabaseDriver>;
}

export class ConnectionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly changed = new Emitter<SessionStatus>();
  private readonly logger: Logger;
  private readonly redactor: Redactor;
  private readonly assetsDir: string;

  /** Fires whenever a session changes state. */
  readonly onDidChange: Event<SessionStatus> = this.changed.event;

  constructor(private readonly options: ConnectionManagerOptions) {
    this.logger = options.logger ?? NULL_LOGGER;
    this.redactor = options.redactor ?? globalRedactor;
    this.assetsDir = resolveAssetsDir(options.assetsDir);
  }

  // -- status --------------------------------------------------------------

  isConnected(id: string): boolean {
    return this.sessions.get(id)?.status.state === 'connected';
  }

  statusOf(id: string): SessionStatus | undefined {
    const session = this.sessions.get(id);
    return session ? { ...session.status } : undefined;
  }

  allStatuses(): SessionStatus[] {
    return [...this.sessions.values()].map((session) => ({ ...session.status }));
  }

  getDriver(id: string): DatabaseDriver | undefined {
    return this.sessions.get(id)?.driver;
  }

  /** Returns the live driver or throws `CONNECTION_LOST`. */
  requireDriver(id: string): DatabaseDriver {
    const session = this.sessions.get(id);
    if (!session?.driver || session.status.state !== 'connected') {
      throw new DbError(
        'CONNECTION_LOST',
        `Connection '${session?.status.name ?? id}' is not connected. Connect it first.`,
      );
    }
    return session.driver;
  }

  /** Keeps the tree label in sync after a profile is edited or renamed. */
  refreshProfile(profile: ConnectionProfile): void {
    const session = this.sessions.get(profile.id);
    if (!session) {
      return;
    }
    session.status = { ...session.status, name: profile.name, engine: profile.engine, readOnly: !!profile.readOnly };
    this.changed.fire(session.status);
  }

  // -- life cycle ----------------------------------------------------------

  /**
   * Connects a profile, or returns the already-live driver.
   *
   * Concurrent calls for the same id share a single in-flight promise, so a
   * double-clicked tree node can never open two sockets.
   */
  async connect(config: ConnectionConfig, token: CancelToken = NEVER_CANCELLED): Promise<DatabaseDriver> {
    const id = config.profile.id;
    this.registerSecrets(config);

    const existing = this.sessions.get(id);
    if (existing?.pending) {
      return existing.pending;
    }
    if (existing?.driver && existing.status.state === 'connected') {
      return existing.driver;
    }

    const session: Session = existing ?? { status: this.initialStatus(config.profile) };
    session.config = config;
    session.status = { ...session.status, state: 'connecting', error: undefined };
    this.sessions.set(id, session);
    this.changed.fire({ ...session.status });

    const pending = this.openSession(session, config, token);
    session.pending = pending;
    try {
      return await pending;
    } finally {
      session.pending = undefined;
    }
  }

  private async openSession(
    session: Session,
    config: ConnectionConfig,
    token: CancelToken,
  ): Promise<DatabaseDriver> {
    const profile = config.profile;
    const started = Date.now();
    try {
      const factory = this.options.registry.require(profile.engine);

      const problems = factory.validate?.(config) ?? [];
      if (problems.length > 0) {
        throw new DbError('CONFIG_ERROR', problems.join('\n'));
      }

      const effective = await this.resolveTunnel(config, token);
      if (effective.tunnel) {
        session.tunnel = effective.tunnel;
      }

      const driver = factory.create(effective.config, { logger: this.logger, assetsDir: this.assetsDir });
      try {
        await driver.connect(token);
      } catch (connectError) {
        await driver.disconnect().catch(() => undefined);
        throw connectError;
      }

      const latencyMs = await driver.ping(token).catch(() => Date.now() - started);
      const databaseCount = driver.capabilities.multipleDatabases
        ? await driver
            .listDatabases(token)
            .then((databases) => databases.length)
            .catch(() => undefined)
        : undefined;

      session.driver = driver;
      session.status = {
        ...session.status,
        state: 'connected',
        connectedAt: Date.now(),
        latencyMs,
        databaseCount,
        error: undefined,
      };
      this.changed.fire({ ...session.status });
      this.logger.info(`Connected to '${profile.name}'.`, {
        engine: profile.engine,
        host: profile.host,
        latencyMs,
        tunnelled: !!session.tunnel,
      });
      return driver;
    } catch (error) {
      const dbError = toDbError(error);
      await this.closeSession(session);
      session.status = { ...session.status, state: 'error', error: this.toSessionError(dbError) };
      this.changed.fire({ ...session.status });
      this.logger.error(`Connection '${profile.name}' failed.`, {
        code: dbError.code,
        message: dbError.message,
      });
      // The caller may show this message directly, so it must already be redacted.
      throw this.redactedError(dbError);
    }
  }

  /**
   * Rewrites the profile to point at a loopback tunnel when SSH is enabled.
   * Throws `UNSUPPORTED_OPERATION` when SSH is requested but no SSH service is
   * registered: silently connecting in clear text would be a security bug.
   */
  private async resolveTunnel(
    config: ConnectionConfig,
    token: CancelToken,
  ): Promise<{ config: ConnectionConfig; tunnel?: TunnelHandle }> {
    const ssh = config.profile.ssh;
    if (!ssh?.enabled) {
      return { config };
    }
    if (!this.options.openTunnel) {
      throw new DbError(
        'UNSUPPORTED_OPERATION',
        'SSH tunnelling is not available in this build. Disable it in the connection settings or use a network-level tunnel.',
      );
    }
    const remoteHost = ssh.remoteHost?.trim() || config.profile.host || 'localhost';
    const remotePort =
      ssh.remotePort ??
      config.profile.port ??
      this.options.registry.get(config.profile.engine)?.defaultPort ??
      0;
    if (!remotePort) {
      throw new DbError('CONFIG_ERROR', 'Cannot determine the remote port to forward through the SSH tunnel.');
    }

    const tunnel = await this.options.openTunnel(config, remoteHost, remotePort, token);
    return {
      config: {
        profile: { ...config.profile, host: tunnel.host, port: tunnel.port },
        secrets: config.secrets,
      },
      tunnel,
    };
  }

  /** Closes the driver and the tunnel of a profile. Safe to call at any time. */
  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    await this.closeSession(session);
    session.status = {
      ...session.status,
      state: 'disconnected',
      connectedAt: undefined,
      latencyMs: undefined,
      databaseCount: undefined,
      error: undefined,
    };
    this.changed.fire({ ...session.status });
    this.logger.info(`Disconnected '${session.status.name}'.`, { id });
  }

  /** Disconnects every session; used on deactivation. */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disconnect(id)));
  }

  /**
   * Opens a throwaway connection to validate a profile.
   *
   * Never touches the session map: a successful test shows up in the wizard
   * without silently connecting the profile in the explorer.
   */
  async test(config: ConnectionConfig, token: CancelToken = NEVER_CANCELLED): Promise<TestConnectionResult> {
    this.registerSecrets(config);
    const started = Date.now();
    let driver: DatabaseDriver | undefined;
    let tunnel: TunnelHandle | undefined;

    try {
      const factory = this.options.registry.require(config.profile.engine);
      const problems = factory.validate?.(config) ?? [];
      if (problems.length > 0) {
        throw new DbError('CONFIG_ERROR', problems.join('\n'));
      }

      const effective = await this.resolveTunnel(config, token);
      tunnel = effective.tunnel;

      driver = factory.create(effective.config, { logger: this.logger, assetsDir: this.assetsDir });
      await driver.connect(token);
      const pingMs = await driver.ping(token).catch(() => Date.now() - started);

      let databases: string[] | undefined;
      try {
        databases = await driver.listDatabases(token);
      } catch (probeError) {
        // A restricted account may be unable to enumerate databases while the
        // connection itself is perfectly usable; that is not a test failure.
        this.logger.debug('Database enumeration failed during a connection test.', probeError);
      }

      return { ok: true, latencyMs: pingMs, databases, databaseCount: databases?.length };
    } catch (error) {
      const dbError = toDbError(error);
      this.logger.debug('Connection test failed.', { code: dbError.code });
      return { ok: false, error: this.toSessionError(dbError) };
    } finally {
      await driver?.disconnect().catch(() => undefined);
      await tunnel?.close().catch(() => undefined);
    }
  }

  /**
   * Releases a driver and its tunnel.
   * Errors are swallowed on purpose: cleanup must never mask the original
   * failure that triggered it.
   */
  private async closeSession(session: Session): Promise<void> {
    const driver = session.driver;
    const tunnel = session.tunnel;
    session.driver = undefined;
    session.tunnel = undefined;
    if (driver) {
      await driver.disconnect().catch(() => undefined);
    }
    if (tunnel) {
      await tunnel.close().catch(() => undefined);
    }
  }

  private initialStatus(profile: ConnectionProfile): SessionStatus {
    return {
      id: profile.id,
      name: profile.name,
      engine: profile.engine,
      state: 'disconnected',
      readOnly: !!profile.readOnly,
    };
  }

  /** Registers every secret of a config so nothing can leak through an error. */
  private registerSecrets(config: ConnectionConfig): void {
    const { password, sshPassword, sshPrivateKey, sshPassphrase } = config.secrets;
    this.redactor.addSecrets([password, sshPassword, sshPrivateKey, sshPassphrase]);
  }

  private toSessionError(error: DbError): SessionError {
    return {
      code: error.code,
      message: this.redactor.redact(error.message),
      hint: describeErrorCode(error.code),
    };
  }

  /**
   * Returns an error whose message is safe to hand to the UI.
   *
   * Server errors routinely echo the submitted credentials, so any error leaving
   * this class must go through the redactor. The original is kept as the cause
   * for logging and debugging.
   */
  private redactedError(error: DbError): DbError {
    const message = this.redactor.redact(error.message);
    return message === error.message ? error : new DbError(error.code, message, error);
  }

  dispose(): void {
    void this.disconnectAll();
    this.changed.dispose();
  }
}

