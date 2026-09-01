import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { z } from "zod";
import { normalizeNotionId, notionId } from "../src/schema/id.js";
import { emitJsonSchema } from "../src/schema/emit.js";

const notionStub = {
  blocks: { retrieve: vi.fn(), children: { append: vi.fn() } },
  databases: { update: vi.fn() },
  pages: { create: vi.fn(), update: vi.fn() },
  views: { retrieve: vi.fn() },
  users: { retrieve: vi.fn() },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

import { initOperations, getOperation } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

const DASHED = "3ab5030f-c6e5-801e-b170-cd93167dd607";
const BARE = "3ab5030fc6e5801eb170cd93167dd607";
const BLOCK_BARE = "1f2e3d4c5b6a79880011223344556677";
const BLOCK_DASHED = "1f2e3d4c-5b6a-7988-0011-223344556677";
const VIEW_BARE = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
const VIEW_DASHED = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("normalizeNotionId", () => {
  it("dashes a bare id", () => {
    expect(normalizeNotionId(BARE)).toBe(DASHED);
  });

  it("leaves a dashed id alone", () => {
    expect(normalizeNotionId(DASHED)).toBe(DASHED);
  });

  it("lowercases an uppercase id", () => {
    expect(normalizeNotionId(BARE.toUpperCase())).toBe(DASHED);
    expect(normalizeNotionId(`https://www.notion.so/X-${BARE.toUpperCase()}`)).toBe(DASHED);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeNotionId(`  ${BARE}\n`)).toBe(DASHED);
    expect(normalizeNotionId(` https://www.notion.so/X-${BARE} `)).toBe(DASHED);
  });

  it("takes the id out of a page URL", () => {
    expect(
      normalizeNotionId(`https://app.notion.com/p/Varuag-s-Testing-Playground-${BARE}`)
    ).toBe(DASHED);
  });

  it.each([
    ["www.notion.so with a title slug", `https://www.notion.so/My-Page-Title-${BARE}`],
    ["notion.so without www", `https://notion.so/My-Page-Title-${BARE}`],
    ["a workspace path segment", `https://www.notion.so/acme/${BARE}`],
    ["a public notion.site page", `https://acme.notion.site/My-Page-${BARE}`],
    ["a dashed uuid in the path", `https://www.notion.so/${DASHED}`],
    ["a ?pvs= query", `https://www.notion.so/My-Page-${BARE}?pvs=4`],
    ["a notion:// deep link", `notion://www.notion.so/My-Page-${BARE}`],
    ["http", `http://www.notion.so/My-Page-${BARE}`],
  ])("handles %s", (_label, url) => {
    expect(normalizeNotionId(url)).toBe(DASHED);
  });

  it("takes the last id in the path when a slug or workspace segment looks like hex", () => {
    const hexish = "deadbeefdeadbeefdeadbeefdeadbeef";
    expect(normalizeNotionId(`https://www.notion.so/${hexish}/Page-${BARE}`)).toBe(DASHED);
  });

  it("ignores a view id in the query string", () => {
    expect(normalizeNotionId(`https://www.notion.so/Tasks-${BARE}?v=${VIEW_BARE}&pvs=4`)).toBe(
      DASHED
    );
  });

  it("ignores a block anchor for an object id", () => {
    expect(normalizeNotionId(`https://www.notion.so/Page-${BARE}#${BLOCK_BARE}`)).toBe(DASHED);
  });

  it("passes a property id through untouched", () => {
    expect(normalizeNotionId("%40APf")).toBe("%40APf");
  });

  it("passes an unrecognized string through, so a bad id still fails", () => {
    expect(normalizeNotionId("not-an-id")).toBe("not-an-id");
  });

  it("passes a URL with no id through untouched", () => {
    expect(normalizeNotionId("https://www.notion.so/")).toBe("https://www.notion.so/");
    expect(normalizeNotionId("https://example.com/docs/report")).toBe(
      "https://example.com/docs/report"
    );
  });

  it("passes a 31- or 33-hex string through", () => {
    expect(normalizeNotionId(BARE.slice(1))).toBe(BARE.slice(1));
    expect(normalizeNotionId(BARE + "0")).toBe(BARE + "0");
  });

  it("leaves a non-string alone", () => {
    expect(normalizeNotionId(42)).toBe(42);
    expect(normalizeNotionId(null)).toBe(null);
    expect(normalizeNotionId(undefined)).toBe(undefined);
  });
});

