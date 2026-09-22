import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DriverFactory } from '../../src/db/driverRegistry';
import { DriverRegistry } from '../../src/db/driverRegistry';
import type { DatabaseDriver, DriverCapabilities, EngineId, EngineStatus } from '../../src/db/types';

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

function fakeFactory(engine: EngineId, status: EngineStatus = 'stable'): DriverFactory {
  return {
    engine,
    label: `Fake ${engine}`,
    status,
    capabilities: CAPABILITIES,
    defaultPort: 1234,
    create: (): DatabaseDriver => {
      throw new Error('create() is not exercised by this test');
    },
  };
}

describe('DriverRegistry', () => {
  it('registers and retrieves a factory', () => {
    const registry = new DriverRegistry('test registry');
    const factory = fakeFactory('mysql');
    registry.register(factory);

    assert.equal(registry.get('mysql'), factory);
    assert.equal(registry.require('mysql'), factory);
    assert.equal(registry.isSupported('mysql'), true);
    assert.equal(registry.size, 1);
  });

  it('refuses a duplicate registration for the same engine', () => {
    const registry = new DriverRegistry();
    registry.register(fakeFactory('mysql'));
    assert.throws(() => registry.register(fakeFactory('mysql')), /already registered/);
  });

  it('reports DRIVER_NOT_FOUND for an engine without a driver', () => {
    const registry = new DriverRegistry();
    assert.equal(registry.get('postgresql'), undefined);
    assert.equal(registry.isSupported('postgresql'), false);
    assert.throws(
      () => registry.require('postgresql'),
      (error: unknown) => (error as { code?: string }).code === 'DRIVER_NOT_FOUND',
    );
  });

  it('hides planned engines from the wizard while still registering them', () => {
    const registry = new DriverRegistry();
    registry.register(fakeFactory('mysql', 'stable'));
    registry.register(fakeFactory('sqlite', 'beta'));
    registry.register(fakeFactory('mongodb', 'planned'));

    assert.equal(registry.size, 3);
    assert.deepEqual(
      registry.available().map((factory) => factory.engine),
      ['mysql', 'sqlite'],
    );
  });

  it('exposes every registered factory through all()', () => {
    const registry = new DriverRegistry();
    registry.register(fakeFactory('mysql'));
    registry.register(fakeFactory('postgresql', 'planned'));
    assert.deepEqual(
      registry.all().map((factory) => factory.engine),
      ['mysql', 'postgresql'],
    );
  });
});
