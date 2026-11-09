import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { OperationResult } from "../src/operations/types.js";

// The real SDK client and dispatch with node-fetch stubbed, so these assert on
// the URL that goes out: an SDK method drops any parameter its endpoint does
// not list.

const { fetchStub } = vi.hoisted(() => ({ fetchStub: vi.fn() }));
vi.mock("node-fetch", () => ({ default: fetchStub }));

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

const { Response: NodeFetchResponse } =
  await vi.importActual<typeof import("node-fetch")>("node-fetch");

const PAGE_ID = "3ab5030f-c6e5-8109-b32f-dbd2c4093059";
const PARENT_ID = "3ab5030f-c6e5-8182-a41b-e48b46176e7b";

const pageJson = (title: string, properties: Record<string, unknown> = {}) => ({
  object: "page",
  id: PAGE_ID,
  url: "https://notion.so/p",
  parent: { type: "page_id", page_id: PARENT_ID },
  in_trash: false,
  properties: { Name: { id: "title", type: "title", title: [{ plain_text: title }] }, ...properties },
});
const listJson = (results: unknown[]) => ({ object: "list", results, next_cursor: null, has_more: false });

type Sent = { method: string; url: URL; body: Record<string, unknown> };

function reply(json: unknown): Sent[] {
  const sent: Sent[] = [];
  fetchStub.mockImplementation(async (url: unknown, init?: { method?: string; body?: string }) => {
    sent.push({
      method: init?.method ?? "GET",
      url: new URL(String(url)),
      body: init?.body ? JSON.parse(init.body) : {},
    });
    return new NodeFetchResponse(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return sent;
}

const filterOf = (sent: Sent) => sent.url.searchParams.getAll("filter_properties");
const ok = (res: unknown) => {
  expect((res as OperationResult).ok).toBe(true);
  return res as { ok: true; data: Record<string, unknown> };
};

describe("filter_properties on the outgoing request", () => {
  const originalToken = process.env.NOTION_TOKEN;

  beforeAll(async () => {
    process.env.NOTION_TOKEN = "ntn_filter_properties_test";
    await initOperations();
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
  });

  beforeEach(() => {
    fetchStub.mockReset();
  });

  const writes: [string, Record<string, unknown>, string, string][] = [
    ["create_page", { parent: { type: "page_id", page_id: PARENT_ID }, title: "New" }, "POST", "/v1/pages"],
    ["set_page_title", { page_id: PAGE_ID, title: "Renamed" }, "PATCH", `/v1/pages/${PAGE_ID}`],
    ["set_page_property", { page_id: PAGE_ID, name: "Status", value: { select: { name: "Done" } } }, "PATCH", `/v1/pages/${PAGE_ID}`],
    ["set_page_properties", { page_id: PAGE_ID, properties: { Status: { select: { name: "Done" } } } }, "PATCH", `/v1/pages/${PAGE_ID}`],
    ["archive_page", { page_id: PAGE_ID }, "PATCH", `/v1/pages/${PAGE_ID}`],
    ["trash_page", { page_id: PAGE_ID }, "PATCH", `/v1/pages/${PAGE_ID}`],
    ["restore_page", { page_id: PAGE_ID }, "PATCH", `/v1/pages/${PAGE_ID}`],
  ];

  describe.each(writes)("%s", (operation, payload, method, path) => {
    it("puts the names in the query string and keeps the title", async () => {
      const sent = reply(pageJson("T"));
      ok(await dispatch(operation, { ...payload, filter_properties: ["Status", "Due Date"] }));
      expect(sent).toHaveLength(1);
      expect(sent[0].method).toBe(method);
      expect(sent[0].url.pathname).toBe(path);
      expect(filterOf(sent[0])).toEqual(["Status", "Due Date", "title"]);
      expect(sent[0].body).not.toHaveProperty("filter_properties");
    });

    it("sends exactly the list with verbose", async () => {
      const sent = reply(pageJson("T"));
      ok(await dispatch(operation, { ...payload, filter_properties: ["Status"], verbose: true }));
      expect(filterOf(sent[0])).toEqual(["Status"]);
    });

    it("sends no filter when none is asked for", async () => {
      const sent = reply(pageJson("T"));
      ok(await dispatch(operation, payload));
      expect(sent[0].url.search).toBe("");
    });
  });

  describe("search_pages", () => {
    it("filters a single page of results", async () => {
      const sent = reply(listJson([pageJson("Plan")]));
      ok(await dispatch("search_pages", { query: "Plan", filter_properties: ["Status"] }));
      expect(sent[0].method).toBe("POST");
      expect(sent[0].url.pathname).toBe("/v1/search");
      expect(filterOf(sent[0])).toEqual(["Status", "title"]);
      expect(sent[0].body).toEqual({ query: "Plan", page_size: 10 });
    });

    it("filters every page of a paginated walk", async () => {
      const sent = reply(listJson([pageJson("Plan")]));
      ok(await dispatch("search_pages", { query: "Plan", paginate: true, filter_properties: ["Status"] }));
      expect(filterOf(sent[0])).toEqual(["Status", "title"]);
    });

    it("keeps the title for ranking even with verbose", async () => {
      const sent = reply(listJson([pageJson("Plan")]));
      const res = ok(
        await dispatch("search_pages", {
          query: "Plan",
          ranking: "title_relevance",
          verbose: true,
          filter_properties: ["Status"],
        })
      );
      expect(filterOf(sent[0])).toEqual(["Status", "title"]);
      expect(res.data.results).toHaveLength(1);
    });

    it("sends exactly the list with verbose", async () => {
      const sent = reply(listJson([pageJson("Plan")]));
      ok(await dispatch("search_pages", { query: "Plan", verbose: true, filter_properties: ["Status"] }));
      expect(filterOf(sent[0])).toEqual(["Status"]);
    });

    it("sends no filter when none is asked for", async () => {
      const sent = reply(listJson([pageJson("Plan")]));
      ok(await dispatch("search_pages", { query: "Plan" }));
      expect(sent[0].url.search).toBe("");
    });
  });

  describe("values", () => {
    it("does not add title twice", async () => {
      const sent = reply(pageJson("T"));
      ok(await dispatch("set_page_title", { page_id: PAGE_ID, title: "x", filter_properties: ["title", "Status"] }));
      expect(filterOf(sent[0])).toEqual(["title", "Status"]);
    });

    it("passes a percent-encoded property id through unchanged", async () => {
      const sent = reply(pageJson("T"));
      ok(await dispatch("restore_page", { page_id: PAGE_ID, filter_properties: ["%3AqZ%3B"], verbose: true }));
      expect(sent[0].url.search).toBe("?filter_properties=%3AqZ%3B");
      expect(filterOf(sent[0])).toEqual([":qZ;"]);
    });

    it("sends a name with a bare percent sign", async () => {
      const sent = reply(pageJson("T"));
      ok(await dispatch("restore_page", { page_id: PAGE_ID, filter_properties: ["Progress %"], verbose: true }));
      expect(filterOf(sent[0])).toEqual(["Progress %"]);
    });

    it("rejects an empty list", async () => {
      const sent = reply(pageJson("T"));
      const res = (await dispatch("restore_page", { page_id: PAGE_ID, filter_properties: [] })) as OperationResult;
      expect(res.ok).toBe(false);
      expect(sent).toHaveLength(0);
    });
  });

  it("keeps the slim title of a filtered write", async () => {
    reply(pageJson("Kept"));
    const res = ok(await dispatch("set_page_title", { page_id: PAGE_ID, title: "Kept", filter_properties: ["Status"] }));
    expect(res.data.title).toBe("Kept");
  });
});
