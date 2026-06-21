import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

type Call = { method: string; args: unknown };
const calls: Call[] = [];

const notionStub = {
  pages: { retrieve: vi.fn() },
  databases: { retrieve: vi.fn() },
  dataSources: { retrieve: vi.fn() },
  views: {
    list: vi.fn(),
    retrieve: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    queries: { create: vi.fn(), results: vi.fn(), delete: vi.fn() },
  },
};

vi.mock("../src/services/notion.js", () => ({ getClient: async () => notionStub }));

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  calls.length = 0;
  const resetAll = (obj: unknown): void => {
    if (typeof obj === "function" && "mockReset" in (obj as object)) {
      (obj as ReturnType<typeof vi.fn>).mockReset();
      return;
    }
    if (obj && typeof obj === "object")
      for (const v of Object.values(obj as Record<string, unknown>)) resetAll(v);
  };
  resetAll(notionStub);
});

// ────────────────────────────────────────────────────────────────────────
// get_view
// ────────────────────────────────────────────────────────────────────────

describe("get_view", () => {
  it("retrieves and slims a view", async () => {
    notionStub.views.retrieve.mockImplementation(async (args) => {
      calls.push({ method: "views.retrieve", args });
      return {
        object: "view",
        id: "v-1",
        name: "In Progress",
        type: "board",
        filter: { x: 1 },
        sorts: [],
        configuration: { huge: "blob" },
      };
    });
    const res = (await dispatch("get_view", { view_id: "v-1" })) as { ok: boolean; data: any };
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ id: "v-1", name: "In Progress", type: "board", filter: { x: 1 } });
    // configuration is omitted unless verbose
    expect(res.data).not.toHaveProperty("configuration");
    expect(calls[0]).toMatchObject({ method: "views.retrieve", args: { view_id: "v-1" } });
  });

  it("returns the full object with verbose:true", async () => {
    notionStub.views.retrieve.mockResolvedValue({
      object: "view",
      id: "v-1",
      name: "X",
      type: "table",
      configuration: { huge: "blob" },
    });
    const res = (await dispatch("get_view", { view_id: "v-1", verbose: true })) as { ok: boolean; data: any };
    expect(res.data).toHaveProperty("configuration");
  });
});

// ────────────────────────────────────────────────────────────────────────
// list_views
// ────────────────────────────────────────────────────────────────────────

