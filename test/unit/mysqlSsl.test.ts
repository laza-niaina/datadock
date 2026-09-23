import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadMysqlSsl } from '../../src/db/drivers/mysql/mysqlSsl';
import type { SslConfig } from '../../src/db/types';

function fakeReader(content = 'PEM-DATA'): (filePath: string) => string {
  return (filePath) => {
    if (filePath.includes('missing')) {
      throw new Error('ENOENT: no such file');
    }
    return `${content}(${filePath})`;
  };
}

describe('loadMysqlSsl', () => {
  it('returns undefined when SSL is disabled or absent', () => {
    const reader = fakeReader();
    assert.equal(loadMysqlSsl(undefined, reader), undefined);
    assert.equal(loadMysqlSsl({ enabled: false }, reader), undefined);
  });

  it('enables verification by default', () => {
    const options = loadMysqlSsl({ enabled: true }, fakeReader());
    assert.deepEqual(options, { rejectUnauthorized: true });
  });

  it('accepts self-signed certificates when verification is off', () => {
    const options = loadMysqlSsl({ enabled: true, verify: false }, fakeReader());
    assert.deepEqual(options, { rejectUnauthorized: false });
  });

  it('loads ca, cert and key files through the injected reader', () => {
    const options = loadMysqlSsl(
      { enabled: true, caFile: '/pki/ca.pem', certFile: '/pki/cert.pem', keyFile: '/pki/key.pem' },
      fakeReader(),
    );
    assert.equal(options?.ca, 'PEM-DATA(/pki/ca.pem)');
    assert.equal(options?.cert, 'PEM-DATA(/pki/cert.pem)');
    assert.equal(options?.key, 'PEM-DATA(/pki/key.pem)');
    assert.equal(options?.rejectUnauthorized, true);
  });

  it('treats blank file paths as absent', () => {
    const read: string[] = [];
    const options = loadMysqlSsl(
      { enabled: true, caFile: '   ', certFile: '', keyFile: undefined },
      (filePath) => {
        read.push(filePath);
        return 'x';
      },
    );
    assert.deepEqual(read, []);
    assert.deepEqual(options, { rejectUnauthorized: true });
  });

  it('passes the SNI / certificate name override through', () => {
    const options = loadMysqlSsl({ enabled: true, serverName: ' db.example.com ' }, fakeReader());
    assert.equal(options?.servername, 'db.example.com');
  });

  it('reports an unreadable certificate file as TLS_ERROR with the path', () => {
    try {
      loadMysqlSsl({ enabled: true, caFile: '/pki/missing-ca.pem' }, fakeReader());
      assert.fail('expected loadMysqlSsl to throw');
    } catch (error) {
      assert.equal((error as { code?: string }).code, 'TLS_ERROR');
      assert.match((error as Error).message, /missing-ca\.pem/);
      assert.match((error as Error).message, /ENOENT/);
    }
  });
});

// Type-only import kept honest: SslConfig is the source of the shape.
export type SslConfigAlias = SslConfig;
