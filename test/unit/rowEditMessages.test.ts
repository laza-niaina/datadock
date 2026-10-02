import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_COLUMN_NAME,
  MAX_EDIT_TEXT,
  MAX_INSERT_COLUMNS,
  toEditIntent,
  toEditValue,
} from '../../src/ui/rowEditMessages';

describe('toEditValue', () => {
  it('accepts bounded text, finite numbers and NULL', () => {
    assert.equal(toEditValue('Ada'), 'Ada');
    assert.equal(toEditValue(''), '');
    assert.equal(toEditValue(42), 42);
    assert.equal(toEditValue(0), 0);
    assert.equal(toEditValue(null), null);
  });

  it('refuses every shape a text box cannot honestly send', () => {
    assert.equal(toEditValue(undefined), undefined);
    assert.equal(toEditValue(true), undefined);
    assert.equal(toEditValue(Number.NaN), undefined);
    assert.equal(toEditValue(Number.POSITIVE_INFINITY), undefined);
    assert.equal(toEditValue({}), undefined);
    assert.equal(toEditValue([1]), undefined);
    assert.equal(toEditValue('x'.repeat(MAX_EDIT_TEXT + 1)), undefined);
  });
});

describe('toEditIntent', () => {
  it('narrows an update carrying the echoed revision', () => {
    assert.deepEqual(
      toEditIntent({ type: 'update', revision: 3, row: 0, column: 'label', value: 'Grace' }),
      { kind: 'update', revision: 3, row: 0, column: 'label', value: 'Grace' },
    );
    assert.deepEqual(
      toEditIntent({ type: 'delete', revision: 1, row: 12 }),
      { kind: 'delete', revision: 1, row: 12 },
    );
    assert.deepEqual(
      toEditIntent({ type: 'insert', revision: 2, values: { label: 'Ada', org_id: 7 } }),
      { kind: 'insert', revision: 2, values: { label: 'Ada', org_id: 7 } },
    );
  });

  it('carries a NULL write through', () => {
    assert.deepEqual(
      toEditIntent({ type: 'update', revision: 4, row: 1, column: 'label', value: null }),
      { kind: 'update', revision: 4, row: 1, column: 'label', value: null },
    );
  });

  it('refuses a message without the revision echo', () => {
    assert.equal(toEditIntent({ type: 'update', row: 0, column: 'label', value: 'x' }), undefined);
    assert.equal(
      toEditIntent({ type: 'update', revision: '3', row: 0, column: 'label', value: 'x' }),
      undefined,
    );
    assert.equal(
      toEditIntent({ type: 'update', revision: -1, row: 0, column: 'label', value: 'x' }),
      undefined,
    );
    assert.equal(
      toEditIntent({ type: 'update', revision: 1.5, row: 0, column: 'label', value: 'x' }),
      undefined,
    );
  });

  it('refuses a row index the grid could not have rendered', () => {
    const base = { type: 'update', revision: 1, column: 'label', value: 'x' };
    assert.equal(toEditIntent({ ...base, row: -1 }), undefined);
    assert.equal(toEditIntent({ ...base, row: 2.5 }), undefined);
    assert.equal(toEditIntent({ ...base, row: '0' }), undefined);
    assert.equal(toEditIntent({ ...base }), undefined);
  });

  it('refuses a column name the host never rendered', () => {
    const base = { type: 'update', revision: 1, row: 0, value: 'x' };
    assert.equal(toEditIntent({ ...base, column: '' }), undefined);
    assert.equal(toEditIntent({ ...base, column: 42 }), undefined);
    assert.equal(toEditIntent({ ...base, column: 'a\0b' }), undefined);
    assert.equal(toEditIntent({ ...base, column: 'x'.repeat(MAX_COLUMN_NAME + 1) }), undefined);
  });

  it('refuses an insert whose values are not plain cell values', () => {
    // An empty object is still a well-formed intent: the host refuses it with
    // a message the user can read, instead of silently doing nothing.
    assert.deepEqual(toEditIntent({ type: 'insert', revision: 1, values: {} }), {
      kind: 'insert',
      revision: 1,
      values: {},
    });
    assert.equal(toEditIntent({ type: 'insert', revision: 1, values: [] }), undefined);
    assert.equal(toEditIntent({ type: 'insert', revision: 1 }), undefined);
    assert.equal(
      toEditIntent({ type: 'insert', revision: 1, values: { label: true } }),
      undefined,
    );
    assert.equal(
      toEditIntent({ type: 'insert', revision: 1, values: { '': 'x' } }),
      undefined,
    );

    const many: Record<string, string> = {};
    for (let index = 0; index <= MAX_INSERT_COLUMNS; index += 1) {
      many[`c${index}`] = 'x';
    }
    assert.equal(toEditIntent({ type: 'insert', revision: 1, values: many }), undefined);
  });

  it('refuses a message that is not one this host rendered', () => {
    assert.equal(toEditIntent(undefined), undefined);
    assert.equal(toEditIntent(null), undefined);
    assert.equal(toEditIntent('update'), undefined);
    assert.equal(toEditIntent([1, 2, 3]), undefined);
    assert.equal(toEditIntent({ type: 'ready', revision: 1 }), undefined);
    assert.equal(toEditIntent({ type: 'export', revision: 1, format: 'csv' }), undefined);
  });
});
