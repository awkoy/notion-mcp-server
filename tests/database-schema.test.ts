import { describe, expect, it } from "vitest";
import { emitJsonSchema } from "../src/schema/emit.js";
import { RELATION_DB_PROPERTY_SCHEMA } from "../src/schema/database.js";

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
