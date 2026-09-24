/**
 * Maps the engine-agnostic `SslConfig` onto tedious' TLS options.
 *
 * SQL Server negotiates TLS at login: `encrypt` demands it,
 * `trustServerCertificate` skips certificate validation (the counterpart of
 * `rejectUnauthorized: false` on other engines), and `cryptoCredentialsDetails`
 * carries CA / client-cert / key contents. Pure by design: file contents are
 * read through an injected reader, so this module has no `fs` import and is
 * fully unit-testable.
 */

import { DbError } from '../../errors';
import type { SslConfig } from '../../types';

export type SslFileReader = (filePath: string) => string;

export interface MssqlSslOptions {
  /** Demand TLS for the whole session. */
  encrypt: boolean;
  /** Accept any server certificate (no validation). */
  trustServerCertificate: boolean;
  /** Raw PEM buffers for a custom CA chain and/or client certificate. */
  cryptoCredentialsDetails?: {
    ca?: Buffer;
    cert?: Buffer;
    key?: Buffer;
  };
  /** SNI / certificate name override. */
  serverName?: string;
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
 * Builds the TLS portion of the tedious config. When SSL is disabled the
 * session still sets `encrypt: false` explicitly (tedious defaults to true),
 * so the connection never attempts TLS the user did not ask for.
 */
export function loadMssqlSsl(ssl: SslConfig | undefined, readFile: SslFileReader): MssqlSslOptions {
  const enabled = ssl?.enabled === true;
  const details: MssqlSslOptions = {
    encrypt: enabled,
    trustServerCertificate: enabled && ssl?.verify === false,
  };
  if (!enabled) {
    return details;
  }

  const ca = optionalFile(ssl?.caFile, readFile, 'SSL CA');
  const cert = optionalFile(ssl?.certFile, readFile, 'SSL certificate');
  const key = optionalFile(ssl?.keyFile, readFile, 'SSL key');
  if (ca !== undefined || cert !== undefined || key !== undefined) {
    details.cryptoCredentialsDetails = {};
    if (ca !== undefined) {
      details.cryptoCredentialsDetails.ca = Buffer.from(ca, 'utf8');
    }
    if (cert !== undefined) {
      details.cryptoCredentialsDetails.cert = Buffer.from(cert, 'utf8');
    }
    if (key !== undefined) {
      details.cryptoCredentialsDetails.key = Buffer.from(key, 'utf8');
    }
  }
  const serverName = ssl?.serverName?.trim();
  if (serverName) {
    details.serverName = serverName;
  }
  return details;
}