import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const notionStub = {
  databases: { update: vi.fn() },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

import { initOperations, getOperation } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";
import { emitJsonSchema } from "../src/schema/emit.js";

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  notionStub.databases.update.mockReset();
  notionStub.databases.update.mockResolvedValue({ id: "db-1", in_trash: true });
});

describe("update_database", () => {
  it("has no trash field in its schema", () => {
    const schema = emitJsonSchema(getOperation("update_database")!.schema);
    const props = schema.properties as Record<string, unknown>;
    expect(props.in_trash).toBeUndefined();
    expect(props.archived).toBeUndefined();
  });

  it("never sends in_trash, even when one is smuggled into the payload", async () => {
    await dispatch("update_database", {
      database_id: "db-1",
      title: "Renamed",
      in_trash: true,
    });
    const body = notionStub.databases.update.mock.calls[0][0];
    expect(body).not.toHaveProperty("in_trash");
    expect(body.title).toBeDefined();
  });
});

describe("delete_database", () => {
  it("is registered and marked destructive", () => {
    const def = getOperation("delete_database")!;
    expect(def).toBeDefined();
    expect(def.destructive).toBe(true);
    expect(def.domain).toBe("databases");
  });

  it("trashes by default", async () => {
    await dispatch("delete_database", { database_id: "db-1" });
    expect(notionStub.databases.update.mock.calls[0][0]).toMatchObject({
      database_id: "db-1",
      in_trash: true,
    });
  });

  it("restores when in_trash is false", async () => {
    await dispatch("delete_database", { database_id: "db-1", in_trash: false });
    expect(notionStub.databases.update.mock.calls[0][0]).toMatchObject({
      in_trash: false,
    });
  });

  it("honors the deprecated archived alias", async () => {
    await dispatch("delete_database", { database_id: "db-1", archived: false });
    expect(notionStub.databases.update.mock.calls[0][0]).toMatchObject({
      in_trash: false,
    });
  });
});
