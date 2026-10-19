import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { APIResponseError, APIErrorCode } from "@notionhq/client";

const notionStub = {
  pages: { create: vi.fn(), update: vi.fn() },
  blocks: { children: { append: vi.fn() } },
};

vi.mock("../src/services/notion.js", () => ({ getClient: async () => notionStub }));

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";
import { markWrite } from "../src/services/call-context.js";
import {
  MAX_BLOCKS_PER_ARRAY,
  MAX_BLOCKS_PER_REQUEST,
  nextBlockRequest,
} from "../src/utils/write-blocks.js";

type Block = Record<string, unknown>;
type AppendArgs = { block_id: string; children: Block[]; position?: unknown };

const para = (text: string): Block => ({
  type: "paragraph",
  paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
});
const item = (text: string, children: Block[] = []): Block => ({
  type: "bulleted_list_item",
  bulleted_list_item: {
    rich_text: [{ type: "text", text: { content: text } }],
    ...(children.length ? { children } : {}),
  },
});
const kids = (block: Block): Block[] =>
  ((block[block.type as string] as { children?: Block[] }).children ?? []);
/** A bulleted list `levels` deep: L1 > L2 > ... */
const deepList = (levels: number): Block =>
  Array.from({ length: levels }, (_, i) => levels - i).reduce<Block | undefined>(
    (inner, level) => item(`L${level}`, inner ? [inner] : []),
    undefined
  )!;
const paragraphs = (n: number): Block[] => Array.from({ length: n }, (_, i) => para(`p${i}`));
/** Deepest level of block arrays in a request: 1 for flat blocks. */
const depth = (blocks: Block[]): number =>
  blocks.length === 0 ? 0 : 1 + Math.max(...blocks.map((b) => depth(kids(b))));
const count = (blocks: Block[]): number => blocks.reduce((n, b) => n + 1 + count(kids(b)), 0);

function validationError(message: string): APIResponseError {
  return Object.assign(Object.create(APIResponseError.prototype) as APIResponseError, {
    name: "APIResponseError" as const,
    message,
    code: APIErrorCode.ValidationError,
    status: 400,
    headers: {},
    body: "",
    additional_data: undefined,
    request_id: undefined,
  });
}

/** Every append call, with ids handed out as `<parent>/<n>` in call order. */
let appends: AppendArgs[] = [];
function appendSucceeds(failOnCall?: number) {
  let n = 0;
  notionStub.blocks.children.append.mockImplementation(async (args: AppendArgs) => {
    appends.push(args);
    if (appends.length === failOnCall) throw validationError("body failed validation");
    // What the real client does for a write that succeeds.
    markWrite();
    return {
      results: args.children.map((b) => ({ object: "block", id: `${args.block_id}/${n++}`, type: b.type })),
    };
  });
}

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  appends = [];
  notionStub.pages.create.mockReset();
  notionStub.pages.update.mockReset();
  notionStub.blocks.children.append.mockReset();
});

describe("nextBlockRequest", () => {
  it("sends at most 100 top-level blocks", () => {
    const r = nextBlockRequest(paragraphs(250));
    expect(r.send).toHaveLength(MAX_BLOCKS_PER_ARRAY);
    expect(r.rest).toHaveLength(150);
    expect(r.later).toEqual([]);
  });

  it("keeps a list two levels deep whole", () => {
    const r = nextBlockRequest([deepList(3)]);
    expect(r.send).toEqual([deepList(3)]);
    expect(r.later).toEqual([]);
  });

  it("sends a deeper block without the children that would pass two levels", () => {
    const r = nextBlockRequest([para("a"), deepList(5), para("b")]);
    expect(r.send.map((b) => b.type)).toEqual(["paragraph", "bulleted_list_item", "paragraph"]);
    expect(kids(r.send[1])).toEqual([]);
    expect(r.later).toEqual([{ index: 1, children: kids(deepList(5)) }]);
    expect(depth(r.send)).toBeLessThanOrEqual(3);
  });

  it("keeps the children that fit and leaves the rest, in order, for later", () => {
    const parent = item("p", [item("flat"), deepList(3), item("after")]);
    const r = nextBlockRequest([parent]);
    expect(kids(r.send[0])).toEqual([item("flat")]);
    expect(r.later[0].children).toEqual([deepList(3), item("after")]);
  });

  it("splits a table of more than 100 rows", () => {
    const row = { type: "table_row", table_row: { cells: [[]] } };
    const table = { type: "table", table: { table_width: 1, children: Array(150).fill(row) } };
    const r = nextBlockRequest([table]);
    expect(kids(r.send[0])).toHaveLength(100);
    expect(r.later[0].children).toHaveLength(50);
  });

  it("stays within 1000 blocks per request", () => {
    const wide = Array.from({ length: 30 }, (_, i) => item(`w${i}`, Array(60).fill(item("x"))));
    const r = nextBlockRequest(wide);
    expect(count(r.send)).toBeLessThanOrEqual(MAX_BLOCKS_PER_REQUEST);
    expect(r.send.length + r.rest.length).toBe(30);
    expect(r.later).toEqual([]);
  });
});

