import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const notionStub = {
  databases: { create: vi.fn(), update: vi.fn() },
  dataSources: { update: vi.fn() },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

import { initOperations, getOperation } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";
import { emitJsonSchema } from "../src/schema/emit.js";
import { preprocessJson } from "../src/schema/preprocess.js";

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  for (const group of Object.values(notionStub)) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  notionStub.dataSources.update.mockResolvedValue({ id: "ds-1", properties: {} });
  notionStub.databases.update.mockResolvedValue({ id: "db-1", title: [], properties: {} });
});

// Notion deletes a data source property when its definition is null:
//   PATCH /data_sources/:id { properties: { "Old": null } }
// That is the only place the API takes null for a property, so the schema,
// the emitted JSON Schema, and the handler all have to let it through here
// and nowhere else.
describe("update_data_source: null deletes a property", () => {
  it("parses null as a property value and keeps it as null", () => {
    const schema = getOperation("update_data_source")!.schema;
    const res = schema.safeParse({
      data_source_id: "ds-1",
      properties: { Old: null, Kept: { type: "rich_text", rich_text: {} } },
    });
    expect(res.success).toBe(true);
    const props = (res.data as { properties: Record<string, unknown> }).properties;
    expect(props.Old).toBeNull();
    expect(props.Kept).toMatchObject({ type: "rich_text" });
  });

  it("preprocessJson leaves null alone rather than turning it into something else", () => {
    expect(preprocessJson(null)).toBeNull();
  });

  it("advertises null in the emitted JSON Schema and says what it does", () => {
    const json = emitJsonSchema(getOperation("update_data_source")!.schema) as any;
    const properties = json.properties.properties;
    expect(properties.description).toMatch(/null/i);
    expect(properties.description).toMatch(/delete/i);

    const value = properties.additionalProperties;
    expect(value.description).toMatch(/null/i);
    expect(value.description).toMatch(/delete/i);
    const variants: unknown[] = value.anyOf ?? value.oneOf;
    expect(variants).toContainEqual({ type: "null" });
    // The definition union is still there next to it, not replaced by it.
    const definition = variants.find((v) => v && typeof v === "object" && !("type" in (v as object)));
    expect(definition).toBeDefined();
    // The definition union is hoisted into $defs; follow the $ref.
    const ref = (definition as any).$ref as string | undefined;
    const resolved = ref ? json.$defs[ref.split("/").pop()!] : definition;
    expect((resolved as any).oneOf ?? (resolved as any).anyOf).toBeInstanceOf(Array);
  });

  it("forwards the null to dataSources.update untouched", async () => {
    const res = await dispatch("update_data_source", {
      data_source_id: "ds-1",
      properties: { Old: null, Kept: { type: "rich_text", rich_text: {} } },
    });
    expect((res as { ok: boolean }).ok).toBe(true);

    const body = notionStub.dataSources.update.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    };
    expect(Object.hasOwn(body.properties, "Old")).toBe(true);
    expect(body.properties.Old).toBeNull();
    expect(body.properties.Kept).toMatchObject({ type: "rich_text" });
    // What the SDK serializes is what Notion reads.
    expect(JSON.parse(JSON.stringify(body)).properties).toEqual({
      Old: null,
      Kept: { type: "rich_text", rich_text: {} },
    });
  });
});

describe("null property elsewhere", () => {
  it("update_database redirects a null delete attempt to update_data_source", async () => {
    const res = await dispatch("update_database", {
      database_id: "db-1",
      properties: { Old: null },
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    const err = (res as { error: { code: string; fix: string } }).error;
    expect(err.code).toBe("properties_moved");
    expect(err.fix).toContain("update_data_source");
    expect(notionStub.databases.update).not.toHaveBeenCalled();
  });

  it("create_database does not take null: there is nothing to delete yet", async () => {
    const res = await dispatch("create_database", {
      parent: { type: "page_id", page_id: "p-1" },
      title: "T",
      properties: { Old: null },
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("validation_error");
    expect(notionStub.databases.create).not.toHaveBeenCalled();
  });
});
