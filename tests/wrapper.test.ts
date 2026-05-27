import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Drive the actual MCP wrapper (notion_execute / notion_describe) through an
// in-memory transport pair. This catches plumbing bugs that the unit-level
// `dispatch` tests miss — e.g. payload unwrapping at the z.unknown() boundary,
// the isError surfacing, structured batch responses going back as non-error
// text content.

const notionStub = {
  databases: { retrieve: vi.fn(), query: vi.fn(), create: vi.fn(), update: vi.fn() },
  dataSources: { query: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
  pages: {
    move: vi.fn(),
    retrieveMarkdown: vi.fn(),
    updateMarkdown: vi.fn(),
    update: vi.fn(),
  },
  comments: { retrieve: vi.fn(), update: vi.fn(), delete: vi.fn() },
  blocks: { children: { append: vi.fn() } },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

// Imports must come after vi.mock() — these load operations that pull the
// stubbed `getClient`.
import { server } from "../src/server/index.js";
import { registerAllTools } from "../src/tools/index.js";

let client: Client;

beforeAll(async () => {
  await registerAllTools();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "wrapper-test", version: "0.0.0" });
  await client.connect(clientTransport);
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

// Helper: pull the JSON envelope back out of the CallToolResult text content.
function readJson(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error(`Expected text content, got: ${JSON.stringify(result)}`);
  }
  return JSON.parse(block.text);
}

describe("MCP wrapper: listTools", () => {
  it("advertises notion_execute and notion_describe", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("notion_execute");
    expect(names).toContain("notion_describe");
  });
});

describe("MCP wrapper: notion_execute happy path", () => {
  it("forwards {operation, payload} to dispatch and returns slim JSON in text content", async () => {
    notionStub.pages.update.mockResolvedValue({
      object: "page",
      id: "p-1",
      url: "https://notion.so/p-1",
      in_trash: true,
      properties: {},
      parent: { type: "page_id", page_id: "parent" },
      created_time: "t1",
      last_edited_time: "t2",
      icon: null,
    });

    const result = await client.callTool({
      name: "notion_execute",
      arguments: {
        operation: "archive_page",
        payload: { page_id: "p-1" },
      },
    });
    expect(result.isError).toBeFalsy();
    const data = readJson(result as Parameters<typeof readJson>[0]);
    expect(data).toMatchObject({
      ok: true,
      data: { id: "p-1", in_trash: true },
    });
    expect(notionStub.pages.update).toHaveBeenCalledWith({
      page_id: "p-1",
      in_trash: true,
    });
  });
});

describe("MCP wrapper: notion_execute batch envelope", () => {
  it("recognises items[] payload as a batch and returns structured result (not isError) even on partial failure", async () => {
    notionStub.pages.update
      .mockResolvedValueOnce({
        object: "page",
        id: "p-1",
        url: "u",
        in_trash: true,
        properties: {},
        parent: { type: "page_id", page_id: "x" },
        created_time: "t1",
        last_edited_time: "t2",
        icon: null,
      })
      .mockRejectedValueOnce(new Error("p-2 boom"));

    const result = await client.callTool({
      name: "notion_execute",
      arguments: {
        operation: "archive_page",
        payload: {
          items: [{ page_id: "p-1" }, { page_id: "p-2" }],
          atomic: false,
        },
      },
    });

    // Partial batch failure must come back as structured data, not isError —
    // otherwise clients can't reach the per-item results.
    expect(result.isError).toBeFalsy();
    const envelope = readJson(result as Parameters<typeof readJson>[0]) as {
      summary: { total: number; succeeded: number; failed: number };
      results: Array<{ ok: boolean }>;
    };
    expect(envelope.summary).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(envelope.results).toHaveLength(2);
  });
});

describe("MCP wrapper: notion_execute validation error", () => {
  it("surfaces validation_error with example payload as isError content", async () => {
    const result = await client.callTool({
      name: "notion_execute",
      arguments: {
        operation: "archive_page",
        payload: {}, // missing required page_id
      },
    });
    expect(result.isError).toBe(true);
    const body = readJson(result as Parameters<typeof readJson>[0]) as {
      ok: boolean;
      error: { code: string; example?: unknown };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.example).toMatchObject({ page_id: expect.any(String) });
    expect(notionStub.pages.update).not.toHaveBeenCalled();
  });

  it("surfaces unknown_operation as isError content", async () => {
    const result = await client.callTool({
      name: "notion_execute",
      arguments: {
        operation: "totally_made_up",
        payload: {},
      },
    });
    expect(result.isError).toBe(true);
    const body = readJson(result as Parameters<typeof readJson>[0]) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("unknown_operation");
  });
});

describe("MCP wrapper: notion_describe", () => {
  it("returns schema + example for a known operation", async () => {
    const result = await client.callTool({
      name: "notion_describe",
      arguments: { operation: "archive_page" },
    });
    expect(result.isError).toBeFalsy();
    const body = readJson(result as Parameters<typeof readJson>[0]) as {
      name: string;
      schema: unknown;
      example: unknown;
      batchable: boolean;
    };
    expect(body.name).toBe("archive_page");
    expect(body.batchable).toBe(true);
    expect(body.example).toMatchObject({ page_id: expect.any(String) });
    expect(body.schema).toBeTypeOf("object");
  });

  it("returns unknown_operation error for a bogus name", async () => {
    const result = await client.callTool({
      name: "notion_describe",
      arguments: { operation: "nope_nope_nope" },
    });
    expect(result.isError).toBe(true);
    const body = readJson(result as Parameters<typeof readJson>[0]) as {
      ok: boolean;
      error: { code: string };
    };
    expect(body.error.code).toBe("unknown_operation");
  });
});

describe("MCP wrapper: operations resource", () => {
  it("serves notion://operations as a markdown table", async () => {
    const res = await client.readResource({ uri: "notion://operations" });
    expect(res.contents).toHaveLength(1);
    const block = res.contents[0];
    if (!("text" in block) || typeof block.text !== "string") {
      throw new Error("Expected text resource content");
    }
    expect(block.text).toContain("Notion MCP — Operations");
    expect(block.text).toContain("archive_page");
    expect(block.text).toContain("notion_execute");
  });
});
