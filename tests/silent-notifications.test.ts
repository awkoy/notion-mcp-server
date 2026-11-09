import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { OperationResult } from "../src/operations/types.js";

// The real SDK client and dispatch, with node-fetch stubbed. The SDK sends only
// the body parameters it lists for an endpoint, so a parameter is proven only
// once it shows up in the bytes handed to fetch.

const { fetchStub } = vi.hoisted(() => ({ fetchStub: vi.fn() }));
vi.mock("node-fetch", () => ({ default: fetchStub }));

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

const { Response: NodeFetchResponse } =
  await vi.importActual<typeof import("node-fetch")>("node-fetch");

const PAGE = "3ab5030f-c6e5-8109-b32f-dbd2c4093059";
const PAGE_2 = "3ab5030f-c6e5-8109-b32f-dbd2c4093060";
const PARENT = "3ab5030f-c6e5-8109-b32f-dbd2c4093061";
const BLOCK = "3ab5030f-c6e5-8182-a41b-e48b46176e7b";

const PAGE_JSON = {
  object: "page",
  id: PAGE,
  url: "https://www.notion.so/test",
  created_time: "2026-11-09T00:00:00.000Z",
  last_edited_time: "2026-11-09T00:00:00.000Z",
  in_trash: false,
  parent: { type: "page_id", page_id: PARENT },
  properties: { title: { id: "title", type: "title", title: [] } },
};
const BLOCK_JSON = {
  object: "block",
  id: BLOCK,
  type: "paragraph",
  has_children: false,
  archived: false,
  paragraph: { rich_text: [] },
};

type Sent = { method: string; path: string; body: Record<string, unknown> };

/**
 * Answer every request like Notion would and record what went out.
 * `failAppend` turns block appends into a 400, for the partial-write path.
 */
