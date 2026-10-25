import { afterEach, describe, expect, it, vi } from "vitest";
import { _internal, begin, complete, release } from "../src/dispatch/idempotency.js";

describe("idempotency admission", () => {
  it("reports an identical in-flight request as pending", () => {
    const key = "unit-pending-key";
    const first = begin("set_page_title", key, [{ value: 1 }], false);
    expect(first.action).toBe("execute");

    const second = begin("set_page_title", key, [{ value: 1 }], false);
    expect(second).toEqual({ action: "pending" });
  });

  it("binds a key to operation, items and atomic mode but not concurrency", () => {
    const key = "unit-binding-key";
    const first = begin("set_page_title", key, [{ b: 2, a: 1 }], false);
    if (first.action !== "execute") throw new Error("expected execute");

    complete(first.key, first.fingerprint, { ok: true });

    expect(begin("set_page_title", key, [{ a: 1, b: 2 }], false).action).toBe(
      "deduplicated"
    );
    expect(begin("set_page_title", key, [{ a: 1, b: 3 }], false).action).toBe(
      "conflict"
    );
    expect(begin("set_page_title", key, [{ a: 1, b: 2 }], true).action).toBe(
      "conflict"
    );
    expect(begin("archive_page", key, [{ a: 1, b: 2 }], false).action).toBe(
      "conflict"
    );
  });

  it("canonicalizes object keys deterministically", () => {
    expect(
      _internal.fingerprint("set_page_title", [{ z: 1, a: { d: 4, b: 2 } }], false)
    ).toBe(
      _internal.fingerprint("set_page_title", [{ a: { b: 2, d: 4 }, z: 1 }], false)
    );
  });

  it("release lets the same key run again", () => {
    const key = "unit-release-key";
    const first = begin("set_page_title", key, [{ value: 1 }], false);
    if (first.action !== "execute") throw new Error("expected execute");
    release(first.key, first.fingerprint);
    expect(begin("set_page_title", key, [{ value: 2 }], false).action).toBe("execute");
  });
});

describe("idempotency eviction never drops a running batch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a pending key past the TTL", () => {
    vi.useFakeTimers();
    const key = "unit-slow-batch";
    expect(begin("set_page_title", key, [{ value: 1 }], false).action).toBe("execute");
    vi.advanceTimersByTime(_internal.TTL_MS * 2);
    expect(begin("set_page_title", key, [{ value: 1 }], false)).toEqual({ action: "pending" });
  });

  it("keeps a pending key when the cache overflows, dropping the oldest completed ones", () => {
    const running = "unit-running-under-pressure";
    expect(begin("set_page_title", running, [{ value: 1 }], false).action).toBe("execute");
    const firstDone = "unit-overflow-0";
    for (let i = 0; i <= _internal.MAX_ENTRIES + 5; i++) {
      const admission = begin("set_page_title", `unit-overflow-${i}`, [{ value: i }], false);
      if (admission.action !== "execute") throw new Error("expected execute");
      complete(admission.key, admission.fingerprint, { ok: true });
    }
    _internal.evictExpired(Date.now());
    expect(_internal.cache.size).toBeLessThanOrEqual(_internal.MAX_ENTRIES);
    expect(begin("set_page_title", running, [{ value: 1 }], false)).toEqual({ action: "pending" });
    expect(begin("set_page_title", firstDone, [{ value: 0 }], false).action).toBe("execute");
  });
});
