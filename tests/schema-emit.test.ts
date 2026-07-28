import { describe, it, expect } from "vitest";
import { BLOCK_INPUT_SCHEMA } from "../src/schema/blocks.js";
import { z } from "zod";
import { emitJsonSchema, registerSharedRef } from "../src/schema/emit.js";

describe("emitJsonSchema", () => {
  it("emits draft-7 JSON Schema for a flat object", () => {
    const schema = z.object({ name: z.string(), age: z.number().optional() });
    const json = emitJsonSchema(schema);
    expect(json.type).toBe("object");
    expect((json.properties as any).name.type).toBe("string");
  });

  it("hoists a registered shared sub-schema into $defs and uses $ref at sites", () => {
    const Inner = z.object({ id: z.string(), label: z.string() });
    registerSharedRef("widget", Inner);

    const Outer = z.object({
      a: Inner,
      b: Inner,
      c: z.string(),
    });
    const json = emitJsonSchema(Outer);
    expect(json.$defs).toBeDefined();
    expect((json.$defs as any).widget).toBeDefined();
    const props = json.properties as any;
    expect(props.a).toEqual({ $ref: "#/$defs/widget" });
    expect(props.b).toEqual({ $ref: "#/$defs/widget" });
    expect(props.c.type).toBe("string");
  });
});

describe("BLOCK_INPUT_SCHEMA", () => {
  it("takes any block whose body matches its type", () => {
    for (const block of [
      { type: "paragraph", paragraph: { rich_text: [] } },
      { type: "image", image: { type: "file_upload", file_upload: { id: "x" } } },
      // A type this server has no zod schema for still passes.
      { type: "table", table: { table_width: 2 } },
    ]) {
      expect(BLOCK_INPUT_SCHEMA.safeParse(block).success).toBe(true);
    }
  });

  it("rejects a misspelled type and names the missing body", () => {
    const res = BLOCK_INPUT_SCHEMA.safeParse({ type: "parragraph", text: "x" });
    expect(res.success).toBe(false);
    expect(res.error!.issues[0].message).toContain('no "parragraph" body');
  });

  it("rejects a block with no type", () => {
    expect(BLOCK_INPUT_SCHEMA.safeParse({ paragraph: {} }).success).toBe(false);
  });
});
