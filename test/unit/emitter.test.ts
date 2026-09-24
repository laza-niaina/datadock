import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Emitter } from '../../src/util/emitter';

describe('Emitter', () => {
  it('delivers events to every listener', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    emitter.event((value) => seen.push(value));
    emitter.event((value) => seen.push(value * 10));

    emitter.fire(3);
    assert.deepEqual(seen, [3, 30]);
  });

  it('stops delivering after a listener is unsubscribed', () => {
    const emitter = new Emitter<string>();
    const seen: string[] = [];
    const subscription = emitter.event((value) => seen.push(value));

    emitter.fire('a');
    subscription.dispose();
    emitter.fire('b');

    assert.deepEqual(seen, ['a']);
    assert.equal(emitter.listenerCount, 0);
  });

  it('tolerates a listener unsubscribing another one mid-dispatch', () => {
    const emitter = new Emitter<void>();
    const seen: string[] = [];
    // Registered first so snapshot dispatch runs the disposer before the
    // second listener, which must still receive the event being fired.
    const subscriptions: Array<{ dispose(): void }> = [];
    emitter.event(() => {
      seen.push('first');
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
    });
    subscriptions.push(emitter.event(() => seen.push('second')));

    emitter.fire();
    assert.deepEqual(seen, ['first', 'second']);

    emitter.fire();
    assert.deepEqual(seen, ['first', 'second', 'first']);
  });

  it('delivers nothing after dispose', () => {
    const emitter = new Emitter<void>();
    let calls = 0;
    emitter.event(() => {
      calls += 1;
    });

    emitter.dispose();
    emitter.fire();
    assert.equal(calls, 0);
  });

  it('returns an inert subscription once disposed', () => {
    const emitter = new Emitter<void>();
    emitter.dispose();
    const subscription = emitter.event(() => undefined);
    assert.equal(typeof subscription.dispose, 'function');
  });
});
