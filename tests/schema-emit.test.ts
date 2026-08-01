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

describe("emitJsonSchema $defs bodies", () => {
  it("gives a definition a real body, not a $ref to itself", () => {
    const Inner = z.object({ id: z.string(), label: z.string() });
    registerSharedRef("gadget", Inner);

    const json = emitJsonSchema(z.object({ a: Inner, b: Inner }));
    const body = (json.$defs as any).gadget;
    expect(body.$ref).toBeUndefined();
    expect(body.type).toBe("object");
    expect(Object.keys(body.properties)).toEqual(["id", "label"]);
  });

  it("resolves a nested shared ref inside a definition body", () => {
    const Leaf = z.object({ url: z.string() });
    const Branch = z.object({ leaf: Leaf, name: z.string() });
    registerSharedRef("leaf", Leaf);
    registerSharedRef("branch", Branch);

    const json = emitJsonSchema(z.object({ x: Branch }));
    const defs = json.$defs as any;
    expect(defs.branch.$ref).toBeUndefined();
    expect(defs.branch.properties.leaf).toEqual({ $ref: "#/$defs/leaf" });
    expect(defs.leaf.properties.url.type).toBe("string");
  });
});