describe("normalizeNotionId kinds", () => {
  const blockLink = `https://www.notion.so/Page-${BARE}?pvs=4#${BLOCK_BARE}`;
  const viewLink = `https://www.notion.so/acme/${BARE}?v=${VIEW_BARE}`;

  it("block: the anchor of a block link wins", () => {
    expect(normalizeNotionId(blockLink, "block")).toBe(BLOCK_DASHED);
  });

  it("block: a plain page link yields the page id, since a page is a block", () => {
    expect(normalizeNotionId(`https://www.notion.so/Page-${BARE}`, "block")).toBe(DASHED);
  });

  it("block: a bare id is unaffected", () => {
    expect(normalizeNotionId(BLOCK_BARE, "block")).toBe(BLOCK_DASHED);
  });

  it("block: an anchor that is not an id is ignored", () => {
    expect(normalizeNotionId(`https://www.notion.so/Page-${BARE}#heading`, "block")).toBe(
      DASHED
    );
  });

  it("view: the ?v= of a database link wins", () => {
    expect(normalizeNotionId(viewLink, "view")).toBe(VIEW_DASHED);
  });

  it("view: a link without ?v= falls back to the path id", () => {
    expect(normalizeNotionId(`https://www.notion.so/acme/${BARE}`, "view")).toBe(DASHED);
  });

  it("object: ignores both the anchor and ?v=", () => {
    expect(normalizeNotionId(blockLink, "object")).toBe(DASHED);
    expect(normalizeNotionId(viewLink, "object")).toBe(DASHED);
  });
});

describe("notionId schema", () => {
  it("normalizes on parse", () => {
    expect(notionId().parse(`https://www.notion.so/X-${BARE}`)).toBe(DASHED);
  });

  it("normalizes by kind", () => {
    const link = `https://www.notion.so/X-${BARE}#${BLOCK_BARE}`;
    expect(notionId("block").parse(link)).toBe(BLOCK_DASHED);
    expect(notionId().parse(link)).toBe(DASHED);
  });

  it("still rejects a non-string", () => {
    expect(notionId().safeParse(42).success).toBe(false);
  });

  it("emits `type: string` with its description, and honors optional", () => {
    const json = emitJsonSchema(
      z.object({
        page_id: notionId().describe("ID of the page"),
        after: notionId("block").optional().describe("Block to insert after"),
      })
    );
    const props = json.properties as Record<string, unknown>;
    expect(props.page_id).toEqual({ type: "string", description: "ID of the page" });
    expect(props.after).toEqual({ type: "string", description: "Block to insert after" });
    expect(json.required).toEqual(["page_id"]);
  });
});

