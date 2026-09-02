import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { register } from "../src/operations/registry.js";
import type { OperationName, OperationDef } from "../src/operations/types.js";
import { dispatch, _internal } from "../src/dispatch/index.js";

// Register fake operations under names from the union so dispatch can find them.
// We use names that are reserved in the union but have no real handler conflict
// because we never import the real operations/index.js in this test file.

const FAKE_OP = "get_user" as OperationName; // reused name, no real op loaded here
const FAKE_BATCH_OP = "set_page_title" as OperationName;
const FAKE_NON_BATCH_OP = "search_pages" as OperationName;

const tracker: { created: string[]; rolledBack: string[] } = {
  created: [],
  rolledBack: [],
};

beforeAll(() => {
  // Single, validation + handler success
  const SingleSchema = z.object({ id: z.string() });
  const singleDef: OperationDef<z.infer<typeof SingleSchema>, { echo: string }> = {
    name: FAKE_OP,
    description: "fake single op",
    batchable: false,
    access: "read",
    domain: "pages",
    schema: SingleSchema,
    example: { id: "x" },
    handler: async ({ id }) => ({ ok: true, data: { echo: id } }),
  };
  register(singleDef);

  // Batchable with rollback support
  const BatchSchema = z.object({ value: z.number() });
  const batchDef: OperationDef<z.infer<typeof BatchSchema>, { id: string; value: number }> = {
    name: FAKE_BATCH_OP,
    description: "fake batch op",
    batchable: true,
    access: "write",
    domain: "pages",
    schema: BatchSchema,
    example: { value: 1 },
    rollback: async (data) => {
      const id = (data as { id?: string })?.id;
      if (id) tracker.rolledBack.push(id);
    },
    handler: async ({ value }) => {
      if (value < 0) {
        return { ok: false, error: { code: "negative", message: "no negatives" } };
      }
      const id = `created-${value}`;
      tracker.created.push(id);
      return { ok: true, data: { id, value } };
    },
  };
  register(batchDef);

  // Non-batchable op
  const NonBatchSchema = z.object({ q: z.string() });
  const nonBatchDef: OperationDef<z.infer<typeof NonBatchSchema>, unknown> = {
    name: FAKE_NON_BATCH_OP,
    description: "fake non-batch op",
    batchable: false,
    access: "read",
    domain: "pages",
    schema: NonBatchSchema,
    example: { q: "x" },
    handler: async ({ q }) => ({ ok: true, data: { q } }),
  };
  register(nonBatchDef);
});

describe("dispatch — unknown operation", () => {
  it("returns unknown_operation error with available list in fix", async () => {
    const res = await dispatch("nope_not_here", {});
    expect("ok" in res && res.ok).toBe(false);
    const err = (res as any).error;
    expect(err.code).toBe("unknown_operation");
    expect(err.fix).toMatch(/Available/);
  });
});

describe("dispatch — single op", () => {
  it("returns handler output when payload validates", async () => {
    const res = await dispatch(FAKE_OP, { id: "abc" });
    expect(res).toEqual({ ok: true, data: { echo: "abc" } });
  });

  it("returns validation_error envelope with schema + example on bad payload", async () => {
    const res = await dispatch(FAKE_OP, { wrong: "field" });
    expect((res as any).ok).toBe(false);
    const err = (res as any).error;
    expect(err.code).toBe("validation_error");
    expect(err.schema).toBeDefined();
    expect(err.example).toEqual({ id: "x" });
    expect(err.operation).toBe(FAKE_OP);
  });
});

