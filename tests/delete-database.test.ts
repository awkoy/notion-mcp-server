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
  it("keeps in_trash / archived in its schema so a stale call is rejected, not stripped", () => {
    // z.object strips unknown keys: if the fields were simply dropped,
    // `{ in_trash: true }` would come back ok with the database untouched.
    const schema = emitJsonSchema(getOperation("update_database")!.schema);
    const props = schema.properties as Record<string, { description?: string }>;
    expect(props.in_trash).toBeDefined();
    expect(props.in_trash.description).toContain("delete_database");
    expect(props.archived).toBeDefined();
    expect(props.archived.description).toContain("delete_database");
  });

  it("rejects in_trash with a pointer at delete_database instead of a silent no-op", async () => {
    const res = await dispatch("update_database", {
      database_id: "db-1",
      title: "Renamed",
      in_trash: true,
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    const err = (res as { error: { code: string; fix: string } }).error;
    expect(err.code).toBe("trash_moved");
    expect(err.fix).toContain("delete_database");
    expect(notionStub.databases.update).not.toHaveBeenCalled();
  });

  it("rejects the restore direction (in_trash:false) the same way", async () => {
    const res = await dispatch("update_database", { database_id: "db-1", in_trash: false });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("trash_moved");
    expect(notionStub.databases.update).not.toHaveBeenCalled();
  });

  it("rejects the deprecated archived alias the same way", async () => {
    const res = await dispatch("update_database", { database_id: "db-1", archived: true });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string; fix: string } }).error.code).toBe("trash_moved");
    expect(notionStub.databases.update).not.toHaveBeenCalled();
  });

  it("still forwards metadata-only updates", async () => {
    await dispatch("update_database", { database_id: "db-1", title: "Renamed" });
    const body = notionStub.databases.update.mock.calls[0][0];
    expect(body).not.toHaveProperty("in_trash");
    expect(body).not.toHaveProperty("archived");
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
