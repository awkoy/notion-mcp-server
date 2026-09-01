import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/client";

// Drive the actual MCP wrapper (notion_read / notion_write / notion_describe) through an
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
import { createServer } from "../src/server/index.js";
import { initOperations, listOperations } from "../src/operations/index.js";
import { configureOperationAccess } from "../src/operations/access.js";

let client: Client;

beforeAll(async () => {
  await initOperations();
  const server = createServer();
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

type ToolSchema = { properties?: Record<string, { enum?: string[] }> };
const enumOf = (schema: unknown): string[] =>
  (schema as ToolSchema).properties?.operation?.enum ?? [];
const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.map((c) => c.text ?? "").join("");

describe("MCP wrapper: listTools", () => {
  it("advertises notion_read, notion_write and notion_describe — and no notion_execute", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["notion_read", "notion_write", "notion_describe"]);
  });

  it("annotates notion_read as read-only and notion_write as destructive", async () => {
    const { tools } = await client.listTools();
    const read = tools.find((t) => t.name === "notion_read");
    const write = tools.find((t) => t.name === "notion_write");
    expect(read?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(write?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("each tool's operation enum is exactly its access class of the registry", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const ops = listOperations();
    const reads = ops.filter((o) => o.access === "read").map((o) => o.name);
    const writes = ops.filter((o) => o.access === "write").map((o) => o.name);
    expect(enumOf(byName.notion_read?.inputSchema)).toEqual(reads);
    expect(enumOf(byName.notion_write?.inputSchema)).toEqual(writes);
    expect(reads.length).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    // notion_describe deliberately takes any string: the menus above suffice.
    expect(enumOf(byName.notion_describe?.inputSchema)).toEqual([]);
  });
});

describe("MCP wrapper: operation routed to the wrong tool", () => {
  it("notion_read refuses a write operation and names notion_write", async () => {
    const result = await client.callTool({
      name: "notion_read",
      arguments: { operation: "archive_page", payload: { page_id: "p-1" } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result as Parameters<typeof textOf>[0])).toContain(
      '"archive_page" is a write operation: call notion_write instead of notion_read'
    );
    expect(notionStub.pages.update).not.toHaveBeenCalled();
  });

  it("notion_write refuses a read operation and names notion_read", async () => {
    const result = await client.callTool({
      name: "notion_write",
      arguments: { operation: "get_page", payload: { page_id: "p-1" } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result as Parameters<typeof textOf>[0])).toContain(
      '"get_page" is a read operation: call notion_read instead of notion_write'
    );
  });

  it("an unknown name lists the tool's operations", async () => {
    const result = await client.callTool({
      name: "notion_read",
      arguments: { operation: "totally_made_up", payload: {} },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result as Parameters<typeof textOf>[0]);
    expect(text).toContain('Unknown operation "totally_made_up". notion_read accepts: ');
    expect(text).toContain("get_page");
    expect(text).not.toContain("archive_page");
  });
});

describe("MCP wrapper: notion_write happy path", () => {
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
      name: "notion_write",
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

describe("MCP wrapper: notion_write batch envelope", () => {
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
      name: "notion_write",
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

describe("MCP wrapper: notion_write validation error", () => {
  it("surfaces validation_error with example payload as isError content", async () => {
    const result = await client.callTool({
      name: "notion_write",
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
      tool: string;
    };
    expect(body.name).toBe("archive_page");
    expect(body.tool).toBe("notion_write");
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
    expect(block.text).toContain("| `archive_page` | notion_write | yes |");
    expect(block.text).toContain("| `get_page` | notion_read | yes |");
  });
});

describe("MCP wrapper: operation access gating", () => {
  // Restrict to a blocklist for these tests, then restore the all-enabled
  // default so the rest of the suite is unaffected.
  afterEach(() => {
    delete process.env.NOTION_BLOCKED_OPERATIONS;
    configureOperationAccess();
  });

  it("notion_describe rejects a disabled op with operation_not_allowed", async () => {
    process.env.NOTION_BLOCKED_OPERATIONS = "trash_page";
    configureOperationAccess();

    const res = await client.callTool({
      name: "notion_describe",
      arguments: { operation: "trash_page" },
    });
    expect(res.isError).toBe(true);
    const envelope = readJson(res as Parameters<typeof readJson>[0]) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe("operation_not_allowed");
  });

  it("notion://operations omits disabled ops from the rendered menu", async () => {
    process.env.NOTION_BLOCKED_OPERATIONS = "trash_page";
    configureOperationAccess();

    const res = await client.readResource({ uri: "notion://operations" });
    const block = res.contents[0];
    if (!("text" in block) || typeof block.text !== "string") {
      throw new Error("Expected text resource content");
    }
    expect(block.text).not.toContain("`trash_page`");
    // A still-enabled op remains listed.
    expect(block.text).toContain("`get_page`");
  });

  it("notion://operations keeps the WHERE DSL help when query_database is blocked but view ops still use it", async () => {
    process.env.NOTION_BLOCKED_OPERATIONS = "query_database";
    configureOperationAccess();

    const res = await client.readResource({ uri: "notion://operations" });
    const block = res.contents[0];
    if (!("text" in block) || typeof block.text !== "string") {
      throw new Error("Expected text resource content");
    }
    // query_database is gone, but create_view/update_view share the same DSL,
    // so the help stays — now attributed to the still-enabled view ops.
    expect(block.text).not.toContain("`query_database`");
    expect(block.text).toContain("WHERE filter DSL");
    expect(block.text).toContain("`create_view`");
  });

  it("notion://operations drops the WHERE DSL help only when every where-op is blocked", async () => {
    process.env.NOTION_BLOCKED_OPERATIONS = "query_database,create_view,update_view";
    configureOperationAccess();

    const res = await client.readResource({ uri: "notion://operations" });
    const block = res.contents[0];
    if (!("text" in block) || typeof block.text !== "string") {
      throw new Error("Expected text resource content");
    }
    expect(block.text).not.toContain("WHERE filter DSL");
  });
});

describe("MCP wrapper: read-only server", () => {
  let roClient: Client;

  beforeAll(async () => {
    process.env.NOTION_READ_ONLY = "1";
    configureOperationAccess();
    const server = createServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    roClient = new Client({ name: "wrapper-test-ro", version: "0.0.0" });
    await roClient.connect(clientTransport);
    // The tool list was built at registration; later suites want full access.
    delete process.env.NOTION_READ_ONLY;
    configureOperationAccess();
  });

  it("does not advertise notion_write at all", async () => {
    const { tools } = await roClient.listTools();
    expect(tools.map((t) => t.name)).toEqual(["notion_read", "notion_describe"]);
    const read = tools.find((t) => t.name === "notion_read");
    const reads = listOperations()
      .filter((o) => o.access === "read")
      .map((o) => o.name);
    expect(enumOf(read?.inputSchema)).toEqual(reads);
  });

  it("calls to the missing notion_write fail as an unknown tool", async () => {
    await expect(
      roClient.callTool({
        name: "notion_write",
        arguments: { operation: "archive_page", payload: { page_id: "p-1" } },
      })
    ).rejects.toThrow(/notion_write not found/);
  });
});
