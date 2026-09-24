import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectionManager } from '../../src/connections/connectionManager';
import type { DriverFactory } from '../../src/db/driverRegistry';
import { DriverRegistry } from '../../src/db/driverRegistry';
import { DbError } from '../../src/db/errors';
import { NULL_LOGGER } from '../../src/db/types';
import type {
  CancelToken,
  ColumnInfo,
  ConnectionConfig,
  ConnectionProfile,
  ConnectionSecrets,
  DatabaseDriver,
  DriverCapabilities,
  EngineId,
  EngineStatus,
  QueryExecutionResult,
  TableDataPage,
  TableInfo,
} from '../../src/db/types';
import { Redactor } from '../../src/util/redaction';

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

/** Deterministic driver double; records every call so tests can assert on them. */
class FakeDriver implements DatabaseDriver {
  readonly capabilities: DriverCapabilities;
  readonly engine: EngineId;

  connectCalls = 0;
  disconnectCalls = 0;
  pingCalls = 0;
  connected = false;

  databases: string[] = ['app', 'reporting'];
  databasesError: Error | undefined;
  connectError: Error | undefined;
  connectDelayMs = 0;
  pingLatencyMs = 7;
  lastConfig: ConnectionConfig | undefined;

  constructor(engine: EngineId = 'mysql', capabilities: DriverCapabilities = CAPABILITIES) {
    this.engine = engine;
    this.capabilities = capabilities;
  }

