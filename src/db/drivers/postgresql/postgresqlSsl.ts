/**
 * Maps the engine-agnostic `SslConfig` onto node-postgres' `ssl` option object.
 *
 * Pure by design: file contents are read through an injected reader, so this
 * module has no `fs` import and is fully unit-testable.
 */

import { DbError } from '../../errors';
import type { SslConfig } from '../../types';

export type SslFileReader = (filePath: string) => string;

export interface PostgresSslOptions {
  ca?: string;
  cert?: string;
  key?: string;
  /** `true` (default) validates the server certificate. */
  rejectUnauthorized: boolean;
  /** SNI / certificate name override. */
  servername?: string;
}

function optionalFile(
  filePath: string | undefined,
  readFile: SslFileReader,
  label: string,
): string | undefined {
  const trimmed = filePath?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return readFile(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DbError('TLS_ERROR', `Cannot read the ${label} file '${trimmed}': ${message}`, error);
  }
}

/**
 * Returns the `ssl` connection option for node-postgres, or `false` when SSL is
 * disabled (so the driver omits the `ssl` key entirely, like `psql` without
 * `sslmode=require`).
 */
export function loadPostgresSsl(
  ssl: SslConfig | undefined,
  readFile: SslFileReader,
): PostgresSslOptions | false {
  if (!ssl?.enabled) {
    return false;
  }
  const options: PostgresSslOptions = {
    rejectUnauthorized: ssl.verify !== false,
  };
  const ca = optionalFile(ssl.caFile, readFile, 'SSL CA');
  const cert = optionalFile(ssl.certFile, readFile, 'SSL certificate');
  const key = optionalFile(ssl.keyFile, readFile, 'SSL key');
  if (ca !== undefined) {
    options.ca = ca;
  }
  if (cert !== undefined) {
    options.cert = cert;
  }
  if (key !== undefined) {
    options.key = key;
  }
  const serverName = ssl.serverName?.trim();
  if (serverName) {
    options.servername = serverName;
  }
  return options;
}