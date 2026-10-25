import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import type { OperationResult } from "../src/operations/types.js";

// The real SDK client and dispatch, with node-fetch underneath stubbed: each
// test scripts the HTTP responses and counts the requests that go out, so the
// counts include every retry from every layer.

// vi.mock is hoisted above the imports, so the stub it hands out must be too.
const { fetchStub } = vi.hoisted(() => ({ fetchStub: vi.fn() }));
vi.mock("node-fetch", () => ({ default: fetchStub }));

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";
import { getClient } from "../src/services/notion.js";
import { withCallContext } from "../src/services/call-context.js";
import { rateLimiter } from "../src/dispatch/rate-limit.js";

// node-fetch's own Response, as production gets it: its `headers` is
// node-fetch's Headers class, not the global one.
const { Response: NodeFetchResponse } =
  await vi.importActual<typeof import("node-fetch")>("node-fetch");

const BLOCK = "3ab5030f-c6e5-8182-a41b-e48b46176e7b";
const PAGE = "3ab5030f-c6e5-8109-b32f-dbd2c4093059";
const UPLOAD = "3ab5030f-c6e5-81aa-9f00-0012e0f1a2b3";
const UPLOAD_JSON = {
  object: "file_upload",
  id: UPLOAD,
  status: "uploaded",
  filename: "note.txt",
  content_type: "text/plain",
};
const EMPTY_LIST = { object: "list", results: [], next_cursor: null, has_more: false };
const BLOCK_JSON = {
  object: "block",
  id: BLOCK,
  type: "paragraph",
  has_children: false,
  archived: false,
  paragraph: { rich_text: [] },
};

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function ok(body: unknown = BLOCK_JSON): Reply {
  return { status: 200, body };
}

function notionError(
  status: number,
  code: string,
  opts: { headers?: Record<string, string>; additional_data?: Record<string, string> } = {}
): Reply {
  return {
    status,
    headers: opts.headers,
    body: {
      object: "error",
      status,
      code,
      message: `stubbed ${code}`,
      ...(opts.additional_data ? { additional_data: opts.additional_data } : {}),
    },
  };
}