  async connect(_token?: CancelToken): Promise<void> {
    this.connectCalls += 1;
    if (this.connectDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    }
    if (this.connectError) {
      throw this.connectError;
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  async ping(): Promise<number> {
    this.pingCalls += 1;
    if (!this.connected) {
      throw new DbError('CONNECTION_LOST', 'ping on a closed connection');
    }
    return this.pingLatencyMs;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listDatabases(): Promise<string[]> {
    if (this.databasesError) {
      throw this.databasesError;
    }
    return this.databases;
  }

  async listSchemas(): Promise<string[]> {
    return [];
  }

  async listTables(): Promise<TableInfo[]> {
    return [];
  }

  async listColumns(): Promise<ColumnInfo[]> {
    return [];
  }

  async execute(): Promise<QueryExecutionResult> {
    throw new DbError('UNSUPPORTED_OPERATION', 'execute is not exercised by these tests');
  }

  async getTableData(): Promise<TableDataPage> {
    throw new DbError('UNSUPPORTED_OPERATION', 'getTableData is not exercised by these tests');
  }
}

class FakeFactory implements DriverFactory {
  readonly engine: EngineId = 'mysql';
  readonly label = 'Fake MySQL';
  readonly status: EngineStatus = 'stable';
  readonly capabilities: DriverCapabilities = CAPABILITIES;
  defaultPort: number | undefined = 3306;

  readonly drivers: FakeDriver[] = [];
  validateProblems: string[] = [];
  driverCapabilities: DriverCapabilities = CAPABILITIES;
  lastValidateConfig: ConnectionConfig | undefined;

  create(config: ConnectionConfig): DatabaseDriver {
    const driver = new FakeDriver(this.engine, this.driverCapabilities);
    driver.lastConfig = config;
    this.drivers.push(driver);
    return driver;
  }

  validate(config: ConnectionConfig): string[] {
    this.lastValidateConfig = config;
    return this.validateProblems;
  }
}

function setup(): {
  manager: ConnectionManager;
  factory: FakeFactory;
  registry: DriverRegistry;
  redactor: Redactor;
} {
  const registry = new DriverRegistry('test');
  const factory = new FakeFactory();
  registry.register(factory);
  const redactor = new Redactor();
  const manager = new ConnectionManager({ registry, logger: NULL_LOGGER, redactor });
  return { manager, factory, registry, redactor };
}

function config(
  id: string,
  profile: Partial<ConnectionProfile> = {},
  secrets: ConnectionSecrets = { password: 'pa55w0rd' },
): ConnectionConfig {
  return {
    profile: {
      id,
      name: `conn-${id}`,
      engine: 'mysql',
      host: 'localhost',
      port: 3306,
      createdAt: 0,
      updatedAt: 0,
      ...profile,
    },
    secrets,
  };
}

describe('ConnectionManager: connecting', () => {
  it('connects a profile and exposes its driver', async () => {
    const { manager, factory } = setup();
    const driver = await manager.connect(config('a'));

    assert.equal(driver, factory.drivers[0]);
    assert.equal(driver.isConnected(), true);
    assert.equal(manager.isConnected('a'), true);
    assert.equal(manager.getDriver('a'), driver);
    assert.equal(manager.requireDriver('a'), driver);
  });

  it('records status, latency and the visible database count', async () => {
    const { manager } = setup();
    await manager.connect(config('a'));

    const status = manager.statusOf('a');
    assert.equal(status?.state, 'connected');
    assert.equal(status?.latencyMs, 7);
    assert.equal(status?.databaseCount, 2);
    assert.equal(typeof status?.connectedAt, 'number');
    assert.equal(status?.error, undefined);
  });

  it('hides the database count for single-database engines', async () => {
    const { manager, factory } = setup();
    factory.driverCapabilities = { ...CAPABILITIES, multipleDatabases: false };
    await manager.connect(config('a'));
    assert.equal(manager.statusOf('a')?.databaseCount, undefined);
  });

  it('throws CONNECTION_LOST when the profile is not connected', () => {
    const { manager } = setup();
    assert.throws(
      () => manager.requireDriver('missing'),
      (error: unknown) => (error as { code?: string }).code === 'CONNECTION_LOST',
    );
    assert.equal(manager.getDriver('missing'), undefined);
    assert.equal(manager.statusOf('missing'), undefined);
  });

  it('reports a connecting state before it reports connected', async () => {
    const { manager } = setup();
    const seen: string[] = [];
    manager.onDidChange((status) => seen.push(status.state));

    await manager.connect(config('a'));
    assert.deepEqual(seen, ['connecting', 'connected']);
  });

  it('reuses the live driver instead of opening a second socket', async () => {
    const { manager, factory } = setup();
    const first = (await manager.connect(config('a'))) as FakeDriver;
    const second = await manager.connect(config('a'));

    assert.equal(first, second);
    assert.equal(factory.drivers.length, 1);
    assert.equal(first.connectCalls, 1);
  });

  it('shares one in-flight connect between concurrent callers', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.connectDelayMs = 5;
    factory.create = (): DatabaseDriver => driver;

    const [first, second, third] = await Promise.all([
      manager.connect(config('a')),
      manager.connect(config('a')),
      manager.connect(config('a')),
    ]);

    assert.equal(first, driver);
    assert.equal(second, driver);
    assert.equal(third, driver);
    assert.equal(driver.connectCalls, 1, 'a double click must not open two sockets');
  });

  it('keeps distinct profiles on distinct sessions', async () => {
    const { manager, factory } = setup();
    await manager.connect(config('a'));
    await manager.connect(config('b'));

    assert.equal(factory.drivers.length, 2);
    assert.notEqual(manager.getDriver('a'), manager.getDriver('b'));
  });

  it('proves there is no artificial limit on the number of connections', async () => {
    const { manager, factory } = setup();
    const total = 250;

    await Promise.all(Array.from({ length: total }, (_value, index) => manager.connect(config(`c${index}`))));

    assert.equal(factory.drivers.length, total);
    assert.equal(manager.allStatuses().length, total);
    assert.equal(
      manager.allStatuses().every((status) => status.state === 'connected'),
      true,
    );
  });
});

describe('ConnectionManager: failures', () => {
  it('classifies a native driver error and closes the half-open driver', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.connectError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), {
      code: 'ECONNREFUSED',
    });
    factory.create = (): DatabaseDriver => driver;

    await assert.rejects(manager.connect(config('a')), /ECONNREFUSED/);

    const status = manager.statusOf('a');
    assert.equal(status?.state, 'error');
    assert.equal(status?.error?.code, 'CONNECTION_REFUSED');
    assert.match(String(status?.error?.hint), /refused/i);
    assert.equal(driver.disconnectCalls, 1, 'a failed connect must not leak a socket');
    assert.equal(manager.getDriver('a'), undefined);
    assert.equal(manager.isConnected('a'), false);
  });