function captureRequests(opts: { failAppend?: boolean } = {}): Sent[] {
  const sent: Sent[] = [];
  fetchStub.mockImplementation(async (url: unknown, init?: { method?: string; body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const path = new URL(String(url)).pathname.replace(/^\/v1\//, "");
    sent.push({ method: (init?.method ?? "GET").toUpperCase(), path, body });
    const isAppend = path.endsWith("/children");
    const [status, reply] =
      isAppend && opts.failAppend
        ? [400, { object: "error", status: 400, code: "validation_error", message: "stubbed" }]
        : isAppend
          ? [
              200,
              {
                object: "list",
                results: (body.children as unknown[]).map(() => BLOCK_JSON),
                next_cursor: null,
                has_more: false,
              },
            ]
          : [200, PAGE_JSON];
    return new NodeFetchResponse(JSON.stringify(reply), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return sent;
}

const SILENT = { mode: "silent" } as const;

function paragraph(i: number) {
  return { type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: `p${i}` } }] } };
}

function isOk(res: unknown): boolean {
  return (res as OperationResult).ok;
}

describe("page notifications — outgoing request body", () => {
  const originalToken = process.env.NOTION_TOKEN;

  beforeAll(async () => {
    process.env.NOTION_TOKEN = "ntn_silent_notifications_test";
    await initOperations();
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
  });

  beforeEach(() => {
    fetchStub.mockReset();
  });

  const SINGLE: Array<[string, Record<string, unknown>, string, string]> = [
    ["create_page", { parent: { type: "page_id", page_id: PARENT }, title: "t" }, "POST", "pages"],
    ["set_page_title", { page_id: PAGE, title: "t" }, "PATCH", `pages/${PAGE}`],
    [
      "set_page_property",
      { page_id: PAGE, name: "Done", value: { type: "checkbox", checkbox: true } },
      "PATCH",
      `pages/${PAGE}`,
    ],
    [
      "set_page_properties",
      { page_id: PAGE, properties: { Done: { type: "checkbox", checkbox: true } } },
      "PATCH",
      `pages/${PAGE}`,
    ],
    ["archive_page", { page_id: PAGE }, "PATCH", `pages/${PAGE}`],
    ["trash_page", { page_id: PAGE }, "PATCH", `pages/${PAGE}`],
    ["restore_page", { page_id: PAGE }, "PATCH", `pages/${PAGE}`],
  ];

  it.each(SINGLE)("%s sends notifications.mode to Notion", async (op, payload, method, path) => {
    const sent = captureRequests();
    const res = await dispatch(op, { ...payload, notifications: SILENT });
    expect(isOk(res)).toBe(true);
    const write = sent.find((r) => r.method === method && r.path === path);
    expect(write?.body.notifications).toEqual(SILENT);
  });

  it.each(SINGLE)("%s leaves notifications out when it is not passed", async (op, payload, method, path) => {
    const sent = captureRequests();
    const res = await dispatch(op, payload);
    expect(isOk(res)).toBe(true);
    const write = sent.find((r) => r.method === method && r.path === path);
    expect(write).toBeDefined();
    expect(write?.body).not.toHaveProperty("notifications");
  });

  it("passes mode default through", async () => {
    const sent = captureRequests();
    await dispatch("set_page_title", { page_id: PAGE, title: "t", notifications: { mode: "default" } });
    expect(sent[0].body.notifications).toEqual({ mode: "default" });
  });

  it("rejects an unknown mode before any request goes out", async () => {
    const sent = captureRequests();
    const res = await dispatch("set_page_title", { page_id: PAGE, title: "t", notifications: { mode: "quiet" } });
    expect(isOk(res)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("does not warn that the field was ignored", async () => {
    captureRequests();
    const res = (await dispatch("set_page_title", {
      page_id: PAGE,
      title: "t",
      notifications: SILENT,
    })) as { warnings?: string[] };
    expect(res.warnings).toBeUndefined();
  });

  it("applies per item in a batch", async () => {
    const sent = captureRequests();
    const res = await dispatch("set_page_title", {
      items: [
        { page_id: PAGE, title: "quiet", notifications: SILENT },
        { page_id: PAGE_2, title: "loud" },
      ],
      concurrency: 1,
    });
    expect((res as { summary: { succeeded: number } }).summary.succeeded).toBe(2);
    const body = (id: string) => sent.find((r) => r.path === `pages/${id}`)?.body;
    expect(body(PAGE)?.notifications).toEqual(SILENT);
    expect(body(PAGE_2)).not.toHaveProperty("notifications");
  });

  describe("create_page with content past one request", () => {
    it("keeps silent on every block append, at each depth", async () => {
      const sent = captureRequests();
      const children = [
        {
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [{ type: "text", text: { content: "parent" } }],
            children: Array.from({ length: 150 }, (_, i) => paragraph(i)),
          },
        },
      ];
      const res = await dispatch("create_page", {
        parent: { type: "page_id", page_id: PARENT },
        title: "big",
        children,
        notifications: SILENT,
      });
      expect(isOk(res)).toBe(true);
      const appends = sent.filter((r) => r.path.endsWith("/children"));
      // One append under the page, then the overflow under the list item.
      expect(appends.map((r) => r.path)).toEqual([`blocks/${PAGE}/children`, `blocks/${BLOCK}/children`]);
      for (const append of appends) expect(append.body.notifications).toEqual(SILENT);
    });

    it("sends no notifications field on appends for a normal create", async () => {
      const sent = captureRequests();
      await dispatch("create_page", {
        parent: { type: "page_id", page_id: PARENT },
        title: "big",
        children: Array.from({ length: 150 }, (_, i) => paragraph(i)),
      });
      const appends = sent.filter((r) => r.path.endsWith("/children"));
      expect(appends.length).toBeGreaterThan(0);
      for (const append of appends) expect(append.body).not.toHaveProperty("notifications");
    });

    it("trashes a half-written page silently too", async () => {
      const sent = captureRequests({ failAppend: true });
      const res = await dispatch("create_page", {
        parent: { type: "page_id", page_id: PARENT },
        title: "big",
        children: Array.from({ length: 150 }, (_, i) => paragraph(i)),
        notifications: SILENT,
      });
      expect(isOk(res)).toBe(false);
      const trash = sent.find((r) => r.method === "PATCH" && r.path === `pages/${PAGE}`);
      expect(trash?.body).toMatchObject({ in_trash: true, notifications: SILENT });
    });
  });
});
