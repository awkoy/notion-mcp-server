import { describe, it, expect, beforeAll } from "vitest";
import { dispatch } from "../src/dispatch/index.js";
import { initOperations } from "../src/operations/index.js";
import { sliceJsonSchema, summarizeSchema } from "../src/utils/schema-slice.js";

beforeAll(async () => {
  await initOperations();
});

describe("schema-slice", () => {
  it("slices a nested property out of an object schema", () => {
    const root = {
      type: "object",
      properties: {
        page_id: { type: "string" },
        properties: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
    };
    const sliced = sliceJsonSchema(root, ["properties"]);
    expect(sliced).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
    });
  });

  it("does not follow __proto__ keys when slicing (prototype-safety)", () => {
    const root = {
      type: "object",
      properties: {
        page_id: { type: "string" },
      },
    };
    // A crafted Zod error path of ["__proto__"] should NOT walk up the chain.
    const sliced = sliceJsonSchema(root, ["__proto__"]);
    // Falls through to returning the root unchanged.
    expect(sliced).toEqual(root);
  });

  it("summarizes large unions into one-line-per-branch discriminator tags", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: { type: { const: "title" } },
          required: ["type"],
        },
        {
          type: "object",
          properties: { type: { const: "rich_text" } },
          required: ["type"],
        },
        {
          type: "object",
          properties: { type: { const: "number" } },
          required: ["type"],
        },
      ],
    };
    const summary = summarizeSchema(schema as never);
    expect(summary).toEqual({
      oneOf: [{ type: "title" }, { type: "rich_text" }, { type: "number" }],
    });
  });
});

describe("validation_error envelope size", () => {
  it("stays small (<2KB) on a deeply-nested union failure for set_page_property", async () => {
    const result = await dispatch("set_page_property", {
      page_id: "abc",
      // Missing required `value`; triggers validation_error with deep union slice.
      name: "Status",
    });
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text.length).toBeLessThan(2048);
  });
});

describe("record schemas", () => {
  const MAP_SCHEMA = {
    type: "object",
    properties: {
      properties: {
        type: "object",
        additionalProperties: {
          anyOf: [
            { type: "object", properties: { checkbox: { type: "boolean" } }, required: ["checkbox"] },
            { type: "object", properties: { number: { type: "number" } }, required: ["number"] },
          ],
        },
      },
    },
  } as any;

  it("slices through additionalProperties to the value schema", () => {
    const sliced = sliceJsonSchema(MAP_SCHEMA, ["properties", "Tags"]) as any;
    expect(sliced.anyOf).toHaveLength(2);
    expect(sliced.additionalProperties).toBeUndefined();
  });

  it("summarizes a union nested under additionalProperties", () => {
    const summarized = summarizeSchema(
      (MAP_SCHEMA.properties as any).properties
    ) as any;
    const branches = summarized.additionalProperties.anyOf;
    expect(branches).toHaveLength(2);
    for (const b of branches) expect(JSON.stringify(b).length).toBeLessThan(60);
  });
});
