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

// node-fetch's own Response, as production gets it: its `headers` is
// node-fetch's Headers class, not the global one.
const { Response: NodeFetchResponse } =
  await vi.importActual<typeof import("node-fetch")>("node-fetch");

const BLOCK = "3ab5030f-c6e5-8182-a41b-e48b46176e7b";
const PAGE = "3ab5030f-c6e5-8109-b32f-dbd2c4093059";
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

  describe("one retry layer", () => {
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

  describe("reads", () => {
    it("retries a 500 and returns the block", async () => {
      const http = script(notionError(500, "internal_server_error"), ok());
      const res = (await dispatch("get_block", { block_id: BLOCK })) as OperationResult;
      expect(res.ok).toBe(true);
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

    it("does not re-run a handler after one of its requests was written", async () => {
      // The append lands, then the delete is rate limited. Running the
      // handler again would append the paragraph a second time.
      const http = script(
        ok({ object: "list", results: [BLOCK_JSON], next_cursor: null, has_more: false }),
        notionError(429, "rate_limited", { headers: NOW })
      );
      const res = await dispatch("batch_mixed_blocks", {
        operations: [
          { op: "append", block_id: PAGE, markdown: "Hello" },
          { op: "delete", block_id: BLOCK },
        ],
      });
      expect(errorCode(res)).toBe("rate_limited");
      expect(http.methods).toEqual(["PATCH", "DELETE"]);
    });
  });
});
