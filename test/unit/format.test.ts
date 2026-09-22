import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { displayCell, safeStringify } from '../../src/util/format';

describe('safeStringify', () => {
  it('renders primitives', () => {
    assert.equal(safeStringify('abc'), 'abc');
    assert.equal(safeStringify(42), '42');
    assert.equal(safeStringify(true), 'true');
    assert.equal(safeStringify(null), 'null');
    assert.equal(safeStringify(undefined), 'undefined');
    assert.equal(safeStringify(7n), '7n');
  });

  it('summarises binary data instead of dumping it', () => {
    assert.equal(safeStringify(Buffer.from([1, 2, 3, 4])), '[4 bytes]');
    assert.equal(safeStringify(new Uint8Array(10)), '[10 bytes]');
  });

  it('renders an Error as name and message', () => {
    assert.equal(safeStringify(new TypeError('bad thing')), 'TypeError: bad thing');
  });

  it('renders a Date as ISO and reports an invalid one', () => {
    assert.equal(safeStringify(new Date('2024-05-06T07:08:09.000Z')), '2024-05-06T07:08:09.000Z');
    assert.equal(safeStringify(new Date('nonsense')), 'Invalid Date');
  });

  it('replaces circular references instead of throwing', () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    const rendered = safeStringify(value);
    assert.ok(rendered.includes('[Circular]'));
  });

  it('serialises nested bigint values', () => {
    assert.ok(safeStringify({ id: 5n }).includes('5n'));
  });

  it('truncates long output and reports how much was dropped', () => {
    const rendered = safeStringify('x'.repeat(50), 10);
    assert.ok(rendered.startsWith('x'.repeat(10)));
    assert.ok(rendered.includes('+40 chars'));
  });

  it('never throws on exotic values', () => {
    assert.equal(safeStringify(function named() {}), '[function named]');
    assert.equal(safeStringify(Symbol('s')), 'Symbol(s)');
  });
});

describe('displayCell', () => {
  it('distinguishes SQL NULL from the empty string', () => {
    assert.equal(displayCell(null), 'NULL');
    assert.equal(displayCell(''), '');
  });

  it('renders typical values as text', () => {
    assert.equal(displayCell(12), '12');
    assert.equal(displayCell('text'), 'text');
    assert.equal(displayCell(true), 'true');
  });

  it('renders a date as ISO', () => {
    assert.equal(displayCell(new Date('2024-01-01T00:00:00.000Z')), '2024-01-01T00:00:00.000Z');
  });

  it('summarises binary cells', () => {
    assert.equal(displayCell(Buffer.from([1, 2])), '<2 bytes>');
  });

  it('renders JSON-ish objects', () => {
    assert.ok(displayCell({ a: 1 }).includes('"a": 1'));
  });
});