describe("append_blocks past Notion's per-request limits", () => {
  it("writes 140 paragraphs and a list five levels deep in requests Notion accepts", async () => {
    appendSucceeds();
    const res = (await dispatch("append_blocks", {
      block_id: "page",
      children: [...paragraphs(140), deepList(5)],
    })) as { ok: boolean; data: { appended: number; ids: string[] } };

    expect(res.ok).toBe(true);
    expect(res.data.appended).toBe(141);
    expect(res.data.ids).toHaveLength(141);
    for (const call of appends) {
      expect(call.children.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_ARRAY);
      expect(depth(call.children)).toBeLessThanOrEqual(3);
    }
    // 100 paragraphs; 40 more and L1; L2 under L1; L3 > L4 > L5 under L2.
    expect(appends.map((c) => [c.block_id, c.children.length])).toEqual([
      ["page", 100],
      ["page", 41],
      ["page/140", 1],
      ["page/140/141", 1],
    ]);
    expect(depth(appends[3].children)).toBe(3);
  });

  it("places each later request after the last block written when appending at the start", async () => {
    appendSucceeds();
    await dispatch("append_blocks", { block_id: "page", children: paragraphs(150), position: "start" });
    expect(appends[0].position).toEqual({ type: "start" });
    expect(appends[1].position).toEqual({ type: "after_block", after_block: { id: "page/99" } });
  });

  it("reports how far it got when a later request fails", async () => {
    appendSucceeds(2);
    const res = (await dispatch("append_blocks", {
      block_id: "page",
      children: paragraphs(150),
    })) as { ok: boolean; error: { code: string; message: string; fix: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("validation_error");
    expect(res.error.message).toContain("100 of its 150 top-level blocks were appended");
    expect(res.error.message).toContain("Part of this call was already applied");
    expect(res.error.fix).toMatch(/^Read the target back/);
    expect(res.error.fix).toContain('after: "page/99"');
  });

  it("returns Notion's own error when the first request fails", async () => {
    appendSucceeds(1);
    const res = (await dispatch("append_blocks", {
      block_id: "page",
      children: paragraphs(150),
    })) as { ok: boolean; error: { message: string } };
    expect(res.ok).toBe(false);
    expect(res.error.message).not.toContain("top-level blocks were appended");
    expect(res.error.message).not.toContain("Part of this call");
  });
});

describe("create_page past Notion's per-request limits", () => {
  const parent = { type: "page_id", page_id: "parent" };

  beforeEach(() => {
    notionStub.pages.create.mockImplementation(async () => {
      markWrite();
      return { object: "page", id: "new", properties: {} };
    });
  });

  it("sends small content with the page in one request", async () => {
    const res = (await dispatch("create_page", { parent, title: "T", markdown: "- a\n  - b\n    - c" })) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    expect((notionStub.pages.create.mock.calls[0][0] as { children: Block[] }).children).toHaveLength(1);
    expect(notionStub.blocks.children.append).not.toHaveBeenCalled();
  });

  it("creates the page with the leading blocks that fit and appends the rest", async () => {
    appendSucceeds();
    const res = (await dispatch("create_page", {
      parent,
      title: "T",
      children: [...paragraphs(140), deepList(5)],
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    const sent = (notionStub.pages.create.mock.calls[0][0] as { children: Block[] }).children;
    expect(sent).toHaveLength(100);
    expect(appends.map((c) => [c.block_id, c.children.length])).toEqual([
      ["new", 41],
      ["new/40", 1],
      ["new/40/41", 1],
    ]);
  });

  it("creates the page empty when its first block is too deep, then appends everything", async () => {
    appendSucceeds();
    await dispatch("create_page", { parent, title: "T", children: [deepList(4), para("after")] });
    expect(notionStub.pages.create.mock.calls[0][0]).not.toHaveProperty("children");
    expect(appends[0]).toMatchObject({ block_id: "new" });
    expect(appends[0].children).toHaveLength(2);
  });

  it("trashes the page when appending the rest fails", async () => {
    appendSucceeds(1);
    notionStub.pages.update.mockResolvedValue({ object: "page", id: "new" });
    const res = (await dispatch("create_page", {
      parent,
      title: "T",
      children: paragraphs(150),
    })) as { ok: boolean; error: { code: string; message: string } };
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("validation_error");
    expect(res.error.message).toContain("moved to trash");
    // The page is in the trash, so nothing is left to read back.
    expect(res.error.message).not.toContain("Part of this call");
    expect(notionStub.pages.update).toHaveBeenCalledWith({ page_id: "new", in_trash: true });
  });

  it("says the page is left when trashing it fails too", async () => {
    appendSucceeds(1);
    notionStub.pages.update.mockRejectedValue(validationError("cannot trash"));
    const res = (await dispatch("create_page", {
      parent,
      title: "T",
      children: paragraphs(150),
    })) as { ok: boolean; error: { message: string; fix: string } };
    expect(res.ok).toBe(false);
    expect(res.error.message).toContain("page new is left with part of its content");
    expect(res.error.message).toContain("Part of this call was already applied");
    expect(res.error.fix).toContain("Trash page new with trash_page");
  });
});
