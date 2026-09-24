import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MetadataCache } from '../../src/metadata/metadataCache';

/** Deterministic clock so TTL behaviour can be asserted without waiting. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('MetadataCache: basic behaviour', () => {
  it('stores and returns a value', () => {
    const cache = new MetadataCache();
    cache.set('a', [1, 2, 3]);
    assert.deepEqual(cache.get<number[]>('a'), [1, 2, 3]);
    assert.equal(cache.size, 1);
  });

  it('returns undefined for an unknown key', () => {
    assert.equal(new MetadataCache().get('missing'), undefined);
  });

  it('expires an entry once the TTL elapses', () => {
    const time = clock();
    const cache = new MetadataCache({ ttlMs: 1_000, now: time.now });

    cache.set('tables', ['users']);
    time.advance(999);
    assert.deepEqual(cache.get<string[]>('tables'), ['users']);

    time.advance(1);
    assert.equal(cache.get('tables'), undefined);
    assert.equal(cache.size, 0, 'an expired entry must be dropped, not merely ignored');
  });

  it('keeps entries for ever when the TTL is zero', () => {
    const time = clock();
    const cache = new MetadataCache({ ttlMs: 0, now: time.now });
    cache.set('tables', ['users']);

    time.advance(10_000_000);
    assert.deepEqual(cache.get<string[]>('tables'), ['users']);
  });

  it('applies a new TTL through setTtlSeconds', () => {
    const time = clock();
    const cache = new MetadataCache({ ttlMs: 1_000, now: time.now });
    cache.set('a', 1);

    cache.setTtlSeconds(2);
    assert.equal(cache.ttl, 2_000);

    cache.set('b', 2);
    time.advance(1_500);
    assert.equal(cache.get('a'), undefined, 'the pre-existing entry keeps its earlier deadline');
    assert.equal(cache.get('b'), 2);
  });
});

describe('MetadataCache: getOrLoad', () => {
  it('loads once and serves the cached value afterwards', async () => {
    const cache = new MetadataCache();
    let calls = 0;
    const loader = async (): Promise<string[]> => {
      calls += 1;
      return ['a'];
    };

    assert.deepEqual(await cache.getOrLoad('k', loader), ['a']);
    assert.deepEqual(await cache.getOrLoad('k', loader), ['a']);
    assert.equal(calls, 1);
  });

  it('shares a single in-flight load between concurrent callers', async () => {
    const cache = new MetadataCache();
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const loader = async (): Promise<number> => {
      calls += 1;
      await gate;
      return 42;
    };

    const first = cache.getOrLoad('k', loader);
    const second = cache.getOrLoad('k', loader);
    const third = cache.getOrLoad('k', loader);
    release?.();

    assert.deepEqual(await Promise.all([first, second, third]), [42, 42, 42]);
    assert.equal(calls, 1, 'expanding a node repeatedly must not multiply queries');
    assert.equal(cache.stats().inflight, 0);
  });

  it('does not cache a failure, so the next call retries', async () => {
    const cache = new MetadataCache();
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) {
        throw new Error('temporary failure');
      }
      return 'ok';
    };

    await assert.rejects(cache.getOrLoad('k', loader), /temporary failure/);
    assert.equal(cache.get('k'), undefined);
    assert.equal(await cache.getOrLoad('k', loader), 'ok');
    assert.equal(calls, 2);
  });
});

describe('MetadataCache: invalidation', () => {
  it('drops everything when called without a prefix', () => {
    const cache = new MetadataCache();
    cache.set('profile:1|databases', ['a']);
    cache.set('profile:2|databases', ['b']);

    assert.equal(cache.invalidate(), 2);
    assert.equal(cache.size, 0);
  });

  it('drops only the entries matching a prefix', () => {
    const cache = new MetadataCache();
    cache.set('profile:1|databases', ['a']);
    cache.set('profile:1|tables', ['t']);
    cache.set('profile:2|databases', ['b']);

    assert.equal(cache.invalidate('profile:1'), 2);
    assert.deepEqual(cache.get<string[]>('profile:2|databases'), ['b']);
  });

  it('reports a count of zero when nothing matched', () => {
    const cache = new MetadataCache();
    cache.set('profile:1', ['a']);
    assert.equal(cache.invalidate('profile:9'), 0);
  });
});

describe('MetadataCache: statistics and disposal', () => {
  it('counts hits and misses', () => {
    const cache = new MetadataCache();
    cache.set('a', 1);
    cache.get('a');
    cache.get('missing');
    cache.get('a');

    const stats = cache.stats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
  });

  it('clears everything on dispose', () => {
    const cache = new MetadataCache();
    cache.set('a', 1);
    cache.dispose();
    assert.equal(cache.size, 0);
  });
});
