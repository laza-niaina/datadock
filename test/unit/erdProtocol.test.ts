import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbError } from '../../src/db/errors';
import { describeErError, parseAppMessage } from '../../src/ui/erd/erdProtocol';

describe('parseAppMessage', () => {
  it('accepts the three no-payload handshakes', () => {
    assert.deepEqual(parseAppMessage({ type: 'ready' }), { type: 'ready' });
    assert.deepEqual(parseAppMessage({ type: 'reload' }), { type: 'reload' });
    assert.deepEqual(parseAppMessage({ type: 'positions', positions: null }), {
      type: 'positions',
      positions: null,
    });
  });

  it('keeps only string entries of a schema selection', () => {
    assert.deepEqual(parseAppMessage({ type: 'select', schemas: ['public', 7, null, 'billing'] }), {
      type: 'select',
      schemas: ['public', 'billing'],
    });
    // A selection that is not a list at all is not a selection.
    assert.equal(parseAppMessage({ type: 'select', schemas: 'public' }), undefined);
  });

  it('drops malformed, non-finite or non-object positions', () => {
    assert.deepEqual(
      parseAppMessage({
        type: 'positions',
        positions: {
          orders: { x: 10, y: -4 },
          broken: { x: Number.NaN, y: 0 },
          wrong: { x: '10', y: 0 },
          empty: {},
        },
      }),
      { type: 'positions', positions: { orders: { x: 10, y: -4 } } },
    );
    assert.equal(parseAppMessage({ type: 'positions', positions: 'orders' }), undefined);
    assert.equal(parseAppMessage({ type: 'positions' }), undefined);
  });

  it('rejects anything that is not one of the four shapes', () => {
    assert.equal(parseAppMessage(undefined), undefined);
    assert.equal(parseAppMessage(null), undefined);
    assert.equal(parseAppMessage('ready'), undefined);
    assert.equal(parseAppMessage(42), undefined);
    assert.equal(parseAppMessage([]), undefined);
    assert.equal(parseAppMessage({}), undefined);
    assert.equal(parseAppMessage({ type: 'openUrl', url: 'https://example.test' }), undefined);
  });
});

describe('describeErError', () => {
  it('turns a lost connection into an action a person can take', () => {
    const message = describeErError(new DbError('CONNECTION_LOST', 'not connected'));
    assert.match(message, /Reconnect/);
    assert.match(message, /DB Explorer/);
  });

  it('keeps the engine message for anything else', () => {
    assert.equal(
      describeErError(new DbError('QUERY_ERROR', 'relation "missing" does not exist')),
      'relation "missing" does not exist',
    );
    assert.equal(describeErError(new Error('socket closed')), 'socket closed');
  });

  it('falls back instead of rendering "undefined"', () => {
    assert.equal(describeErError(undefined), 'The diagram could not be loaded.');
    assert.equal(describeErError('boom'), 'The diagram could not be loaded.');
    assert.equal(describeErError(new Error('   ')), 'The diagram could not be loaded.');
  });
});
