/**
 * In-memory metadata cache.
 *
 * Design constraints
 *  - **Lazy**: entries appear only when the explorer actually asks for a node.
 *  - **Bounded by TTL**: a stale entry can never be served for ever, which was
 *    an explicit complaint about cache-based clients.
 *  - **De-duplicated**: concurrent loads for the same key share one promise, so
 *    rapidly expanding/collapsing the tree cannot multiply metadata queries.
 *  - **Invalidatable**: per connection, or per key prefix, on refresh, on
 *    disconnect and after a schema-changing statement.
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export interface MetadataCacheOptions {
  /**
   * Lifetime of an entry in milliseconds.
   * `0` means "no time based expiry" and relies purely on explicit
   * invalidation; the default is intentionally short.
   */
  ttlMs?: number;
  /** Injectable clock, used by tests. */
  now?: () => number;
}

export interface MetadataCacheStats {
  size: number;
  hits: number;
  misses: number;
  inflight: number;
}

export const DEFAULT_METADATA_TTL_MS = 5 * 60 * 1000;

export class MetadataCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private ttlMs: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;

  constructor(options: MetadataCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_METADATA_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get ttl(): number {
    return this.ttlMs;
  }

  /**
   * Applies a new lifetime. Existing entries keep their previous deadline, so a
   * shortened TTL takes effect as those entries expire; lowering it to `0` makes
   * them permanent until the next explicit invalidation.
   */
  setTtlSeconds(seconds: number): void {
    this.ttlMs = Math.max(0, Math.floor(seconds)) * 1000;
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (this.ttlMs > 0 && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.entries.set(key, {
      value,
      expiresAt: this.ttlMs > 0 ? this.now() + this.ttlMs : Number.POSITIVE_INFINITY,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Returns the cached value, or runs `loader` exactly once for concurrent
   * callers and caches the result.
   *
   * A rejected load is never cached, so a transient failure is retried on the
   * next access instead of being remembered.
   */
  async getOrLoad<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const promise = (async (): Promise<T> => {
      try {
        const value = await loader();
        this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Drops every entry whose key starts with `prefix`, or everything. */
  invalidate(prefix?: string): number {
    if (!prefix) {
      const removed = this.entries.size;
      this.entries.clear();
      return removed;
    }
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }

  stats(): MetadataCacheStats {
    return { size: this.entries.size, hits: this.hits, misses: this.misses, inflight: this.inflight.size };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  dispose(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
