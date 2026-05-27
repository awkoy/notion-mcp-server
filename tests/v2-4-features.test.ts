import { describe, it, expect, beforeAll } from "vitest";
import { initOperations, getOperation } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

beforeAll(async () => {
  await initOperations();
});

describe("v2.4 — get_self alias", () => {
  it("registers get_self as an alias for get_bot_user", () => {
    const self = getOperation("get_self");
    const bot = getOperation("get_bot_user");
    expect(self).toBeDefined();
    expect(bot).toBeDefined();
    // Both should point at the same handler (alias-style registration).
    expect(self!.handler).toBe(bot!.handler);
  });
});

describe("v2.4 — set_page_property title shorthand", () => {
  it("accepts a bare string for name='title' and validates without error", () => {
    const def = getOperation("set_page_property")!;
    const parsed = def.schema.safeParse({
      page_id: "abc",
      name: "title",
      value: "Hello world",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // After preprocess, value should be the Notion title rich-text shape.
      const data = parsed.data as Record<string, unknown>;
      expect(data.value).toEqual({
        title: [{ type: "text", text: { content: "Hello world" } }],
      });
    }
  });

  it("leaves non-title values untouched", () => {
    const def = getOperation("set_page_property")!;
    const parsed = def.schema.safeParse({
      page_id: "abc",
      name: "Checked",
      value: { checkbox: true },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as Record<string, unknown>;
      expect(data.value).toEqual({ checkbox: true });
    }
  });
});

describe("v2.4 — set_page_properties title shorthand", () => {
  it("auto-wraps properties.title when it is a plain string", () => {
    const def = getOperation("set_page_properties")!;
    const parsed = def.schema.safeParse({
      page_id: "abc",
      properties: { title: "My title" },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const data = parsed.data as { properties: Record<string, unknown> };
      expect(data.properties.title).toEqual({
        title: [{ type: "text", text: { content: "My title" } }],
      });
    }
  });
});

describe("v2.4 — update_block: infer type from data key", () => {
  it("accepts `data: { paragraph: {...} }` without a separate `type` field", () => {
    const def = getOperation("update_block")!;
    const parsed = def.schema.safeParse({
      block_id: "abc",
      data: { paragraph: { rich_text: [{ type: "text", text: { content: "hi" } }] } },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("v2.4 — get_page include_properties", () => {
  it("accepts include_properties at the schema level", () => {
    const def = getOperation("get_page")!;
    const parsed = def.schema.safeParse({
      page_id: "abc",
      include_properties: true,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("v2.4 — batch_mixed_blocks wrong_envelope error", () => {
  it("returns wrong_envelope (not not_batchable) when called with items[]", async () => {
    const res = await dispatch("batch_mixed_blocks", {
      items: [{ block_id: "abc" }],
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    const err = (res as { error: { code: string; fix: string } }).error;
    expect(err.code).toBe("wrong_envelope");
    expect(err.fix).toMatch(/operations/);
  });
});

describe("v2.4 — upload_file source.type discriminator", () => {
  it("accepts source.type = 'base64'", () => {
    const def = getOperation("upload_file")!;
    const parsed = def.schema.safeParse({
      filename: "x.pdf",
      content_type: "application/pdf",
      source: { type: "base64", data: "AAAA" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts source.type = 'url'", () => {
    const def = getOperation("upload_file")!;
    const parsed = def.schema.safeParse({
      filename: "x.pdf",
      content_type: "application/pdf",
      source: { type: "url", url: "https://example.com/x.pdf" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects the legacy source.kind discriminator", () => {
    const def = getOperation("upload_file")!;
    const parsed = def.schema.safeParse({
      filename: "x.pdf",
      content_type: "application/pdf",
      source: { kind: "base64", data: "AAAA" },
    });
    expect(parsed.success).toBe(false);
  });

  it("makes mode optional (defaults to 'single')", () => {
    const def = getOperation("upload_file")!;
    const parsed = def.schema.safeParse({
      filename: "x.pdf",
      content_type: "application/pdf",
      source: { type: "base64", data: "AAAA" },
    });
    expect(parsed.success).toBe(true);
  });
});
