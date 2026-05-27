type CacheEntry = { result: unknown; expiresAt: number };

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 512;

const cache = new Map<string, CacheEntry>();

function evictExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size > MAX_ENTRIES) {
    const overflow = cache.size - MAX_ENTRIES;
    let removed = 0;
    for (const key of cache.keys()) {
      if (removed >= overflow) break;
      cache.delete(key);
      removed++;
    }
  }
}

export function lookup(key: string): unknown | undefined {
  const now = Date.now();
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  return entry.result;
}

export function store(key: string, result: unknown): void {
  const now = Date.now();
  evictExpired(now);
  cache.set(key, { result, expiresAt: now + TTL_MS });
}

export function buildKey(operation: string, idempotencyKey: string): string {
  return `${operation}::${idempotencyKey}`;
}
