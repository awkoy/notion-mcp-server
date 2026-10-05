import { createHash } from "node:crypto";

type PendingEntry = {
  state: "pending";
  fingerprint: string;
  expiresAt: number;
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
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size <= MAX_ENTRIES) return;
  let overflow = cache.size - MAX_ENTRIES;
  for (const key of cache.keys()) {
    if (overflow-- <= 0) break;
    cache.delete(key);
  }
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (
        member === undefined ||
        typeof member === "function" ||
        typeof member === "symbol"
      ) {
        continue;
      }
      out[key] = canonicalize(member);
    }
    return out;
  }
  return String(value);
}

function fingerprint(operation: string, items: unknown[], atomic: boolean): string {
  const canonical = JSON.stringify(canonicalize({ operation, items, atomic }));
  return createHash("sha256").update(canonical).digest("hex");
}

export function begin(
  operation: string,
  idempotencyKey: string,
  items: unknown[],
  atomic: boolean
): IdempotencyAdmission {
  const now = Date.now();
  evictExpired(now);

  const requestFingerprint = fingerprint(operation, items, atomic);
  const existing = cache.get(idempotencyKey);
  if (!existing) {
    cache.set(idempotencyKey, {
      state: "pending",
      fingerprint: requestFingerprint,
      expiresAt: now + TTL_MS,
    });
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

export function complete(key: string, requestFingerprint: string, result: unknown): void {
  const current = cache.get(key);
  if (
    !current ||
    current.state !== "pending" ||
    current.fingerprint !== requestFingerprint
  ) {
    return;
  }
  cache.set(key, {
    state: "completed",
    fingerprint: requestFingerprint,
    result,
    expiresAt: Date.now() + TTL_MS,
  });
}

export const _internal = { canonicalize, fingerprint };
