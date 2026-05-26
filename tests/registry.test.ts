import { describe, it, expect, beforeAll } from "vitest";
import { initOperations, operationNames, getOperation } from "../src/operations/index.js";

beforeAll(async () => {
  await initOperations();
});

describe("operations registry", () => {
  it("registers every name in the OperationName union (26 total)", () => {
    const names = operationNames();
    expect(names.length).toBe(26);
  });

  it("includes the data-source ops", () => {
    expect(getOperation("list_data_sources")).toBeDefined();
    expect(getOperation("get_data_source")).toBeDefined();
    expect(getOperation("update_data_source")).toBeDefined();
  });

  it("includes the v2 gap-closure ops added on top of v1 capabilities", () => {
    expect(getOperation("get_block")).toBeDefined();
    expect(getOperation("set_page_properties")).toBeDefined();
  });

  it("get_block is batchable and exposes a single block_id field", () => {
    const def = getOperation("get_block")!;
    expect(def.batchable).toBe(true);
    expect(def.example).toMatchObject({ block_id: expect.any(String) });
  });

  it("set_page_properties is batchable and accepts a properties map", () => {
    const def = getOperation("set_page_properties")!;
    expect(def.batchable).toBe(true);
    expect(def.example).toMatchObject({
      page_id: expect.any(String),
      properties: expect.any(Object),
    });
  });
});