  it('keeps the DbError code a driver raised itself', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.connectError = new DbError('AUTH_FAILED', 'Access denied for user root');
    factory.create = (): DatabaseDriver => driver;

    await assert.rejects(manager.connect(config('a')), /Access denied/);
    assert.equal(manager.statusOf('a')?.error?.code, 'AUTH_FAILED');
  });

  it('reports DRIVER_NOT_FOUND and never calls into a missing driver', async () => {
    const { manager } = setup();
    await assert.rejects(
      manager.connect(config('a', { engine: 'postgresql' })),
      (error: unknown) => (error as { code?: string }).code === 'DRIVER_NOT_FOUND',
    );
    assert.equal(manager.statusOf('a')?.state, 'error');
  });

  it('refuses a profile the driver declares invalid, before connecting', async () => {
    const { manager, factory } = setup();
    factory.validateProblems = ['A host is required.'];

    await assert.rejects(
      manager.connect(config('a')),
      (error: unknown) => (error as { code?: string }).code === 'CONFIG_ERROR',
    );
    assert.equal(factory.drivers.length, 0, 'no socket may be opened for an invalid profile');
  });

  it('passes the config to the driver validation hook', async () => {
    const { manager, factory } = setup();
    const target = config('a');
    await manager.connect(target);
    assert.equal(factory.lastValidateConfig?.profile.id, 'a');
  });

  it('still connects when the database probe fails', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.databasesError = new DbError('PERMISSION_DENIED', 'SHOW DATABASES denied');
    factory.create = (): DatabaseDriver => driver;

    await manager.connect(config('a'));

    assert.equal(manager.statusOf('a')?.state, 'connected');
    assert.equal(manager.statusOf('a')?.databaseCount, undefined);
  });

  it('still connects when ping fails, using the wall clock instead', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    // ping() rejects because the fake only reports connected after connect();
    // simulate a driver whose ping is not implemented.
    driver.ping = async (): Promise<number> => {
      throw new DbError('UNSUPPORTED_OPERATION', 'ping not implemented');
    };
    factory.create = (): DatabaseDriver => driver;

    await manager.connect(config('a'));
    assert.equal(manager.statusOf('a')?.state, 'connected');
    assert.equal(typeof manager.statusOf('a')?.latencyMs, 'number');
  });

  it('recovers on a later attempt after a failure', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.connectError = new DbError('TIMEOUT', 'timed out');
    factory.create = (): DatabaseDriver => driver;

    await assert.rejects(manager.connect(config('a')));
    assert.equal(manager.statusOf('a')?.state, 'error');

    driver.connectError = undefined;
    await manager.connect(config('a'));
    assert.equal(manager.statusOf('a')?.state, 'connected');
  });
});

describe('ConnectionManager: redaction', () => {
  it('masks the password when it appears in a server error message', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.connectError = new DbError('AUTH_FAILED', "Access denied for 'root' using pa55w0rd");
    factory.create = (): DatabaseDriver => driver;

    await assert.rejects(manager.connect(config('a')));

    const message = String(manager.statusOf('a')?.error?.message);
    assert.ok(message.includes('***'), 'the secret must be masked');
    assert.equal(message.includes('pa55w0rd'), false, 'the raw password must never surface');
  });

  it('redacts the same secret inside the thrown error returned to the caller', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.connectError = new DbError('AUTH_FAILED', 'password=pa55w0rd rejected');
    factory.create = (): DatabaseDriver => driver;

    await assert.rejects(manager.connect(config('a')), (error: unknown) => {
      const message = (error as Error).message;
      return message.includes('***') && !message.includes('pa55w0rd');
    });
  });
});

interface FakeTunnel {
  host: string;
  port: number;
  closed: boolean;
}

function setupWithTunnel(): {
  manager: ConnectionManager;
  factory: FakeFactory;
  tunnels: FakeTunnel[];
} {
  const registry = new DriverRegistry('test');
  const factory = new FakeFactory();
  registry.register(factory);

  const tunnels: FakeTunnel[] = [];
  const manager = new ConnectionManager({
    registry,
    logger: NULL_LOGGER,
    redactor: new Redactor(),
    openTunnel: async () => {
      const tunnel: FakeTunnel = { host: '127.0.0.1', port: 41_000 + tunnels.length, closed: false };
      tunnels.push(tunnel);
      return {
        host: tunnel.host,
        port: tunnel.port,
        close: async (): Promise<void> => {
          tunnel.closed = true;
        },
      };
    },
  });

  return { manager, factory, tunnels };
}

const SSH_PROFILE: Partial<ConnectionProfile> = {
  host: 'db.internal',
  port: 3306,
  ssh: {
    enabled: true,
    host: 'bastion.example.com',
    username: 'ops',
    port: 22,
    remoteHost: '10.0.0.5',
    remotePort: 3306,
  },
};

