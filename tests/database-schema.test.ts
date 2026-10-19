import { describe, expect, it } from "vitest";
import { emitJsonSchema } from "../src/schema/emit.js";
import {
  DATABASE_PROPERTY_SCHEMA,
  RELATION_DB_PROPERTY_SCHEMA,
  STATUS_DB_PROPERTY_SCHEMA,
} from "../src/schema/database.js";

describe("relation database property schema", () => {
  it("accepts a data-source relation target", () => {
    const value = {
      type: "relation" as const,
      relation: {
        data_source_id: "data-source-id",
        single_property: {},
      },
    };

    expect(RELATION_DB_PROPERTY_SCHEMA.parse(value)).toEqual(value);
  });

  it("emits data_source_id instead of the legacy database_id", () => {
    const json = emitJsonSchema(RELATION_DB_PROPERTY_SCHEMA) as any;
    const relation = json.properties.relation;

    expect(relation.properties.data_source_id).toMatchObject({ type: "string" });
    expect(relation.properties.database_id).toBeUndefined();
    expect(relation.required).toContain("data_source_id");
  });
});

describe("status database property schema", () => {
  // Inferring `type` from the body key only works for types in the union.
  it("is a property type a definition can take, with Notion's default options", () => {
    expect(DATABASE_PROPERTY_SCHEMA.parse({ status: {} })).toEqual({ type: "status", status: {} });
    expect(DATABASE_PROPERTY_SCHEMA.parse({ type: "status" })).toEqual({ type: "status", status: {} });
  });

  it("accepts options with a color, description and group", () => {
    const value = {
      type: "status" as const,
      status: {
        options: [
          { name: "Backlog", color: "gray" as const, group: "To-do" as const },
          { name: "Review", description: "Waiting on a reviewer", group: "In progress" as const },
          { name: "Shipped", group: "Complete" as const },
          { id: "abc", name: "Renamed" },
        ],
      },
    };
    expect(STATUS_DB_PROPERTY_SCHEMA.parse(value)).toEqual(value);
  });

  it("rejects a group outside To-do, In progress and Complete", () => {
    const res = DATABASE_PROPERTY_SCHEMA.safeParse({ status: { options: [{ name: "X", group: "Done" }] } });
    expect(res.success).toBe(false);
  });

  it("emits the group names as an enum", () => {
    const json = emitJsonSchema(STATUS_DB_PROPERTY_SCHEMA) as any;
    const option = json.properties.status.properties.options.items;
    expect(option.properties.group.enum).toEqual(["To-do", "In progress", "Complete"]);
    expect(option.required).toEqual(["name"]);
  });
});
