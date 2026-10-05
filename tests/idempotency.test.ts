import { describe, expect, it } from "vitest";
import { _internal, begin, complete } from "../src/dispatch/idempotency.js";

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
});
