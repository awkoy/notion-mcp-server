import { describe, it, expect } from "vitest";
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
