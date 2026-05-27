import { describe, it, expect, beforeAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Drive prompts/list and prompts/get through the in-memory transport pair —
// same pattern as tests/wrapper.test.ts, so we exercise the real MCP wire
// formatting (argument validation, message envelope) rather than the prompt
// callbacks in isolation.

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

import { server } from "../src/server/index.js";
import { registerAllTools } from "../src/tools/index.js";

let client: Client;

beforeAll(async () => {
  await registerAllTools();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "prompts-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

function firstUserText(result: { messages: Array<{ role: string; content: { type: string; text?: string } }> }): string {
  const msg = result.messages[0];
  if (!msg || msg.role !== "user" || msg.content.type !== "text" || typeof msg.content.text !== "string") {
    throw new Error(`Expected single user-text message, got: ${JSON.stringify(result)}`);
  }
  return msg.content.text;
}

describe("MCP wrapper: listPrompts", () => {
  it("advertises all four templates", async () => {
    const { prompts } = await client.listPrompts();
    const names = prompts.map((p) => p.name).sort();
    expect(names).toEqual([
      "create_task",
      "daily_log",
      "find_pages",
      "weekly_review",
    ]);
  });

  it("declares the required argument for create_task", async () => {
    const { prompts } = await client.listPrompts();
    const createTask = prompts.find((p) => p.name === "create_task");
    expect(createTask).toBeDefined();
    const titleArg = createTask?.arguments?.find((a) => a.name === "title");
    expect(titleArg?.required).toBe(true);
  });
});

describe("MCP wrapper: getPrompt happy paths", () => {
  it("create_task templates the title into a notion_execute / create_page instruction", async () => {
    const result = await client.getPrompt({
      name: "create_task",
      arguments: { title: "Ship the prompts feature" },
    });
    const text = firstUserText(result);
    expect(text).toContain("Ship the prompts feature");
    expect(text).toContain("notion_execute");
    expect(text).toContain("create_page");
  });

  it("create_task includes optional status and due when provided", async () => {
    const result = await client.getPrompt({
      name: "create_task",
      arguments: { title: "X", status: "In Progress", due: "2026-06-01" },
    });
    const text = firstUserText(result);
    expect(text).toContain("In Progress");
    expect(text).toContain("2026-06-01");
  });

  it("weekly_review takes no args and instructs query_database with a 7-day filter", async () => {
    const result = await client.getPrompt({ name: "weekly_review", arguments: {} });
    const text = firstUserText(result);
    expect(text).toContain("query_database");
    expect(text).toContain("Done");
    expect(text).toMatch(/7\s*days?/i);
  });

  it("find_pages templates the query into a search_pages call", async () => {
    const result = await client.getPrompt({
      name: "find_pages",
      arguments: { query: "design doc" },
    });
    const text = firstUserText(result);
    expect(text).toContain("design doc");
    expect(text).toContain("search_pages");
    expect(text).toContain("top 5");
  });

  it("daily_log mentions NOTION_DAILY_LOG_PAGE_ID env var and append_blocks", async () => {
    delete process.env.NOTION_DAILY_LOG_PAGE_ID;
    const result = await client.getPrompt({
      name: "daily_log",
      arguments: { content: "Wrote tests" },
    });
    const text = firstUserText(result);
    expect(text).toContain("NOTION_DAILY_LOG_PAGE_ID");
    expect(text).toContain("append_blocks");
    expect(text).toContain("Wrote tests");
  });

  it("daily_log embeds the configured page id when NOTION_DAILY_LOG_PAGE_ID is set", async () => {
    process.env.NOTION_DAILY_LOG_PAGE_ID = "page-abc-123";
    try {
      const result = await client.getPrompt({
        name: "daily_log",
        arguments: {},
      });
      const text = firstUserText(result);
      expect(text).toContain("page-abc-123");
    } finally {
      delete process.env.NOTION_DAILY_LOG_PAGE_ID;
    }
  });
});

describe("MCP wrapper: getPrompt validation", () => {
  it("rejects create_task when the required title argument is missing", async () => {
    await expect(
      client.getPrompt({ name: "create_task", arguments: {} })
    ).rejects.toThrow();
  });

  it("rejects an unknown prompt name", async () => {
    await expect(
      client.getPrompt({ name: "not_a_real_prompt" })
    ).rejects.toThrow();
  });
});

describe("MCP wrapper: tools and resources unaffected by adding prompts", () => {
  it("still advertises notion_execute and notion_describe", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("notion_execute");
    expect(names).toContain("notion_describe");
  });

  it("still serves notion://operations", async () => {
    const res = await client.readResource({ uri: "notion://operations" });
    expect(res.contents).toHaveLength(1);
  });
});
