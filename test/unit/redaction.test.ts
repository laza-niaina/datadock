import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MASK, Redactor, redactPatterns } from '../../src/util/redaction';

describe('Redactor: registered literal secrets', () => {
  it('masks a registered password wherever it appears', () => {
    const redactor = new Redactor();
    redactor.addSecret('s3cr3t-pass');
    assert.equal(redactor.redact('access denied for s3cr3t-pass'), `access denied for ${MASK}`);
  });

  it('masks every occurrence, not only the first', () => {
    const redactor = new Redactor();
    redactor.addSecret('topsecret');
    assert.equal(redactor.redact('topsecret and topsecret'), `${MASK} and ${MASK}`);
  });

  it('ignores values shorter than three characters', () => {
    const redactor = new Redactor();
    redactor.addSecret('ab');
    redactor.addSecret('');
    redactor.addSecret(undefined);
    assert.equal(redactor.size, 0);
    assert.equal(redactor.redact('ab'), 'ab');
  });

  it('masks the longest secret first so a containing secret cannot leak a suffix', () => {
    const redactor = new Redactor();
    redactor.addSecret('hunter2');
    redactor.addSecret('hunter2-extended');
    assert.equal(redactor.redact('key: hunter2-extended'), `key: ${MASK}`);
  });

  it('forgets a secret when asked, and reports whether it knew it', () => {
    const redactor = new Redactor();
    redactor.addSecret('hunter2');
    assert.equal(redactor.deleteSecret('hunter2'), true);
    assert.equal(redactor.deleteSecret('hunter2'), false);
    assert.equal(redactor.redact('hunter2'), 'hunter2');
  });
});

describe('Redactor: pattern based masking', () => {
  it('masks credentials embedded in a connection URI', () => {
    assert.equal(
      redactPatterns('mysql://root:pa55w0rd@db.internal:3306/orders'),
      `mysql://root:${MASK}@db.internal:3306/orders`,
    );
  });

  it('masks key/value credentials', () => {
    assert.equal(redactPatterns('password=pa55w0rd host=db'), `password=${MASK} host=db`);
    assert.equal(redactPatterns('PWD: pa55w0rd'), `PWD: ${MASK}`);
    assert.equal(redactPatterns('api_key="abc123"'), `api_key="${MASK}"`);
  });

  it('masks libpq style query parameters', () => {
    assert.equal(redactPatterns('postgres://h/db?user=r&password=pa55&ssl=true'), `postgres://h/db?user=r&password=${MASK}&ssl=true`);
  });

  it('masks SQL IDENTIFIED BY clauses', () => {
    assert.equal(
      redactPatterns("CREATE USER bob IDENTIFIED BY 'pa55'"),
      `CREATE USER bob IDENTIFIED BY '${MASK}'`,
    );
  });

  it('masks SQL PASSWORD literals', () => {
    assert.equal(redactPatterns("ALTER USER bob PASSWORD 'pa55'"), `ALTER USER bob PASSWORD '${MASK}'`);
  });

  it('masks PEM private key blocks', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const result = redactPatterns(`key material: ${pem}`);
    assert.ok(!result.includes('MIIEowIBAAKCAQEA1234'), 'the key body must be gone');
    assert.ok(result.includes(MASK));
  });

  it('masks Authorization headers', () => {
    assert.equal(redactPatterns('Authorization: Bearer eyJhbGciOi'), `Authorization: ${MASK}`);
  });

  it('leaves ordinary text untouched', () => {
    const text = 'SELECT id, name FROM users WHERE name LIKE \'%a%\' LIMIT 10';
    assert.equal(redactPatterns(text), text);
  });
});

describe('Redactor: deep redaction of structures', () => {
  it('masks values under sensitive keys and keeps the rest', () => {
    const redactor = new Redactor();
    const result = redactor.redactDeep({
      user: 'root',
      password: 'pa55w0rd',
      nested: { sshPassword: 'pa55w0rd2', host: 'db.internal' },
      list: ['ok', { privateKey: 'secret' }],
    });

    assert.deepEqual(result, {
      user: 'root',
      password: MASK,
      nested: { sshPassword: MASK, host: 'db.internal' },
      list: ['ok', { privateKey: MASK }],
    });
  });

  it('redacts secrets that reached an Error message', () => {
    const redactor = new Redactor();
    redactor.addSecret('pa55w0rd');
    const result = redactor.redactDeep({ failure: new Error('login failed for pa55w0rd') });
    assert.deepEqual(result, { failure: `login failed for ${MASK}` });
  });

  it('survives circular structures', () => {
    const redactor = new Redactor();
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;
    const result = redactor.redactDeep({ node }) as { node: Record<string, unknown> };
    assert.equal(result.node.name, 'root');
    assert.equal(result.node.self, MASK);
  });

  it('preserves bigint, Date and Buffer values', () => {
    const redactor = new Redactor();
    const when = new Date('2024-01-02T03:04:05.000Z');
    const bytes = Buffer.from('abc');
    const result = redactor.redactDeep({ id: 10n, when, bytes }) as {
      id: bigint;
      when: Date;
      bytes: Buffer;
    };
    assert.equal(result.id, 10n);
    assert.equal(result.when.getTime(), when.getTime());
    assert.equal(result.bytes.toString(), 'abc');
  });
});
