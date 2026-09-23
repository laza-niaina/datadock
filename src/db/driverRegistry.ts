/**
 * Driver registry.
 *
 * Exactly one `DriverFactory` is registered per engine. The registry is the
 * single source of truth for *what this extension actually supports*: an engine
 * that has no registered factory is never offered in the connection wizard, so
 * the UI can never advertise unimplemented support.
 */

import { DbError } from './errors';
import type {
  ConnectionConfig,
  DatabaseDriver,
  DriverCapabilities,
  EngineId,
  EngineStatus,
  Logger,
} from './types';

export interface DriverDeps {
  readonly logger: Logger;
  /**
   * Directory holding runtime assets that cannot be bundled (currently
   * `sql-wasm.wasm`). Always filled in by `ConnectionManager`; drivers fall
   * back to the bundle directory when a caller constructs deps by hand.
   */
  readonly assetsDir?: string;
}

export interface DriverFactory {
  readonly engine: EngineId;
  /** Label shown in the connection wizard. */
  readonly label: string;
  readonly status: EngineStatus;
  readonly capabilities: DriverCapabilities;
  /** Default TCP port pre-filled by the wizard. */
  readonly defaultPort?: number;
  /** `true` when the engine stores data in a local file rather than a server. */
  readonly fileBased?: boolean;
  /** Fields the wizard must collect, in addition to the common ones. */
  readonly extraFields?: readonly string[];

  create(config: ConnectionConfig, deps: DriverDeps): DatabaseDriver;

  /** Synchronous, socket-free profile validation. Returns readable problems. */
  validate?(config: ConnectionConfig): string[];
}

export class DriverRegistry {
  private readonly factories = new Map<EngineId, DriverFactory>();

  constructor(private readonly label = 'driver registry') {}

  register(factory: DriverFactory): void {
    if (this.factories.has(factory.engine)) {
      throw new DbError('CONFIG_ERROR', `A driver for '${factory.engine}' is already registered.`);
    }
    this.factories.set(factory.engine, factory);
  }

  get(engine: EngineId): DriverFactory | undefined {
    return this.factories.get(engine);
  }

  /** Returns the factory or throws `DRIVER_NOT_FOUND`. */
  require(engine: EngineId): DriverFactory {
    const factory = this.factories.get(engine);
    if (!factory) {
      throw new DbError(
        'DRIVER_NOT_FOUND',
        `No driver is registered for engine '${engine}' in the ${this.label}.`,
      );
    }
    return factory;
  }

  /** Every registered factory, including any future `beta` entries. */
  all(): DriverFactory[] {
    return [...this.factories.values()];
  }

  /** Factories the connection wizard is allowed to offer. */
  available(): DriverFactory[] {
    return this.all().filter((factory) => factory.status !== 'planned');
  }

  isSupported(engine: EngineId): boolean {
    return this.factories.has(engine);
  }

  get size(): number {
    return this.factories.size;
  }
}

/**
 * Process-wide registry populated during activation.
 * Tests should build their own `new DriverRegistry()` instead of mutating this.
 */
export const driverRegistry = new DriverRegistry();