describe("dispatch — batch", () => {
  it("rejects batch on non-batchable op with not_batchable error", async () => {
    const res = await dispatch(FAKE_NON_BATCH_OP, { items: [{ q: "a" }] });
    expect((res as any).ok).toBe(false);
    expect((res as any).error.code).toBe("not_batchable");
  });

  it("returns per-item results with summary on partial success (non-atomic)", async () => {
    const res = await dispatch(FAKE_BATCH_OP, {
      items: [{ value: 10 }, { value: -1 }, { value: 5 }],
    });
    expect((res as any).summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
    expect((res as any).ok).toBe(false);
    const results = (res as any).results;
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[2].ok).toBe(true);
  });

  it("rolls back created entities in atomic mode when a later item fails", async () => {
    tracker.created.length = 0;
    tracker.rolledBack.length = 0;
    const res = await dispatch(FAKE_BATCH_OP, {
      items: [{ value: 100 }, { value: 101 }, { value: -1 }, { value: 102 }],
      atomic: true,
      concurrency: 1,
    });
    expect((res as any).ok).toBe(false);
    const rolledBack = (res as any).rolled_back;
    expect(rolledBack).toBeGreaterThanOrEqual(2);
    expect(tracker.rolledBack).toEqual(
      expect.arrayContaining(["created-100", "created-101"])
    );
  });

  it("dedupes batch invocations sharing the same idempotency_key", async () => {
    const key = `key-${Date.now()}`;
    tracker.created.length = 0;
    const first = await dispatch(FAKE_BATCH_OP, {
      items: [{ value: 200 }],
      idempotency_key: key,
    });
    const createdAfterFirst = tracker.created.length;
    const second = await dispatch(FAKE_BATCH_OP, {
      items: [{ value: 200 }],
      idempotency_key: key,
    });
    // Same cached result is returned and no new side effects ran.
    expect(second).toEqual(first);
    expect(tracker.created.length).toBe(createdAfterFirst);
  });
});

describe("unknown top-level fields are ignored with a warning, not rejected", () => {
  it("runs the call and names the ignored field and the accepted ones", async () => {
    const res = await dispatch(FAKE_OP, { id: "abc", object: "page" });
    expect(res).toEqual({
      ok: true,
      data: { echo: "abc" },
      warnings: ['Ignored unknown field "object". get_user accepts: id.'],
    });
  });

  it("lists several unknown fields in one warning", async () => {
    const res = await dispatch(FAKE_OP, { id: "abc", a: 1, b: 2 });
    expect((res as { warnings?: string[] }).warnings).toEqual([
      'Ignored unknown fields "a", "b". get_user accepts: id.',
    ]);
  });

  it("adds no warnings key when every field is known", async () => {
    const res = await dispatch(FAKE_OP, { id: "abc" });
    expect(res).not.toHaveProperty("warnings");
  });

  it("warns per batch item and on the envelope", async () => {
    const res = await dispatch(FAKE_BATCH_OP, {
      items: [{ value: 1, extra: true }, { value: 2 }],
      atomic: false,
      parallel: 4,
    });
    const batch = res as {
      ok: boolean;
      warnings?: string[];
      results: { ok: boolean; warnings?: string[] }[];
    };
    expect(batch.ok).toBe(true);
    expect(batch.results[0].warnings).toEqual([
      'Ignored unknown field "extra". set_page_title accepts: value.',
    ]);
    expect(batch.results[1]).not.toHaveProperty("warnings");
    expect(batch.warnings).toEqual([
      'Ignored unknown batch field "parallel". A batch payload accepts: items, atomic, concurrency, idempotency_key.',
    ]);
  });

  it("does not attach warnings to a failed call", async () => {
    const res = await dispatch(FAKE_BATCH_OP, { items: [{ value: -1, extra: true }] });
    const item = (res as { results: Record<string, unknown>[] }).results[0];
    expect(item.ok).toBe(false);
    expect(item).not.toHaveProperty("warnings");
  });

  it("reads the accepted keys through preprocess and optional wrappers, and gives up on loose objects", () => {
    const { acceptedKeys } = _internal;
    expect(acceptedKeys(z.object({ a: z.string(), b: z.number().optional() }))).toEqual(["a", "b"]);
    expect(acceptedKeys(z.preprocess((v) => v, z.object({ page_id: z.string() })))).toEqual(["page_id"]);
    expect(acceptedKeys(z.object({ a: z.string() }).refine(() => true))).toEqual(["a"]);
    expect(acceptedKeys(z.object({ a: z.string() }).optional())).toEqual(["a"]);
    expect(acceptedKeys(z.looseObject({ a: z.string() }))).toBeUndefined();
    expect(acceptedKeys(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]))).toBeUndefined();
    expect(acceptedKeys(z.string())).toBeUndefined();
  });
});