describe('ConnectionManager: SSH tunnel ownership', () => {
  it('refuses a tunnelled profile when no SSH service is registered', async () => {
    const { manager, factory } = setup();
    await assert.rejects(
      manager.connect(config('a', SSH_PROFILE)),
      (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_OPERATION',
    );
    assert.equal(factory.drivers.length, 0, 'it must never fall back to a clear-text connection');
    assert.equal(manager.statusOf('a')?.state, 'error');
  });

  it('opens a tunnel and points the driver at the loopback endpoint', async () => {
    const { manager, factory, tunnels } = setupWithTunnel();
    const configWithSsh = config('a', SSH_PROFILE, { password: 'db-pass', sshPassword: 'ssh-pass' });

    await manager.connect(configWithSsh);

    assert.equal(tunnels.length, 1);
    const handedToDriver = factory.drivers[0].lastConfig;
    assert.equal(handedToDriver?.profile.host, '127.0.0.1');
    assert.equal(handedToDriver?.profile.port, 41_000);
    assert.equal(handedToDriver?.profile.ssh?.host, 'bastion.example.com');
    assert.equal(handedToDriver?.secrets.password, 'db-pass');
    assert.equal(handedToDriver?.secrets.sshPassword, 'ssh-pass');
  });

  it('closes the tunnel when the profile disconnects', async () => {
    const { manager, tunnels } = setupWithTunnel();
    await manager.connect(config('a', SSH_PROFILE));
    assert.equal(tunnels[0].closed, false);

    await manager.disconnect('a');
    assert.equal(tunnels[0].closed, true);
  });

  it('falls back to the profile host and port when no remote endpoint is set', async () => {
    const { manager, factory } = setupWithTunnel();
    await manager.connect(
      config('a', {
        host: 'db.internal',
        port: 5432,
        ssh: { enabled: true, host: 'bastion', username: 'ops' },
      }),
    );

    assert.equal(factory.drivers[0].lastConfig?.profile.host, '127.0.0.1');
    assert.equal(factory.drivers[0].lastConfig?.profile.port, 41_000);
  });

  it('uses the engine default port when the profile has none', async () => {
    const { manager } = setupWithTunnel();
    const profile = config('a', {
      host: 'db.internal',
      port: undefined,
      ssh: { enabled: true, host: 'bastion', username: 'ops' },
    });
    await manager.connect(profile);
    assert.equal(manager.statusOf('a')?.state, 'connected');
  });

  it('reports CONFIG_ERROR when no remote port can be determined', async () => {
    const { manager, factory } = setupWithTunnel();
    factory.defaultPort = undefined;

    await assert.rejects(
      manager.connect(
        config('a', {
          host: 'db.internal',
          port: undefined,
          ssh: { enabled: true, host: 'bastion', username: 'ops' },
        }),
      ),
      (error: unknown) => (error as { code?: string }).code === 'CONFIG_ERROR',
    );
  });

  it('does not open a tunnel when SSH is disabled', async () => {
    const { manager, tunnels } = setupWithTunnel();
    await manager.connect(
      config('a', { ssh: { enabled: false, host: 'bastion', username: 'ops' } }),
    );
    assert.equal(tunnels.length, 0);
  });
});

describe('ConnectionManager: disconnect and status bookkeeping', () => {
  it('closes the driver and clears the session status', async () => {
    const { manager, factory } = setup();
    await manager.connect(config('a'));
    const driver = factory.drivers[0];

    await manager.disconnect('a');

    assert.equal(driver.disconnectCalls, 1);
    assert.equal(manager.isConnected('a'), false);
    assert.equal(manager.getDriver('a'), undefined);

    const status = manager.statusOf('a');
    assert.equal(status?.state, 'disconnected');
    assert.equal(status?.connectedAt, undefined);
    assert.equal(status?.latencyMs, undefined);
    assert.equal(status?.databaseCount, undefined);
  });

  it('ignores a disconnect for an unknown profile', async () => {
    const { manager } = setup();
    await manager.disconnect('nope');
    assert.equal(manager.statusOf('nope'), undefined);
  });

  it('is safe to disconnect twice', async () => {
    const { manager, factory } = setup();
    await manager.connect(config('a'));
    await manager.disconnect('a');
    await manager.disconnect('a');
    assert.equal(factory.drivers[0].disconnectCalls, 1);
  });

  it('reconnects a profile after a disconnect', async () => {
    const { manager, factory } = setup();
    await manager.connect(config('a'));
    await manager.disconnect('a');
    await manager.connect(config('a'));

    assert.equal(factory.drivers.length, 2, 'a fresh driver is created after disconnecting');
    assert.equal(manager.isConnected('a'), true);
  });

  it('disconnects every session at once', async () => {
    const { manager, factory } = setup();
    await manager.connect(config('a'));
    await manager.connect(config('b'));

    await manager.disconnectAll();

    assert.equal(factory.drivers.every((driver) => driver.disconnectCalls === 1), true);
    assert.equal(manager.allStatuses().every((status) => status.state === 'disconnected'), true);
  });

  it('reports every session through allStatuses', async () => {
    const { manager } = setup();
    await manager.connect(config('a'));
    await manager.connect(config('b'));

    assert.deepEqual(
      manager
        .allStatuses()
        .map((status) => status.id)
        .sort(),
      ['a', 'b'],
    );
  });

  it('updates the label and read-only flag without reconnecting', async () => {
    const { manager, factory } = setup();
    await manager.connect(config('a'));

    manager.refreshProfile({
      id: 'a',
      name: 'Renamed',
      engine: 'mysql',
      readOnly: true,
      createdAt: 0,
      updatedAt: 0,
    });

    assert.equal(manager.statusOf('a')?.name, 'Renamed');
    assert.equal(manager.statusOf('a')?.readOnly, true);
    assert.equal(factory.drivers[0].connectCalls, 1, 'a rename must not touch the socket');
  });

  it('does nothing when refreshing an unknown profile', () => {
    const { manager } = setup();
    manager.refreshProfile({ id: 'nope', name: 'x', engine: 'mysql', createdAt: 0, updatedAt: 0 });
    assert.equal(manager.statusOf('nope'), undefined);
  });
});

describe('ConnectionManager: test()', () => {
  it('reports success with latency and the database count, then cleans up', async () => {
    const { manager, factory } = setup();
    const result = await manager.test(config('t'));

    assert.equal(result.ok, true);
    assert.equal(result.latencyMs, 7);
    assert.equal(result.databaseCount, 2);
    assert.deepEqual(result.databases, ['app', 'reporting']);
    assert.equal(result.error, undefined);
    assert.equal(factory.drivers[0].disconnectCalls, 1, 'a test must not leak its socket');
  });

  it('never registers a session, so a test does not connect the profile', async () => {
    const { manager } = setup();
    await manager.test(config('t'));

    assert.equal(manager.getDriver('t'), undefined);
    assert.equal(manager.statusOf('t'), undefined);
    assert.equal(manager.allStatuses().length, 0);
  });

  it('retries cleanly and closes each attempt', async () => {
    const { manager, factory } = setup();
    await manager.test(config('t'));
    await manager.test(config('t'));

    assert.equal(factory.drivers.length, 2);
    assert.equal(factory.drivers.every((driver) => driver.disconnectCalls === 1), true);
  });

  it('reports a classified failure instead of throwing', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.connectError = new DbError('AUTH_FAILED', 'Access denied');
    factory.create = (): DatabaseDriver => driver;

    const result = await manager.test(config('t'));

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'AUTH_FAILED');
    assert.match(String(result.error?.message), /Access denied/);
    assert.equal(driver.disconnectCalls, 1);
  });

  it('reports a validation failure without opening anything', async () => {
    const { manager, factory } = setup();
    factory.validateProblems = ['A host is required.'];

    const result = await manager.test(config('t'));

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'CONFIG_ERROR');
    assert.equal(factory.drivers.length, 0);
  });

  it('reports DRIVER_NOT_FOUND for an unregistered engine', async () => {
    const { manager } = setup();
    const result = await manager.test(config('t', { engine: 'mongodb' }));
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'DRIVER_NOT_FOUND');
  });

  it('succeeds even when the account cannot enumerate databases', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.databasesError = new DbError('PERMISSION_DENIED', 'denied');
    factory.create = (): DatabaseDriver => driver;

    const result = await manager.test(config('t'));

    assert.equal(result.ok, true);
    assert.equal(result.databases, undefined);
    assert.equal(result.databaseCount, undefined);
  });

  it('closes the tunnel it opened for the test', async () => {
    const { manager, tunnels } = setupWithTunnel();
    const result = await manager.test(config('t', SSH_PROFILE));

    assert.equal(result.ok, true);
    assert.equal(tunnels.length, 1);
    assert.equal(tunnels[0].closed, true);
  });

  it('redacts a secret echoed back by the server in the test result', async () => {
    const { manager, factory } = setup();
    const driver = new FakeDriver();
    driver.connectError = new DbError('AUTH_FAILED', 'rejected pa55w0rd');
    factory.create = (): DatabaseDriver => driver;

    const result = await manager.test(config('t'));

    assert.equal(result.error?.message.includes('pa55w0rd'), false);
    assert.ok(String(result.error?.message).includes('***'));
  });
});




