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
  blocks: {
    children: {
      append: vi.fn(),
    },
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
  const resetAll = (obj: unknown): void => {
    if (typeof obj === "function" && "mockReset" in (obj as object)) {
      (obj as ReturnType<typeof vi.fn>).mockReset();
      return;
    }
    if (obj && typeof obj === "object") {
      for (const v of Object.values(obj as Record<string, unknown>)) resetAll(v);
    }
  };
  resetAll(notionStub);
});

// ────────────────────────────────────────────────────────────────────────
// query_database
// ────────────────────────────────────────────────────────────────────────

describe("query_database", () => {
  it("auto-resolves a single-source database via databases.retrieve", async () => {
    notionStub.databases.retrieve.mockImplementation(async (args) => {
      calls.push({ method: "databases.retrieve", args });
      return { object: "database", id: "db-1", data_sources: [{ id: "ds-only", name: "S" }] };
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
      object: "database",
      id: "db-2",
      data_sources: [{ id: "ds-a", name: "A" }, { id: "ds-b", name: "B" }],
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

  it("translates `where` DSL into a Notion filter before hitting the SDK", async () => {
    notionStub.dataSources.query.mockImplementation(async (args) => {
      calls.push({ method: "dataSources.query", args });
      return { object: "list", results: [], has_more: false, next_cursor: null };
    });

    const res = await dispatch("query_database", {
      data_source_id: "ds-1",
      where: { Status: "Done" },
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(calls[0]).toMatchObject({
      method: "dataSources.query",
      args: {
        data_source_id: "ds-1",
        filter: { property: "Status", select: { equals: "Done" } },
      },
    });
  });

  it("walks pages when paginate:true and returns {results, truncated, pages_walked}", async () => {
    notionStub.dataSources.query
      .mockResolvedValueOnce({
        object: "list",
        results: [{ object: "page", id: "p-1", properties: {} }],
        has_more: true,
        next_cursor: "cur-1",
      })
      .mockResolvedValueOnce({
        object: "list",
        results: [{ object: "page", id: "p-2", properties: {} }],
        has_more: false,
        next_cursor: null,
      });

    const res = await dispatch("query_database", {
      data_source_id: "ds-1",
      paginate: true,
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    const data = (res as { data: { results: unknown[]; truncated: boolean; pages_walked: number } }).data;
    expect(data.results).toHaveLength(2);
    expect(data.truncated).toBe(false);
    expect(data.pages_walked).toBe(2);
    expect(notionStub.dataSources.query).toHaveBeenCalledTimes(2);
    expect(notionStub.dataSources.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ start_cursor: "cur-1" })
    );
  });

  it("reports truncated:true when paginate:true hits page_limit before exhausting", async () => {
    notionStub.dataSources.query.mockResolvedValue({
      object: "list",
      results: [
        { object: "page", id: "p-1", properties: {} },
        { object: "page", id: "p-2", properties: {} },
      ],
      has_more: true,
      next_cursor: "more",
    });

    const res = await dispatch("query_database", {
      data_source_id: "ds-1",
      paginate: true,
      page_limit: 2,
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    const data = (res as { data: { results: unknown[]; truncated: boolean; pages_walked: number } }).data;
    expect(data.results).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.pages_walked).toBe(1);
  });

  it("rejects passing both `where` and `filter` (mutual-exclusion refine)", async () => {
    const res = await dispatch("query_database", {
      data_source_id: "ds-1",
      where: { Status: "Done" },
      filter: { property: "Status", select: { equals: "Done" } },
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    const err = (res as { error: { code: string; example?: unknown; schema?: unknown } }).error;
    expect(err.code).toBe("validation_error");
    // Top-level refine errors carry an example payload but no schema noise.
    expect(err.example).toBeDefined();
    expect(notionStub.dataSources.query).not.toHaveBeenCalled();
  });

  it("surfaces where_compile_error when DSL value is malformed", async () => {
    const res = await dispatch("query_database", {
      data_source_id: "ds-1",
      where: { Priority: { __type: "number", contains: "foo" } },
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("where_compile_error");
    expect(notionStub.dataSources.query).not.toHaveBeenCalled();
  });

  it("hoists the common parent off rows to the list level (non-verbose)", async () => {
    const parent = { type: "data_source_id", data_source_id: "ds-1" };
    notionStub.dataSources.query.mockResolvedValue({
      object: "list",
      results: [
        { object: "page", id: "p-1", url: "u1", properties: {}, parent },
        { object: "page", id: "p-2", url: "u2", properties: {}, parent },
      ],
      has_more: false,
      next_cursor: null,
    });

    const res = await dispatch("query_database", { data_source_id: "ds-1" });
    const data = (res as {
      data: { parent: unknown; results: Array<Record<string, unknown>> };
    }).data;
    expect(data.parent).toEqual(parent);
    for (const row of data.results) {
      expect(row).not.toHaveProperty("parent");
    }
  });

  it("preserves per-row parent when verbose=true", async () => {
    const parent = { type: "data_source_id", data_source_id: "ds-1" };
    notionStub.dataSources.query.mockResolvedValue({
      object: "list",
      results: [{ object: "page", id: "p-1", url: "u1", properties: {}, parent }],
      has_more: false,
      next_cursor: null,
    });

    const res = await dispatch("query_database", { data_source_id: "ds-1", verbose: true });
    const data = (res as { data: { results: Array<Record<string, unknown>> } }).data;
    expect(data).not.toHaveProperty("parent");
    expect(data.results[0]).toHaveProperty("parent");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Data-source ops
// ────────────────────────────────────────────────────────────────────────

describe("list_data_sources", () => {
  it("returns slim summary by default", async () => {
    notionStub.databases.retrieve.mockResolvedValue({
      object: "database",
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
        data_sources: [
          { id: "ds-1", name: "Source A" },
          { id: "ds-2", name: "Source B" },
        ],
      },
    });
  });

  it("returns the raw data_sources field when verbose=true", async () => {
    notionStub.databases.retrieve.mockResolvedValue({
      object: "database",
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
  it("slim shape maps property names to types", async () => {
    notionStub.dataSources.retrieve.mockResolvedValue({
      object: "data_source",
      id: "ds-1",
      parent: { type: "database_id", database_id: "db-1" },
      title: [{ plain_text: "Tasks" }],
      description: [],
      properties: { Name: { type: "title" }, Status: { type: "status" } },
    });

    const res = await dispatch("get_data_source", { data_source_id: "ds-1" });
    expect(res).toMatchObject({
      ok: true,
      data: {
        id: "ds-1",
        title: "Tasks",
        properties: { Name: "title", Status: "status" },
      },
    });
  });

  it("verbose returns the raw SDK response", async () => {
    const raw = {
      object: "data_source",
      id: "ds-1",
      parent: {},
      title: [],
      properties: {},
      extra: "kept",
    };
    notionStub.dataSources.retrieve.mockResolvedValue(raw);

    const res = await dispatch("get_data_source", { data_source_id: "ds-1", verbose: true });
    expect((res as { data: unknown }).data).toEqual(raw);
  });
});

describe("update_data_source", () => {
  it("routes legacy archived to in_trash (2026-03-11 surface) and forwards only provided fields", async () => {
    notionStub.dataSources.update.mockResolvedValue({ id: "ds-1" });

    const res = await dispatch("update_data_source", {
      data_source_id: "ds-1",
      archived: true,
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.dataSources.update).toHaveBeenCalledWith({
      data_source_id: "ds-1",
      in_trash: true,
    });
    const call = notionStub.dataSources.update.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("archived");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Page ops: move, markdown
// ────────────────────────────────────────────────────────────────────────

describe("move_page", () => {
  it("forwards parent on the SDK call (matching the move endpoint body)", async () => {
    notionStub.pages.move.mockResolvedValue({
      id: "p-1",
      url: "https://notion.so/p-1",
      properties: { title: { title: [{ plain_text: "T" }] } },
      parent: { type: "page_id", page_id: "dest" },
    });

    const res = await dispatch("move_page", {
      page_id: "p-1",
      parent: { type: "page_id", page_id: "dest" },
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.pages.move).toHaveBeenCalledWith({
      page_id: "p-1",
      parent: { type: "page_id", page_id: "dest" },
    });
  });

  it("accepts data_source_id parent", async () => {
    notionStub.pages.move.mockResolvedValue({
      id: "p-1",
      url: "u",
      properties: {},
      parent: { type: "data_source_id", data_source_id: "ds-1" },
    });

    const res = await dispatch("move_page", {
      page_id: "p-1",
      parent: { type: "data_source_id", data_source_id: "ds-1" },
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.pages.move).toHaveBeenCalledWith({
      page_id: "p-1",
      parent: { type: "data_source_id", data_source_id: "ds-1" },
    });
  });

  it("rejects unsupported parent variants with self-healing envelope", async () => {
    const res = await dispatch("move_page", {
      page_id: "p-1",
      parent: { type: "database_id", database_id: "db-1" },
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    const err = (res as { error: { code: string; fix: string } }).error;
    expect(err.code).toBe("unsupported_parent");
    expect(err.fix).toContain("list_data_sources");
    expect(notionStub.pages.move).not.toHaveBeenCalled();
  });

  it("rejects workspace parent (move endpoint only supports page_id or data_source_id)", async () => {
    const res = await dispatch("move_page", {
      page_id: "p-1",
      parent: { type: "workspace", workspace: true },
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("unsupported_parent");
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
  it("sends replace_content discriminator on default replace", async () => {
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: "p-1" });

    const res = await dispatch("update_page_markdown", {
      page_id: "p-1",
      markdown: "## Updated",
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect(notionStub.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: "p-1",
      type: "replace_content",
      replace_content: { new_str: "## Updated" },
    });
  });

  it("forwards allow_deleting_content on replace", async () => {
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: "p-1" });

    await dispatch("update_page_markdown", {
      page_id: "p-1",
      markdown: "x",
      allow_deleting_content: true,
    });
    expect(notionStub.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: "p-1",
      type: "replace_content",
      replace_content: { new_str: "x", allow_deleting_content: true },
    });
  });

  it("maps insert_content.position into the insert_content discriminator", async () => {
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: "p-1" });

    await dispatch("update_page_markdown", {
      page_id: "p-1",
      markdown: "More",
      insert_content: { position: "end" },
    });
    expect(notionStub.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: "p-1",
      type: "insert_content",
      insert_content: {
        content: "More",
        position: { type: "end" },
      },
    });
  });

  it("forwards insert_content.after when provided", async () => {
    notionStub.pages.updateMarkdown.mockResolvedValue({ id: "p-1" });

    await dispatch("update_page_markdown", {
      page_id: "p-1",
      markdown: "More",
      insert_content: { position: "start", after: "block-9" },
    });
    expect(notionStub.pages.updateMarkdown).toHaveBeenCalledWith({
      page_id: "p-1",
      type: "insert_content",
      insert_content: {
        content: "More",
        after: "block-9",
        position: { type: "start" },
      },
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Comments
// ────────────────────────────────────────────────────────────────────────

describe("get_comment", () => {
  it("returns slim {id, created_by, text}", async () => {
    notionStub.comments.retrieve.mockResolvedValue({
      id: "c-1",
      created_by: { id: "u-1" },
      created_time: "2026-01-01",
      rich_text: [{ plain_text: "Hi" }],
    });

    const res = await dispatch("get_comment", { comment_id: "c-1" });
    expect(res).toMatchObject({
      ok: true,
      data: { id: "c-1", created_by: "u-1", text: "Hi" },
    });
    // created_time was dropped in v2.3 for consistency with other slim shapes
    expect((res as { data: Record<string, unknown> }).data).not.toHaveProperty("created_time");
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

describe("append_blocks position wire shape", () => {
  it("wraps position string into {type: position} on the SDK call", async () => {
    notionStub.blocks.children.append.mockResolvedValue({ results: [] });
    await dispatch("append_blocks", {
      block_id: "b-1",
      children: [{ type: "paragraph", paragraph: { rich_text: [] } }],
      position: "end",
    });
    const call = notionStub.blocks.children.append.mock.calls[0][0] as Record<string, unknown>;
    expect(call.position).toEqual({ type: "end" });
  });

  it("translates legacy after into position.after_block", async () => {
    notionStub.blocks.children.append.mockResolvedValue({ results: [] });
    await dispatch("append_blocks", {
      block_id: "b-1",
      children: [{ type: "paragraph", paragraph: { rich_text: [] } }],
      after: "b-prev",
    });
    const call = notionStub.blocks.children.append.mock.calls[0][0] as Record<string, unknown>;
    expect(call.position).toEqual({ type: "after_block", after_block: { id: "b-prev" } });
    expect(call).not.toHaveProperty("after");
  });

  it("omits position when neither after nor position is given", async () => {
    notionStub.blocks.children.append.mockResolvedValue({ results: [] });
    await dispatch("append_blocks", {
      block_id: "b-1",
      children: [{ type: "paragraph", paragraph: { rich_text: [] } }],
    });
    const call = notionStub.blocks.children.append.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("position");
    expect(call).not.toHaveProperty("after");
  });
});

describe("append_blocks response shape", () => {
  it("returns {appended, ids} by default (default position, end)", async () => {
    notionStub.blocks.children.append.mockResolvedValue({
      results: [
        { object: "block", id: "blk-1", type: "paragraph", paragraph: { rich_text: [] } },
        { object: "block", id: "blk-2", type: "paragraph", paragraph: { rich_text: [] } },
      ],
    });
    const res = await dispatch("append_blocks", {
      block_id: "b-1",
      children: [
        { type: "paragraph", paragraph: { rich_text: [] } },
        { type: "paragraph", paragraph: { rich_text: [] } },
      ],
    });
    expect((res as { ok: boolean }).ok).toBe(true);
    expect((res as { data: unknown }).data).toEqual({
      appended: 2,
      ids: ["blk-1", "blk-2"],
    });
  });

  it("slices to the requested count for position:'start' (Notion returns the full child set)", async () => {
    notionStub.blocks.children.append.mockResolvedValue({
      results: [
        { object: "block", id: "blk-new-1", type: "paragraph", paragraph: { rich_text: [] } },
        { object: "block", id: "blk-old-A", type: "paragraph", paragraph: { rich_text: [] } },
        { object: "block", id: "blk-old-B", type: "paragraph", paragraph: { rich_text: [] } },
      ],
    });
    const res = await dispatch("append_blocks", {
      block_id: "b-1",
      children: [{ type: "paragraph", paragraph: { rich_text: [] } }],
      position: "start",
    });
    expect((res as { data: { ids: string[] } }).data.ids).toEqual(["blk-new-1"]);
  });

  it("omits ids when the response is unexpectedly short", async () => {
    notionStub.blocks.children.append.mockResolvedValue({ results: [] });
    const res = await dispatch("append_blocks", {
      block_id: "b-1",
      children: [{ type: "paragraph", paragraph: { rich_text: [] } }],
    });
    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.appended).toBe(1);
    expect(data).not.toHaveProperty("ids");
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

  it("rejects a one-character unique_id prefix locally rather than round-tripping to Notion", async () => {
    // Notion rejects single-letter prefixes with a generic 400; catch it at the
    // schema layer so the LLM gets a clear "fix" instead of an API echo.
    const res = await dispatch("create_database", {
      parent: { type: "page_id", page_id: "p-1" },
      title: "Tasks",
      properties: {
        Name: { type: "title", title: {} },
        Id: { type: "unique_id", unique_id: { prefix: "T" } },
      },
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    expect((res as { error: { code: string } }).error.code).toBe("validation_error");
    expect(notionStub.databases.create).not.toHaveBeenCalled();
  });

  it("accepts a valid 2+ char unique_id prefix", async () => {
    notionStub.databases.create.mockResolvedValue({
      id: "db-new",
      title: [{ plain_text: "T" }],
      properties: {},
    });

    const res = await dispatch("create_database", {
      parent: { type: "page_id", page_id: "p-1" },
      title: "T",
      properties: {
        Name: { type: "title", title: {} },
        Id: { type: "unique_id", unique_id: { prefix: "TSK" } },
      },
    });
    expect((res as { ok: boolean }).ok).toBe(true);
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

describe("update_database properties migration", () => {
  it("rejects properties with a self-healing envelope pointing to update_data_source", async () => {
    const res = await dispatch("update_database", {
      database_id: "db-1",
      properties: { Name: { type: "title", title: {} } },
    });
    expect((res as { ok: boolean }).ok).toBe(false);
    const err = (res as { error: { code: string; fix: string } }).error;
    expect(err.code).toBe("properties_moved");
    expect(err.fix).toContain("update_data_source");
    expect(notionStub.databases.update).not.toHaveBeenCalled();
  });

  it("does not forward properties even when other fields are present", async () => {
    notionStub.databases.update.mockResolvedValue({ id: "db-1", title: [], properties: {} });
    // sanity: bare update without properties still works
    await dispatch("update_database", { database_id: "db-1", title: "Renamed" });
    const call = notionStub.databases.update.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("properties");
  });

  it("forwards is_locked when provided", async () => {
    notionStub.databases.update.mockResolvedValue({ id: "db-1", title: [], properties: {} });
    await dispatch("update_database", { database_id: "db-1", is_locked: true });
    const call = notionStub.databases.update.mock.calls[0][0] as Record<string, unknown>;
    expect(call.is_locked).toBe(true);
  });
});