describe("list_views", () => {
  it("hydrates view refs to {id,name,type} by default", async () => {
    notionStub.views.list.mockImplementation(async (args) => {
      calls.push({ method: "views.list", args });
      return {
        object: "list",
        results: [
          { object: "view", id: "v-1" },
          { object: "view", id: "v-2" },
        ],
        has_more: false,
        next_cursor: null,
      };
    });
    notionStub.views.retrieve.mockImplementation(async ({ view_id }) => ({
      object: "view",
      id: view_id,
      name: `N-${view_id}`,
      type: "table",
    }));
    const res = (await dispatch("list_views", { database_id: "db-1" })) as { ok: boolean; data: any };
    expect(res.ok).toBe(true);
    expect(res.data.results).toEqual([
      { id: "v-1", name: "N-v-1", type: "table" },
      { id: "v-2", name: "N-v-2", type: "table" },
    ]);
    expect(calls[0]).toMatchObject({ method: "views.list", args: { database_id: "db-1" } });
  });

  it("returns raw ids when hydrate:false (no retrieve calls)", async () => {
    notionStub.views.list.mockResolvedValue({
      object: "list",
      results: [{ object: "view", id: "v-9" }],
      has_more: false,
      next_cursor: null,
    });
    const res = (await dispatch("list_views", { database_id: "db-1", hydrate: false })) as {
      ok: boolean;
      data: any;
    };
    expect(res.data.results).toEqual([{ id: "v-9" }]);
    expect(notionStub.views.retrieve).not.toHaveBeenCalled();
  });

  it("rejects when neither database_id nor data_source_id is given", async () => {
    const res = (await dispatch("list_views", {})) as { ok: boolean };
    expect(res.ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// query_view
// ────────────────────────────────────────────────────────────────────────

describe("query_view", () => {
  it("creates a query and hydrates first-page ids to rows", async () => {
    notionStub.views.queries.create.mockImplementation(async (args) => {
      calls.push({ method: "views.queries.create", args });
      return {
        object: "view_query",
        id: "q-1",
        view_id: "v-1",
        total_count: 2,
        results: [{ id: "p-1" }, { id: "p-2" }],
        has_more: false,
        next_cursor: null,
      };
    });
    notionStub.pages.retrieve.mockImplementation(async ({ page_id }) => ({
      object: "page",
      id: page_id,
      properties: { Name: { type: "title", title: [{ plain_text: `T-${page_id}` }] } },
      url: `https://n/${page_id}`,
      parent: { type: "database_id", database_id: "db" },
    }));
    const res = (await dispatch("query_view", { view_id: "v-1" })) as { ok: boolean; data: any };
    expect(res.ok).toBe(true);
    expect(res.data.total_count).toBe(2);
    expect(res.data.results).toHaveLength(2);
    expect(res.data.results[0]).toMatchObject({ id: "p-1", title: "T-p-1" });
    expect(calls[0]).toMatchObject({ method: "views.queries.create", args: { view_id: "v-1" } });
  });

  it("returns ids only when hydrate:false (no page retrieves)", async () => {
    notionStub.views.queries.create.mockResolvedValue({
      object: "view_query",
      id: "q-2",
      view_id: "v-1",
      total_count: 1,
      results: [{ id: "p-9" }],
      has_more: false,
      next_cursor: null,
    });
    const res = (await dispatch("query_view", { view_id: "v-1", hydrate: false })) as {
      ok: boolean;
      data: any;
    };
    expect(res.data.results).toEqual([{ id: "p-9" }]);
    expect(notionStub.pages.retrieve).not.toHaveBeenCalled();
  });

  it("surfaces truncated when request_status is incomplete", async () => {
    notionStub.views.queries.create.mockResolvedValue({
      object: "view_query",
      id: "q-3",
      view_id: "v-1",
      total_count: 5000,
      results: [{ id: "p-1" }],
      has_more: true,
      next_cursor: "c1",
      request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    });
    const res = (await dispatch("query_view", {
      view_id: "v-1",
      hydrate: false,
      paginate: true,
      page_limit: 1,
    })) as { ok: boolean; data: any };
    expect(res.data.truncated).toBe(true);
  });

  it("walks pages when paginate:true", async () => {
    notionStub.views.queries.create.mockResolvedValue({
      object: "view_query",
      id: "q-4",
      view_id: "v-1",
      total_count: 3,
      results: [{ id: "p-1" }],
      has_more: true,
      next_cursor: "c1",
    });
    notionStub.views.queries.results.mockResolvedValue({
      object: "view_query",
      id: "q-4",
      view_id: "v-1",
      results: [{ id: "p-2" }, { id: "p-3" }],
      has_more: false,
      next_cursor: null,
    });
    const res = (await dispatch("query_view", {
      view_id: "v-1",
      hydrate: false,
      paginate: true,
    })) as { ok: boolean; data: any };
    expect(res.data.results).toEqual([{ id: "p-1" }, { id: "p-2" }, { id: "p-3" }]);
    expect(res.data.pages_walked).toBe(2);
    expect(notionStub.views.queries.delete).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// create_view
// ────────────────────────────────────────────────────────────────────────

describe("create_view", () => {
  it("creates a table view, resolving database_id from data_source_id and compiling where", async () => {
    notionStub.dataSources.retrieve.mockResolvedValue({
      object: "data_source",
      id: "ds-1",
      parent: { type: "database_id", database_id: "db-parent" },
    });
    notionStub.views.create.mockImplementation(async (args) => {
      calls.push({ method: "views.create", args });
      return { object: "view", id: "v-new", name: "Open", type: "table" };
    });
    const res = (await dispatch("create_view", {
      data_source_id: "ds-1",
      name: "Open",
      type: "table",
      where: { Status: "Open" },
    })) as { ok: boolean; data: any };
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ id: "v-new", name: "Open", type: "table" });
    const call = calls[0].args as Record<string, unknown>;
    // createView requires BOTH data_source_id and database_id in the body.
    expect(call).toMatchObject({
      data_source_id: "ds-1",
      database_id: "db-parent",
      name: "Open",
      type: "table",
    });
    expect(call).toHaveProperty("filter");
  });

  it("rejects a calendar view without required configuration", async () => {
    const res = (await dispatch("create_view", {
      data_source_id: "ds-1",
      name: "Cal",
      type: "calendar",
    })) as { ok: boolean; error: any };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("missing_view_config");
    expect(notionStub.views.create).not.toHaveBeenCalled();
  });

  it("resolves a single-source database_id", async () => {
    notionStub.databases.retrieve.mockResolvedValue({
      object: "database",
      id: "db-1",
      data_sources: [{ id: "ds-only", name: "S" }],
    });
    notionStub.views.create.mockImplementation(async (args) => {
      calls.push({ method: "views.create", args });
      return { object: "view", id: "v-x", name: "T", type: "table" };
    });
    await dispatch("create_view", { database_id: "db-1", name: "T", type: "table" });
    expect(calls[0].args as Record<string, unknown>).toMatchObject({
      data_source_id: "ds-only",
      database_id: "db-1",
    });
  });

  it("rejects when both where and filter are passed", async () => {
    const res = (await dispatch("create_view", {
      data_source_id: "ds-1",
      name: "X",
      type: "table",
      where: { Status: "Open" },
      filter: { property: "Status", status: { equals: "Open" } },
    })) as { ok: boolean; error: any };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("filter_conflict");
  });
});

// ────────────────────────────────────────────────────────────────────────
// update_view
// ────────────────────────────────────────────────────────────────────────

describe("update_view", () => {
  it("updates name and compiles where", async () => {
    notionStub.views.update.mockImplementation(async (args) => {
      calls.push({ method: "views.update", args });
      return { object: "view", id: "v-1", name: "Renamed", type: "table" };
    });
    const res = (await dispatch("update_view", {
      view_id: "v-1",
      name: "Renamed",
      where: { Status: "Done" },
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    const call = calls[0].args as Record<string, unknown>;
    expect(call).toMatchObject({ view_id: "v-1", name: "Renamed" });
    expect(call).toHaveProperty("filter");
  });

  it("clears filter when clear includes 'filter'", async () => {
    notionStub.views.update.mockImplementation(async (args) => {
      calls.push({ method: "views.update", args });
      return { object: "view", id: "v-1", name: "X", type: "table" };
    });
    await dispatch("update_view", { view_id: "v-1", clear: ["filter"] });
    expect((calls[0].args as Record<string, unknown>).filter).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// delete_view
// ────────────────────────────────────────────────────────────────────────

describe("delete_view", () => {
  it("deletes a view by id", async () => {
    notionStub.views.delete.mockImplementation(async (args) => {
      calls.push({ method: "views.delete", args });
      return { object: "view", id: "v-1", deleted: true };
    });
    const res = (await dispatch("delete_view", { view_id: "v-1" })) as { ok: boolean; data: any };
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ id: "v-1", deleted: true });
    expect(calls[0]).toMatchObject({ method: "views.delete", args: { view_id: "v-1" } });
  });
});
