import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { paginateAll, DEFAULT_PAGE_LIMIT } from "../src/utils/paginate.js";

// ──────────────────────────────────────────────────────────────────────────
// Unit tests for paginateAll (no Notion stub needed)
// ──────────────────────────────────────────────────────────────────────────

describe("paginateAll", () => {
  it("walks all pages and concatenates results when there is no limit hit", async () => {
    const pages = [
      { results: ["a", "b"], has_more: true, next_cursor: "c1" },
      { results: ["c", "d"], has_more: true, next_cursor: "c2" },
      { results: ["e"], has_more: false, next_cursor: null },
    ];
    let i = 0;
    const fetcher = vi.fn(async () => pages[i++]);

    const out = await paginateAll(fetcher);

    expect(out.results).toEqual(["a", "b", "c", "d", "e"]);
    expect(out.pages_walked).toBe(3);
    expect(out.truncated).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("threads next_cursor into successive fetchPage calls", async () => {
    const pages = [
      { results: [1], has_more: true, next_cursor: "cursor-A" },
      { results: [2], has_more: true, next_cursor: "cursor-B" },
      { results: [3], has_more: false, next_cursor: null },
    ];
    let i = 0;
    const received: Array<string | undefined> = [];
    const fetcher = async (cursor: string | undefined) => {
      received.push(cursor);
      return pages[i++];
    };

    await paginateAll(fetcher);

    expect(received).toEqual([undefined, "cursor-A", "cursor-B"]);
  });

  it("stops at limit pages and marks truncated=true when more remain", async () => {
    const makePage = (start: number, has_more: boolean, cursor: string | null) => ({
      results: Array.from({ length: 10 }, (_, k) => start + k),
      has_more,
      next_cursor: cursor,
    });
    const pages = [
      makePage(0, true, "c1"),
      makePage(10, true, "c2"),
      makePage(20, false, null),
    ];
    let i = 0;
    const fetcher = async () => pages[i++];

    const out = await paginateAll(fetcher, { limit: 2 });

    expect(out.results).toHaveLength(20);
    expect(out.results[0]).toBe(0);
    expect(out.results[19]).toBe(19);
    expect(out.pages_walked).toBe(2);
    expect(out.truncated).toBe(true);
  });

  it("returns truncated=false when the walk ends because has_more=false (not because of limit)", async () => {
    const out = await paginateAll(async () => ({
      results: ["only"],
      has_more: false,
      next_cursor: null,
    }));

    expect(out.results).toEqual(["only"]);
    expect(out.pages_walked).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it("handles an empty first page (zero results, has_more=false) without truncating", async () => {
    const out = await paginateAll(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }));

    expect(out.results).toEqual([]);
    expect(out.pages_walked).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it("marks truncated=true when has_more=true with next_cursor=null (defensive)", async () => {
    // Notion shouldn't return this combo, but if it does we must not
    // infinite-loop, AND we must surface that we stopped without exhausting
    // the source — otherwise callers silently lose data.
    const fetcher = vi.fn(async () => ({
      results: [42],
      has_more: true,
      next_cursor: null,
    }));

    const out = await paginateAll(fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(out.pages_walked).toBe(1);
    expect(out.truncated).toBe(true);
  });

  it("DEFAULT_PAGE_LIMIT exists and is a sensible small number", () => {
    expect(DEFAULT_PAGE_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_PAGE_LIMIT).toBeLessThanOrEqual(1000);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Handler integration tests: search_pages / list_users / list_comments
// with paginate:true through dispatch (no MCP transport — exercise registry).
// ──────────────────────────────────────────────────────────────────────────

const notionStub = {
  search: vi.fn(),
  users: { list: vi.fn() },
  comments: { list: vi.fn() },
  // The stubs below exist only so that operations/blocks etc. can register
  // without exploding when the module graph loads.
  databases: { retrieve: vi.fn(), query: vi.fn(), create: vi.fn(), update: vi.fn() },
  dataSources: { query: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
  pages: {
    move: vi.fn(),
    retrieveMarkdown: vi.fn(),
    updateMarkdown: vi.fn(),
    update: vi.fn(),
  },
  blocks: { children: { append: vi.fn() } },
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
  const reset = (obj: unknown): void => {
    if (typeof obj === "function" && "mockReset" in (obj as object)) {
      (obj as ReturnType<typeof vi.fn>).mockReset();
      return;
    }
    if (obj && typeof obj === "object") {
      for (const v of Object.values(obj as Record<string, unknown>)) reset(v);
    }
  };
  reset(notionStub);
});

type OkResult<T> = { ok: true; data: T };

// Two-page fixture builder for any of the three list endpoints.
function makeTwoPage<T>(items1: T[], items2: T[]) {
  return [
    { results: items1, has_more: true, next_cursor: "next-1" },
    { results: items2, has_more: false, next_cursor: null },
  ];
}

describe("search_pages with paginate:true", () => {
  it("walks every page, merges results, ignores start_cursor, returns paginate envelope", async () => {
    const fullPage = (id: string) => ({
      object: "page" as const,
      id,
      url: `https://notion.so/${id}`,
      in_trash: false,
      properties: {},
      parent: { type: "page_id" as const, page_id: "parent" },
      created_time: "t1",
      last_edited_time: "t2",
      icon: null,
      cover: null,
      created_by: { object: "user" as const, id: "u" },
      last_edited_by: { object: "user" as const, id: "u" },
      archived: false,
      public_url: null,
    });
    const responses = makeTwoPage([fullPage("p-1"), fullPage("p-2")], [fullPage("p-3")]);
    notionStub.search
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);

    const res = (await dispatch("search_pages", {
      paginate: true,
      start_cursor: "ignored-when-paginating",
      query: "foo",
    })) as OkResult<{ results: Array<{ id: string }>; truncated: boolean; pages_walked: number }>;

    expect(res.ok).toBe(true);
    expect(res.data.results.map((r) => r.id)).toEqual(["p-1", "p-2", "p-3"]);
    expect(res.data.truncated).toBe(false);
    expect(res.data.pages_walked).toBe(2);

    // First call uses no start_cursor (paginate ignores user-supplied one);
    // second call threads next_cursor from page 1.
    expect(notionStub.search).toHaveBeenCalledTimes(2);
    expect(notionStub.search.mock.calls[0][0].start_cursor).toBeUndefined();
    expect(notionStub.search.mock.calls[1][0].start_cursor).toBe("next-1");
    // Bumped to max page_size when caller didn't specify.
    expect(notionStub.search.mock.calls[0][0].page_size).toBe(100);
  });

  it("marks truncated=true when page_limit halts the walk", async () => {
    const fullPage = (id: string) => ({
      object: "page" as const,
      id,
      url: `https://notion.so/${id}`,
      in_trash: false,
      properties: {},
      parent: { type: "page_id" as const, page_id: "parent" },
      created_time: "t1",
      last_edited_time: "t2",
      icon: null,
      cover: null,
      created_by: { object: "user" as const, id: "u" },
      last_edited_by: { object: "user" as const, id: "u" },
      archived: false,
      public_url: null,
    });
    notionStub.search.mockResolvedValue({
      results: [fullPage("p-x")],
      has_more: true,
      next_cursor: "more",
    });

    const res = (await dispatch("search_pages", {
      paginate: true,
      page_limit: 2,
    })) as OkResult<{ results: unknown[]; truncated: boolean; pages_walked: number }>;

    expect(res.ok).toBe(true);
    expect(res.data.truncated).toBe(true);
    expect(res.data.pages_walked).toBe(2);
    expect(notionStub.search).toHaveBeenCalledTimes(2);
  });

  it("paginate:false (default) returns the legacy {results, has_more, next_cursor} shape", async () => {
    notionStub.search.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const res = (await dispatch("search_pages", { query: "foo" })) as OkResult<{
      results: unknown[];
      has_more: boolean;
      next_cursor: string | null;
    }>;

    expect(res.ok).toBe(true);
    expect(res.data).toHaveProperty("has_more");
    expect(res.data).toHaveProperty("next_cursor");
    expect(res.data).not.toHaveProperty("truncated");
    expect(res.data).not.toHaveProperty("pages_walked");
  });
});

describe("list_users with paginate:true", () => {
  it("walks every page and returns paginate envelope with slim users", async () => {
    const personUser = (id: string) => ({
      object: "user" as const,
      id,
      type: "person" as const,
      name: `n-${id}`,
      avatar_url: null,
      person: { email: `${id}@x` },
    });
    notionStub.users.list
      .mockResolvedValueOnce({
        results: [personUser("u-1"), personUser("u-2")],
        has_more: true,
        next_cursor: "uc-1",
      })
      .mockResolvedValueOnce({
        results: [personUser("u-3")],
        has_more: false,
        next_cursor: null,
      });

    const res = (await dispatch("list_users", { paginate: true })) as OkResult<{
      results: Array<{ id: string; email?: string }>;
      truncated: boolean;
      pages_walked: number;
    }>;

    expect(res.ok).toBe(true);
    expect(res.data.results).toHaveLength(3);
    expect(res.data.results.map((u) => u.id)).toEqual(["u-1", "u-2", "u-3"]);
    expect(res.data.truncated).toBe(false);
    expect(res.data.pages_walked).toBe(2);
    expect(notionStub.users.list.mock.calls[1][0].start_cursor).toBe("uc-1");
  });

  it("paginate:false (default) returns the legacy list shape", async () => {
    notionStub.users.list.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const res = (await dispatch("list_users", {})) as OkResult<{
      results: unknown[];
      has_more: boolean;
      next_cursor: string | null;
    }>;
    expect(res.ok).toBe(true);
    expect(res.data).toHaveProperty("has_more");
    expect(res.data).not.toHaveProperty("pages_walked");
  });
});

describe("list_comments with paginate:true", () => {
  it("walks every page and returns paginate envelope with slim comments", async () => {
    const fullComment = (id: string) => ({
      object: "comment" as const,
      id,
      parent: { type: "page_id" as const, page_id: "p-1" },
      discussion_id: "d-1",
      rich_text: [{ type: "text" as const, plain_text: `body-${id}`, annotations: {}, href: null, text: { content: `body-${id}`, link: null } }],
      created_by: { object: "user" as const, id: "u" },
      created_time: "t1",
      last_edited_time: "t2",
    });
    notionStub.comments.list
      .mockResolvedValueOnce({
        results: [fullComment("c-1")],
        has_more: true,
        next_cursor: "cc-1",
      })
      .mockResolvedValueOnce({
        results: [fullComment("c-2"), fullComment("c-3")],
        has_more: false,
        next_cursor: null,
      });

    const res = (await dispatch("list_comments", {
      block_id: "page-1",
      paginate: true,
    })) as OkResult<{
      results: Array<{ id: string }>;
      truncated: boolean;
      pages_walked: number;
    }>;

    expect(res.ok).toBe(true);
    expect(res.data.results.map((c) => c.id)).toEqual(["c-1", "c-2", "c-3"]);
    expect(res.data.truncated).toBe(false);
    expect(res.data.pages_walked).toBe(2);
    expect(notionStub.comments.list.mock.calls[1][0].start_cursor).toBe("cc-1");
    expect(notionStub.comments.list.mock.calls[0][0].block_id).toBe("page-1");
  });

  it("paginate:false (default) returns the legacy list shape", async () => {
    notionStub.comments.list.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const res = (await dispatch("list_comments", { block_id: "page-1" })) as OkResult<{
      results: unknown[];
      has_more: boolean;
      next_cursor: string | null;
    }>;
    expect(res.ok).toBe(true);
    expect(res.data).toHaveProperty("has_more");
    expect(res.data).not.toHaveProperty("pages_walked");
  });
});
