import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectionManager } from '../../src/connections/connectionManager';
import { DriverRegistry } from '../../src/db/driverRegistry';
import type { DriverFactory } from '../../src/db/driverRegistry';
import { registerBuiltinDrivers } from '../../src/db/drivers';
import { NULL_LOGGER } from '../../src/db/types';
import type {
  CancelToken,
  ColumnInfo,
  ConnectionConfig,
  ConnectionProfile,
  DatabaseDriver,
  QueryExecutionResult,
  TableDataPage,
  TableInfo,
} from '../../src/db/types';

class CapturingDriver implements DatabaseDriver {
  readonly engine: DatabaseDriver['engine'] = 'mysql';
  readonly capabilities = {
    schemas: false,
    multipleDatabases: true,
    views: true,
    routines: true,
    editableData: false,
    serverSidePagination: true,
    countRows: false,
    transactions: true,
    ssl: true,
    sshTunnel: true,
  };
  lastDepsAssetsDir: string | undefined;

  async connect(): Promise<void> {
    /* no socket */
  }
  async disconnect(): Promise<void> {
    /* no socket */
  }
  async ping(): Promise<number> {
    return 1;
  }
  isConnected(): boolean {
    return true;
  }
  async listDatabases(): Promise<string[]> {
    return [];
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
    throw new Error('unused');
  }
  async getTableData(): Promise<TableDataPage> {
    throw new Error('unused');
  }
}

class CapturingFactory implements DriverFactory {
  readonly engine = 'mysql' as const;
  readonly label = 'Capturing';
  readonly status = 'stable' as const;
  readonly capabilities = new CapturingDriver().capabilities;
  readonly drivers: CapturingDriver[] = [];

  create(_config: ConnectionConfig, deps: { logger: unknown; assetsDir?: string }): DatabaseDriver {
    const driver = new CapturingDriver();
    this.drivers.push(driver);
    driver.lastDepsAssetsDir = deps.assetsDir;
    return driver;
  }
}

function profile(engine: 'mysql' | 'sqlite' = 'mysql'): ConnectionProfile {
  return {
    id: 'p1',
    name: 'p1',
    engine,
    host: 'localhost',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('ConnectionManager asset-directory threading', () => {
  it('passes an explicit assetsDir through to the driver on connect', async () => {
    const factory = new CapturingFactory();
    const registry = new DriverRegistry('test');
    registry.register(factory);
    const manager = new ConnectionManager({
      registry,
      logger: NULL_LOGGER,
      assetsDir: 'C:/ext/dist',
    });

    await manager.connect({ profile: profile(), secrets: {} });

    assert.equal(factory.drivers.length, 1);
    assert.equal(factory.drivers[0].lastDepsAssetsDir, 'C:/ext/dist');
  });

  it('passes the assetsDir through on the test() path too', async () => {
    const factory = new CapturingFactory();
    const registry = new DriverRegistry('test');
    registry.register(factory);
    const manager = new ConnectionManager({
      registry,
      logger: NULL_LOGGER,
      assetsDir: 'C:/ext/dist',
    });

    await manager.test({ profile: profile(), secrets: {} });

    assert.equal(factory.drivers.length, 1);
    assert.equal(factory.drivers[0].lastDepsAssetsDir, 'C:/ext/dist');
  });

  it('falls back to a non-empty absolute default when the option is absent', async () => {
    const factory = new CapturingFactory();
    const registry = new DriverRegistry('test');
    registry.register(factory);
    const manager = new ConnectionManager({ registry, logger: NULL_LOGGER });

    await manager.connect({ profile: profile(), secrets: {} });

    const passed = factory.drivers[0].lastDepsAssetsDir;
    assert.ok(passed !== undefined && passed.length > 0);
    assert.equal(require('node:path').isAbsolute(passed), true);
  });

  it('still works end to end with the builtin registry wiring', async () => {
    const registry = new DriverRegistry('test');
    registerBuiltinDrivers(registry);
    assert.equal(registry.size, 3);

    const manager = new ConnectionManager({ registry, logger: NULL_LOGGER, assetsDir: 'x' });
    // MySQL driver exists; connecting to a dead port classifies the failure.
    const result = await manager.test({ profile: profile('mysql'), secrets: {} });
    assert.equal(result.ok, false);
    assert.ok(result.error !== undefined);
  });
});

// Token kept in scope for signature parity with the manager API.
export type { CancelToken };
