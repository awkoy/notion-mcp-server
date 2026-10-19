import { createHash } from "node:crypto";
import { stableStringify } from "../utils/stable-json.js";

// A pending entry has no expiry: it is the only thing stopping a second copy
// of a batch that is still running, so neither the TTL sweep nor the size cap
// may drop it. It leaves the map through complete() or release().
type PendingEntry = {
  state: "pending";
  fingerprint: string;
};

type CompletedEntry = {
  state: "completed";
  fingerprint: string;
  result: unknown;
  expiresAt: number;
};

type CacheEntry = PendingEntry | CompletedEntry;

export type IdempotencyAdmission =
  | { action: "execute"; key: string; fingerprint: string }
  | { action: "deduplicated"; result: unknown }
  | { action: "conflict" }
  | { action: "pending" };

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 512;

const cache = new Map<string, CacheEntry>();

function evictExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.state === "completed" && entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size <= MAX_ENTRIES) return;
  // Oldest completed entries first (Map iteration is insertion order, and
  // complete() re-inserts).
  let overflow = cache.size - MAX_ENTRIES;
  for (const [key, entry] of cache) {
    if (overflow <= 0) break;
    if (entry.state !== "completed") continue;
    cache.delete(key);
    overflow--;
  }
}

function fingerprint(operation: string, items: unknown[], atomic: boolean): string {
  return createHash("sha256").update(stableStringify({ operation, items, atomic })).digest("hex");
}

export function begin(
  operation: string,
  idempotencyKey: string,
  items: unknown[],
  atomic: boolean
): IdempotencyAdmission {
  evictExpired(Date.now());

  const requestFingerprint = fingerprint(operation, items, atomic);
  const existing = cache.get(idempotencyKey);
  if (!existing) {
    cache.set(idempotencyKey, { state: "pending", fingerprint: requestFingerprint });
    return {
      action: "execute",
      key: idempotencyKey,
      fingerprint: requestFingerprint,
    };
  }

  if (existing.fingerprint !== requestFingerprint) {
    return { action: "conflict" };
  }
  if (existing.state === "pending") {
    return { action: "pending" };
  }
  return { action: "deduplicated", result: existing.result };
}

function ownsPending(key: string, requestFingerprint: string): boolean {
  const current = cache.get(key);
  return current?.state === "pending" && current.fingerprint === requestFingerprint;
}

export function complete(key: string, requestFingerprint: string, result: unknown): void {
  if (!ownsPending(key, requestFingerprint)) return;
  cache.delete(key);
  cache.set(key, {
    state: "completed",
    fingerprint: requestFingerprint,
    result,
    expiresAt: Date.now() + TTL_MS,
  });
}

/** Drop a pending entry without caching a result, so the same key can run again. */
export function release(key: string, requestFingerprint: string): void {
  if (ownsPending(key, requestFingerprint)) cache.delete(key);
}

export const _internal = { fingerprint, evictExpired, cache, MAX_ENTRIES, TTL_MS };
