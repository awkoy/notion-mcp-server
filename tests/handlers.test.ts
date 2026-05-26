import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

type Call = { method: string; args: unknown };
const calls: Call[] = [];

const notionStub = {
  databases: {
    retrieve: vi.fn(),
    query: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  dataSources: {
    query: vi.fn(),
    retrieve: vi.fn(),
    update: vi.fn(),
  },
  pages: {
    move: vi.fn(),
    retrieveMarkdown: vi.fn(),
    updateMarkdown: vi.fn(),
    update: vi.fn(),
  },
  comments: {
    retrieve: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  calls.length = 0;
  for (const ns of Object.values(notionStub)) {
    for (const fn of Object.values(ns)) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  }
});

// ────────────────────────────────────────────────────────────────────────
// query_database
// ────────────────────────────────────────────────────────────────────────

describe("query_database", () => {
  it("auto-resolves a single-source database via databases.retrieve", async () => {
    notionStub.databases.retrieve.mockImplementation(async (args) => {
      calls.push({ method: "databases.retrieve", args });
      return { id: "db-1", data_sources: [{ id: "ds-only" }] };
    });
    notionStub.dataSources.query.mockImplementation(async (args) => {
      calls.push({ method: "dataSources.query", args });
      return { object: "list", results: [], has_more: false, next_cursor: null };
    });

    const res = await dispatch("query_database", { database_id: "db-1" });
    expect((res as { ok: boolean }).ok).toBe(true);

    expect(calls[0]).toMatchObject({ method: "databases.retrieve", args: { database_id: "db-1" } });
    expect(calls[1]).toMatchObject({
      method: "dataSources.query",
      args: { data_source_id: "ds-only", page_size: 100 },
    });
  });

  it("returns multi_source_database envelope with available IDs in fix", async () => {
    notionStub.databases.retrieve.mockResolvedValue({
      id: "db-2",
      data_sources: [{ id: "ds-a" }, { id: "ds-b" }],
    });

    const res = await dispatch("query_database", { database_id: "db-2" });
    expect((res as { ok: boolean }).ok).toBe(false);
    const err = (res as { error: { code: string; fix: string } }).error;
    expect(err.code).toBe("multi_source_database");
    expect(err.fix).toContain("ds-a");
    expect(err.fix).toContain("ds-b");
    expect(notionStub.dataSources.query).not.toHaveBeenCalled();
  });

  it("returns no_data_source when the database reports zero sources", async () => {
    notionStub.databases.retrieve.mockResolvedValue({ id: "db-3", data_sources: [] });

    const res = await dispatch("query_database", { database_id: "db-3" });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("no_data_source");
  });

  it("calls dataSources.query directly when data_source_id is passed", async () => {
    notionStub.dataSources.query.mockResolvedValue({
      object: "list",
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const res = await dispatch("query_database", {
      data_source_id: "ds-direct",
      page_size: 25,
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.databases.retrieve).not.toHaveBeenCalled();
    expect(notionStub.dataSources.query).toHaveBeenCalledWith(
      expect.objectContaining({ data_source_id: "ds-direct", page_size: 25 })
    );
  });

  it("rejects payload that passes both database_id and data_source_id (XOR refine)", async () => {
    const res = await dispatch("query_database", {
      database_id: "db-x",
      data_source_id: "ds-x",
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("rejects payload that passes neither database_id nor data_source_id", async () => {
    const res = await dispatch("query_database", {});
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("validation_error");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Data-source ops
// ────────────────────────────────────────────────────────────────────────

describe("list_data_sources", () => {
  it("returns slim summary by default", async () => {
    notionStub.databases.retrieve.mockResolvedValue({
      id: "db-1",
      data_sources: [
        { id: "ds-1", name: "Source A" },
        { id: "ds-2", name: "Source B" },
      ],
    });

    const res = await dispatch("list_data_sources", { database_id: "db-1" });
    expect(res).toMatchObject({
      ok: true,
      data: {
        database_id: "db-1",
        count: 2,
        data_sources: [
          { id: "ds-1", name: "Source A" },
          { id: "ds-2", name: "Source B" },
        ],
      },
    });
  });

  it("returns the raw data_sources field when verbose=true", async () => {
    notionStub.databases.retrieve.mockResolvedValue({
      id: "db-1",
      data_sources: [{ id: "ds-1", name: "A", extra: "raw" }],
    });

    const res = await dispatch("list_data_sources", { database_id: "db-1", verbose: true });
    expect((res as { ok: true; data: { data_sources: unknown[] } }).data.data_sources[0]).toMatchObject(
      { id: "ds-1", name: "A", extra: "raw" }
    );
  });
});

describe("get_data_source", () => {
  it("slim shape lists property keys", async () => {
    notionStub.dataSources.retrieve.mockResolvedValue({
      id: "ds-1",
      parent: { type: "database_id", database_id: "db-1" },
      name: "Tasks",
      properties: { Name: { type: "title" }, Status: { type: "status" } },
    });

    const res = await dispatch("get_data_source", { data_source_id: "ds-1" });
    expect(res).toMatchObject({
      ok: true,
      data: {
        id: "ds-1",
        name: "Tasks",
        properties: ["Name", "Status"],
      },
    });
  });

  it("verbose returns the raw SDK response", async () => {
    const raw = { id: "ds-1", parent: {}, name: "X", properties: {}, extra: "kept" };
    notionStub.dataSources.retrieve.mockResolvedValue(raw);

    const res = await dispatch("get_data_source", { data_source_id: "ds-1", verbose: true });
    expect((res as { data: unknown }).data).toEqual(raw);
  });
});

describe("update_data_source", () => {
  it("forwards only the fields that were provided", async () => {
    notionStub.dataSources.update.mockResolvedValue({ id: "ds-1" });

    const res = await dispatch("update_data_source", {
      data_source_id: "ds-1",
      archived: true,
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.dataSources.update).toHaveBeenCalledWith({
      data_source_id: "ds-1",
      archived: true,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Page ops: move, markdown
// ────────────────────────────────────────────────────────────────────────

describe("move_page", () => {
  it("calls pages.move with the new parent", async () => {
    notionStub.pages.move.mockResolvedValue({
      id: "p-1",
      url: "https://notion.so/p-1",
      properties: { title: { title: [{ plain_text: "T" }] } },
      parent: { type: "page_id", page_id: "dest" },
    });

    const res = await dispatch("move_page", {
      page_id: "p-1",
      new_parent: { type: "page_id", page_id: "dest" },
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.pages.move).toHaveBeenCalledWith({
      page_id: "p-1",
      new_parent: { type: "page_id", page_id: "dest" },
    });
  });

  it("accepts new parent types (data_source_id, workspace, block_id)", async () => {
    notionStub.pages.move.mockResolvedValue({
      id: "p-1",
      url: "u",
      properties: {},
      parent: { type: "workspace", workspace: true },
    });

    const res = await dispatch("move_page", {
      page_id: "p-1",
      new_parent: { type: "workspace", workspace: true },
    });
    expect((res as { ok: boolean }).ok).toBe(true);
  });
});

describe("get_page_markdown", () => {
  it("returns the server-rendered markdown body", async () => {
    notionStub.pages.retrieveMarkdown.mockResolvedValue({ markdown: "# Hi\n\nBody" });

    const res = await dispatch("get_page_markdown", { page_id: "p-1" });
    expect(res).toMatchObject({
      ok: true,
      data: { page_id: "p-1", markdown: "# Hi\n\nBody" },
    });
  });

  it("falls back to empty string when SDK omits markdown", async () => {
    notionStub.pages.retrieveMarkdown.mockResolvedValue({});
    const res = await dispatch("get_page_markdown", { page_id: "p-1" });
    expect((res as { data: { markdown: string } }).data.markdown).toBe("");
  });
});

describe("update_page_markdown", () => {
  it("calls pages.updateMarkdown with markdown body (replace mode)", async () => {
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: "p-1" });

    const res = await dispatch("update_page_markdown", {
      page_id: "p-1",
      markdown: "## Updated",
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: "p-1",
      markdown: "## Updated",
    });
  });

  it("passes insert_content when provided", async () => {
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: "p-1" });

    await dispatch("update_page_markdown", {
      page_id: "p-1",
      markdown: "More",
      insert_content: { position: "end" },
    });
    expect(notionStub.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: "p-1",
      markdown: "More",
      insert_content: { position: "end" },
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Comments
// ────────────────────────────────────────────────────────────────────────

describe("get_comment", () => {
  it("returns slim {id, created_time}", async () => {
    notionStub.comments.retrieve.mockResolvedValue({
      id: "c-1",
      created_time: "2026-01-01",
      rich_text: [{ plain_text: "Hi" }],
    });

    const res = await dispatch("get_comment", { comment_id: "c-1" });
    expect(res).toMatchObject({
      ok: true,
      data: { id: "c-1", created_time: "2026-01-01" },
    });
  });
});

describe("update_comment", () => {
  it("sends markdown body when markdown is provided", async () => {
    notionStub.comments.update.mockResolvedValue({ id: "c-1" });

    const res = await dispatch("update_comment", {
      comment_id: "c-1",
      markdown: "**bold**",
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.comments.update).toHaveBeenCalledWith({
      comment_id: "c-1",
      markdown: "**bold**",
    });
  });

  it("sends rich_text body when rich_text is provided", async () => {
    notionStub.comments.update.mockResolvedValue({ id: "c-1" });

    await dispatch("update_comment", {
      comment_id: "c-1",
      rich_text: [{ type: "text", text: { content: "Hi" } }],
    });
    expect(notionStub.comments.update).toHaveBeenCalledWith({
      comment_id: "c-1",
      rich_text: [{ type: "text", text: { content: "Hi" } }],
    });
  });

  it("rejects payload with neither markdown nor rich_text (XOR refine)", async () => {
    const res = await dispatch("update_comment", { comment_id: "c-1" });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("validation_error");
    expect(notionStub.comments.update).not.toHaveBeenCalled();
  });

  it("rejects payload with both markdown and rich_text (XOR refine)", async () => {
    const res = await dispatch("update_comment", {
      comment_id: "c-1",
      markdown: "x",
      rich_text: [{}],
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("validation_error");
  });
});

describe("delete_comment", () => {
  it("calls comments.delete and returns ok", async () => {
    notionStub.comments.delete.mockResolvedValue(undefined);

    const res = await dispatch("delete_comment", { comment_id: "c-1" });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.comments.delete).toHaveBeenCalledWith({ comment_id: "c-1" });
  });
});

describe("add_page_comment XOR refine", () => {
  it("rejects when both text and markdown are passed", async () => {
    const res = await dispatch("add_page_comment", {
      page_id: "p-1",
      text: "x",
      markdown: "y",
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("validation_error");
  });

  it("rejects when neither text nor markdown is passed", async () => {
    const res = await dispatch("add_page_comment", { page_id: "p-1" });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("validation_error");
  });
});

// ────────────────────────────────────────────────────────────────────────
// append_blocks: after vs position XOR
// ────────────────────────────────────────────────────────────────────────

describe("append_blocks position/after XOR", () => {
  it("rejects when both after and position are passed", async () => {
    const res = await dispatch("append_blocks", {
      block_id: "b-1",
      children: [{ type: "paragraph", paragraph: { rich_text: [] } }],
      after: "b-prev",
      position: "end",
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("validation_error");
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2025-09-03 surface modernization
// ────────────────────────────────────────────────────────────────────────

describe("create_database uses initial_data_source shape", () => {
  it("nests properties under initial_data_source per 2025-09-03 surface", async () => {
    notionStub.databases.create.mockResolvedValue({
      id: "db-new",
      title: [{ plain_text: "Tasks" }],
      properties: {},
    });

    const res = await dispatch("create_database", {
      parent: { type: "page_id", page_id: "p-1" },
      title: "Tasks",
      properties: {
        Name: { type: "title", title: {} },
      },
    });
    expect((res as { ok: boolean }).ok).toBe(true);

    const call = notionStub.databases.create.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("properties");
    expect(call).toHaveProperty("initial_data_source");
    expect((call.initial_data_source as { properties: unknown }).properties).toEqual({
      Name: { type: "title", title: {} },
    });
  });
});

describe("archive_page / restore_page use in_trash", () => {
  it("archive_page sends in_trash: true (not legacy archived)", async () => {
    notionStub.pages.update.mockResolvedValue({
      id: "p-1",
      url: "u",
      properties: {},
      parent: {},
      in_trash: true,
    });

    await dispatch("archive_page", { page_id: "p-1" });
    expect(notionStub.pages.update).toHaveBeenCalledWith({ page_id: "p-1", in_trash: true });
    const call = notionStub.pages.update.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("archived");
  });

  it("restore_page sends in_trash: false", async () => {
    notionStub.pages.update.mockResolvedValue({
      id: "p-1",
      url: "u",
      properties: {},
      parent: {},
      in_trash: false,
    });

    await dispatch("restore_page", { page_id: "p-1" });
    expect(notionStub.pages.update).toHaveBeenCalledWith({ page_id: "p-1", in_trash: false });
  });
});

describe("update_database in_trash handling", () => {
  it("forwards in_trash when caller passes in_trash", async () => {
    notionStub.databases.update.mockResolvedValue({ id: "db-1", title: [], properties: {} });

    await dispatch("update_database", { database_id: "db-1", in_trash: true });
    const call = notionStub.databases.update.mock.calls[0][0] as Record<string, unknown>;
    expect(call.in_trash).toBe(true);
    expect(call).not.toHaveProperty("archived");
  });

  it("forwards in_trash when caller passes legacy archived", async () => {
    notionStub.databases.update.mockResolvedValue({ id: "db-1", title: [], properties: {} });

    await dispatch("update_database", { database_id: "db-1", archived: true });
    const call = notionStub.databases.update.mock.calls[0][0] as Record<string, unknown>;
    expect(call.in_trash).toBe(true);
    expect(call).not.toHaveProperty("archived");
  });

  it("prefers in_trash when both are passed", async () => {
    notionStub.databases.update.mockResolvedValue({ id: "db-1", title: [], properties: {} });

    await dispatch("update_database", {
      database_id: "db-1",
      in_trash: false,
      archived: true,
    });
    const call = notionStub.databases.update.mock.calls[0][0] as Record<string, unknown>;
    expect(call.in_trash).toBe(false);
  });
});