// Answer requests with `replies` in order; the last one repeats.
function script(...replies: Reply[]): { methods: string[] } {
  const methods: string[] = [];
  fetchStub.mockImplementation(async (_url: unknown, init?: { method?: string }) => {
    const reply = replies[Math.min(methods.length, replies.length - 1)];
    methods.push(init?.method ?? "GET");
    return new NodeFetchResponse(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  });
  return { methods };
}

function errorCode(res: unknown): string | undefined {
  const r = res as OperationResult;
  return r.ok ? undefined : r.error.code;
}

const NOW = { "retry-after": "0" };

describe("dispatch over the real SDK — retries", () => {
  const originalToken = process.env.NOTION_TOKEN;

  beforeAll(async () => {
    process.env.NOTION_TOKEN = "ntn_retry_http_test";
    await initOperations();
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
  });

  beforeEach(() => {
    fetchStub.mockReset();
  });

  describe("one retry layer, per request", () => {
    it("sends five requests for a read that keeps getting 429, not five per SDK retry", async () => {
      const http = script(notionError(429, "rate_limited", { headers: NOW }));
      const res = await dispatch("get_block", { block_id: BLOCK });
      expect(errorCode(res)).toBe("rate_limited");
      expect(http.methods).toHaveLength(5);
    });

    it("sends five requests for a GET that keeps getting 503 (the SDK would retry each one too)", async () => {
      const http = script(notionError(503, "service_unavailable", { headers: NOW }));
      const res = await dispatch("get_block", { block_id: BLOCK });
      expect(errorCode(res)).toBe("service_unavailable");
      expect(http.methods).toHaveLength(5);
    });
  });

  describe("pacing", () => {
    const refs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r-${i}` }));
    const listPage = (values: unknown[], next: string | null) => ({
      object: "list",
      type: "property_item",
      results: values.map((relation) => ({ object: "property_item", type: "relation", relation })),
      has_more: next !== null,
      next_cursor: next,
    });

    it("takes a token for every request, and a 429 on one property page retries only that page", async () => {
      const all = refs(130);
      const http = script(
        ok({
          object: "page",
          id: PAGE,
          url: "https://notion.so/p",
          parent: { type: "data_source_id", data_source_id: "ds-1" },
          in_trash: false,
          properties: {
            Name: { id: "title", type: "title", title: [{ plain_text: "Row" }] },
            Tasks: { id: "rel1", type: "relation", relation: all.slice(0, 25), has_more: true },
          },
        }),
        ok(listPage(all.slice(0, 100), "c-2")),
        notionError(429, "rate_limited", { headers: NOW }),
        ok(listPage(all.slice(100), null))
      );
      const acquire = vi.spyOn(rateLimiter, "acquire");
      try {
        const res = (await dispatch("get_page", { page_id: PAGE, include_properties: true })) as {
          ok: boolean;
          data: { properties: Record<string, unknown[]> };
        };
        expect(res.ok).toBe(true);
        expect(res.data.properties.Tasks).toHaveLength(130);
        expect(http.methods).toEqual(["GET", "GET", "GET", "GET"]);
        expect(acquire).toHaveBeenCalledTimes(4);
      } finally {
        acquire.mockRestore();
      }
    });
  });

  describe("reads", () => {
    it("retries a 500 and returns the block", async () => {
      const http = script(notionError(500, "internal_server_error"), ok());
      const res = (await dispatch("get_block", { block_id: BLOCK })) as OperationResult;
      expect(res.ok).toBe(true);
      expect(http.methods).toEqual(["GET", "GET"]);
    });

    it("retries a read operation's POST on 500 (search is a POST)", async () => {
      const http = script(notionError(500, "internal_server_error"), ok(EMPTY_LIST));
      const res = (await dispatch("search_pages", { query: "x" })) as OperationResult;
      expect(res.ok).toBe(true);
      expect(http.methods).toEqual(["POST", "POST"]);
    });

    it("retries a GET on 500 inside a write (schema lookups)", async () => {
      const http = script(notionError(500, "internal_server_error"), ok());
      const notion = await getClient();
      await withCallContext("write", () => notion.blocks.retrieve({ block_id: BLOCK }));
      expect(http.methods).toEqual(["GET", "GET"]);
    });

    it("waits out a Retry-After header from node-fetch's Headers", async () => {
      const http = script(notionError(429, "rate_limited", { headers: { "retry-after": "0.4" } }), ok());
      const started = Date.now();
      const res = (await dispatch("get_block", { block_id: BLOCK })) as OperationResult;
      expect(res.ok).toBe(true);
      expect(http.methods).toHaveLength(2);
      // The computed backoff before the second attempt is at most 250 ms.
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    });
  });

  describe("writes", () => {
    it.each([
      [500, "internal_server_error"],
      [503, "service_unavailable"],
      [504, "gateway_timeout"],
    ])("does not retry a DELETE answered %i", async (status, code) => {
      const http = script(notionError(status, code, { headers: NOW }), ok());
      const res = await dispatch("delete_block", { block_id: BLOCK });
      expect(errorCode(res)).toBe(code);
      expect(http.methods).toEqual(["DELETE"]);
    });

    it("retries a 429 and succeeds", async () => {
      const http = script(notionError(429, "rate_limited", { headers: NOW }), ok());
      const res = (await dispatch("delete_block", { block_id: BLOCK })) as OperationResult;
      expect(res.ok).toBe(true);
      expect(http.methods).toEqual(["DELETE", "DELETE"]);
    });

    it("retries a 529 and succeeds", async () => {
      const http = script(notionError(529, "service_overload", { headers: NOW }), ok());
      const res = (await dispatch("delete_block", { block_id: BLOCK })) as OperationResult;
      expect(res.ok).toBe(true);
      expect(http.methods).toEqual(["DELETE", "DELETE"]);
    });

    it("waits out additional_data.retry_after when there is no header", async () => {
      const http = script(
        notionError(429, "rate_limited", { additional_data: { retry_after: "0.4" } }),
        ok()
      );
      const started = Date.now();
      const res = (await dispatch("delete_block", { block_id: BLOCK })) as OperationResult;
      expect(res.ok).toBe(true);
      expect(http.methods).toHaveLength(2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    });

    it("returns the 429 at once when Retry-After is longer than a minute", async () => {
      const http = script(notionError(429, "rate_limited", { headers: { "retry-after": "90" } }), ok());
      const res = await dispatch("delete_block", { block_id: BLOCK });
      expect(errorCode(res)).toBe("rate_limited");
      expect(http.methods).toEqual(["DELETE"]);
    });

    it("retries a request rate limited halfway through a call, not the call", async () => {
      // The append lands, then the delete is rate limited. Only the delete
      // is sent again; running the handler again would append twice.
      const http = script(
        ok({ object: "list", results: [BLOCK_JSON], next_cursor: null, has_more: false }),
        notionError(429, "rate_limited", { headers: NOW }),
        ok()
      );
      const res = (await dispatch("batch_mixed_blocks", {
        operations: [
          { op: "append", block_id: PAGE, markdown: "Hello" },
          { op: "delete", block_id: BLOCK },
        ],
      })) as OperationResult;
      expect(res.ok).toBe(true);
      expect(http.methods).toEqual(["PATCH", "DELETE", "DELETE"]);
    });

    it("retries an upload's send after its create, on 429", async () => {
      const http = script(
        ok(UPLOAD_JSON),
        notionError(429, "rate_limited", { headers: NOW }),
        ok(UPLOAD_JSON)
      );
      const res = (await dispatch("upload_file", {
        source: { type: "base64", data: Buffer.from("hello").toString("base64") },
        filename: "note.txt",
        content_type: "text/plain",
      })) as OperationResult;
      expect(res.ok).toBe(true);
      expect(http.methods).toEqual(["POST", "POST", "POST"]);
    });

    it("says the call was partly applied when a later write request fails", async () => {
      const http = script(
        ok({ object: "list", results: [BLOCK_JSON], next_cursor: null, has_more: false }),
        notionError(500, "internal_server_error", { headers: NOW })
      );
      const res = (await dispatch("batch_mixed_blocks", {
        operations: [
          { op: "append", block_id: PAGE, markdown: "Hello" },
          { op: "delete", block_id: BLOCK },
        ],
      })) as OperationResult;
      expect(http.methods).toEqual(["PATCH", "DELETE"]);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("internal_server_error");
      expect(res.error.message).toMatch(/already applied/);
    });

    it("does not say so when the first write request fails", async () => {
      script(notionError(500, "internal_server_error", { headers: NOW }));
      const res = (await dispatch("delete_block", { block_id: BLOCK })) as OperationResult;
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.message).not.toMatch(/already applied/);
    });
  });

  describe("requests outside a dispatched call", () => {
    // An atomic batch's rollback trashes what it created after the items ran.
    it("retries a PATCH on 429", async () => {
      const http = script(notionError(429, "rate_limited", { headers: NOW }), ok());
      const notion = await getClient();
      await notion.blocks.update({ block_id: BLOCK, in_trash: true });
      expect(http.methods).toEqual(["PATCH", "PATCH"]);
    });

    it("does not retry a PATCH on 500", async () => {
      const http = script(notionError(500, "internal_server_error", { headers: NOW }), ok());
      const notion = await getClient();
      await expect(notion.blocks.update({ block_id: BLOCK, in_trash: true })).rejects.toMatchObject({
        status: 500,
      });
      expect(http.methods).toEqual(["PATCH"]);
    });
  });
});