describe("notionId through the operations", () => {
  beforeAll(async () => {
    await initOperations();
  });

  beforeEach(() => {
    notionStub.blocks.retrieve.mockReset().mockResolvedValue({ id: BLOCK_DASHED });
    notionStub.blocks.children.append.mockReset().mockResolvedValue({ results: [{ id: "b" }] });
    notionStub.databases.update.mockReset().mockResolvedValue({ id: DASHED });
    notionStub.pages.create.mockReset().mockResolvedValue({ id: "p" });
    notionStub.pages.update.mockReset().mockResolvedValue({ id: DASHED });
    notionStub.views.retrieve.mockReset().mockResolvedValue({ id: VIEW_DASHED });
    notionStub.users.retrieve.mockReset().mockResolvedValue({ id: DASHED });
  });

  it("notion_describe still shows an id as a described string, inside $defs too", () => {
    const json = emitJsonSchema(getOperation("create_page")!.schema);
    const parent = (json.$defs as Record<string, { anyOf: Array<{ properties: any }> }>).parent;
    expect(parent.anyOf[0].properties.page_id).toEqual({
      type: "string",
      description: "ID of the parent page",
    });
    const props = json.properties as Record<string, unknown>;
    expect(props.parent).toEqual({ $ref: "#/$defs/parent" });

    const get = emitJsonSchema(getOperation("get_page")!.schema);
    expect((get.properties as any).page_id).toEqual({ type: "string" });
  });

  it("a page URL in page_id reaches the API as a dashed id", async () => {
    const res = await dispatch("set_page_title", {
      page_id: `https://www.notion.so/Q3-Plan-${BARE}?pvs=4`,
      title: "Q3 plan",
    });
    expect(res.ok).toBe(true);
    expect(notionStub.pages.update.mock.calls[0][0].page_id).toBe(DASHED);
  });

  it("a block link in block_id yields the anchored block", async () => {
    const res = await dispatch("get_block", {
      block_id: `https://www.notion.so/Page-${BARE}#${BLOCK_BARE}`,
    });
    expect(res.ok).toBe(true);
    expect(notionStub.blocks.retrieve.mock.calls[0][0].block_id).toBe(BLOCK_DASHED);
  });

  it("a block link in append_blocks `after` yields the anchored block", async () => {
    const res = await dispatch("append_blocks", {
      block_id: `https://www.notion.so/Page-${BARE}`,
      markdown: "hi",
      after: `https://www.notion.so/Page-${BARE}#${BLOCK_BARE}`,
    });
    expect(res.ok).toBe(true);
    const body = notionStub.blocks.children.append.mock.calls[0][0];
    expect(body.block_id).toBe(DASHED);
    expect(body.position).toEqual({ type: "after_block", after_block: { id: BLOCK_DASHED } });
  });

  it("a database view link in view_id yields the view", async () => {
    const res = await dispatch("get_view", {
      view_id: `https://www.notion.so/acme/${BARE}?v=${VIEW_BARE}`,
    });
    expect(res.ok).toBe(true);
    expect(notionStub.views.retrieve.mock.calls[0][0].view_id).toBe(VIEW_DASHED);
  });

  it("a database view link in database_id yields the database, not the view", async () => {
    const res = await dispatch("delete_database", {
      database_id: `https://www.notion.so/acme/${BARE}?v=${VIEW_BARE}`,
    });
    expect(res.ok).toBe(true);
    expect(notionStub.databases.update.mock.calls[0][0]).toEqual({
      database_id: DASHED,
      in_trash: true,
    });
  });

  it("a URL inside `parent` is normalized through the shared $def", async () => {
    const res = await dispatch("create_page", {
      parent: { type: "page_id", page_id: `https://www.notion.so/Parent-${BARE}` },
      title: "Child",
    });
    expect(res.ok).toBe(true);
    expect(notionStub.pages.create.mock.calls[0][0].parent).toEqual({
      type: "page_id",
      page_id: DASHED,
    });
  });

  it("a URL in NOTION_PAGE_ID is normalized for the default parent", async () => {
    const prev = process.env.NOTION_PAGE_ID;
    process.env.NOTION_PAGE_ID = `https://www.notion.so/Default-${BARE}`;
    try {
      const res = await dispatch("create_page", { title: "Child" });
      expect(res.ok).toBe(true);
      expect(notionStub.pages.create.mock.calls[0][0].parent).toEqual({
        type: "page_id",
        page_id: DASHED,
      });
    } finally {
      if (prev === undefined) delete process.env.NOTION_PAGE_ID;
      else process.env.NOTION_PAGE_ID = prev;
    }
  });

  it("a relation property value takes a page URL", async () => {
    const res = await dispatch("set_page_property", {
      page_id: BARE,
      name: "Project",
      value: { relation: [{ id: `https://www.notion.so/Project-${BLOCK_BARE}` }] },
    });
    expect(res.ok).toBe(true);
    const body = notionStub.pages.update.mock.calls[0][0];
    expect(body.properties.Project.relation).toEqual([{ id: BLOCK_DASHED }]);
  });

  it("batch items are normalized independently", async () => {
    const res = await dispatch("get_block", {
      items: [
        { block_id: `https://www.notion.so/Page-${BARE}#${BLOCK_BARE}` },
        { block_id: BARE },
      ],
    });
    expect(res.ok).toBe(true);
    const ids = notionStub.blocks.retrieve.mock.calls.map((c) => c[0].block_id).sort();
    expect(ids).toEqual([BLOCK_DASHED, DASHED].sort());
  });

  it("a bad id still fails downstream, not at validation", async () => {
    notionStub.users.retrieve.mockRejectedValue(
      Object.assign(new Error("Could not find user"), { code: "object_not_found", status: 404 })
    );
    const res = await dispatch("get_user", { user_id: "not-an-id" });
    expect(res.ok).toBe(false);
    expect(notionStub.users.retrieve.mock.calls[0][0].user_id).toBe("not-an-id");
  });
});
