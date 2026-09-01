import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock the Notion client so dispatch/auth-probe work without a real token.
const notionStub = {
  databases: { retrieve: vi.fn(), query: vi.fn(), create: vi.fn(), update: vi.fn() },
  dataSources: { query: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
  pages: { move: vi.fn(), retrieveMarkdown: vi.fn(), updateMarkdown: vi.fn(), update: vi.fn() },
  comments: { retrieve: vi.fn(), update: vi.fn(), delete: vi.fn() },
  blocks: { children: { append: vi.fn() } },
  users: { me: vi.fn(async () => ({ id: "bot", name: "Test Bot" })) },
};
vi.mock("../src/services/notion.js", () => ({ getClient: async () => notionStub }));

import { initOperations } from "../src/operations/index.js";
import { startHttp, type HttpHandle } from "../src/server/http.js";
import { parseHttpConfig } from "../src/config/http.js";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const ACCEPT = "application/json, text/event-stream";
const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});

// Both servers stay alive for the whole file. With PORT=0, closing one server
// frees its ephemeral port; the OS can hand the same port to the next server, but
// undici's global pool still holds a dead keep-alive socket to it and reuses it for
// the first request (ECONNRESET). Keeping both bound simultaneously gives them
// distinct ports and avoids that purely-client-side reuse hazard.
let noAuth: HttpHandle;
let auth: HttpHandle;

beforeAll(async () => {
  await initOperations();
  noAuth = await startHttp(
    parseHttpConfig({ MCP_TRANSPORT: "http", PORT: "0", HOST: "127.0.0.1" })
  );
  auth = await startHttp(
    parseHttpConfig({
      MCP_TRANSPORT: "http",
      PORT: "0",
      HOST: "127.0.0.1",
      MCP_AUTH_TOKEN: "sekret",
    })
  );
});
afterAll(async () => {
  await noAuth.close();
  await auth.close();
});

describe("Streamable HTTP transport (no auth)", () => {
  it("completes the MCP handshake and lists notion_read, notion_write and notion_describe", async () => {
    const client = new Client({ name: "http-it", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${noAuth.port}/mcp`))
    );
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("notion_read");
    expect(names).toContain("notion_write");
    expect(names).not.toContain("notion_execute");
    expect(names).toContain("notion_describe");
    await client.close();
  });

  it("serves /health without a session or auth", async () => {
    const res = await fetch(`http://127.0.0.1:${noAuth.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("healthy");
  });

  it("400s a POST with no session id and a non-initialize body", async () => {
    const res = await fetch(`http://127.0.0.1:${noAuth.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("Streamable HTTP transport (auth required)", () => {
  it("401s a /mcp request without a bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${auth.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: ACCEPT },
      body: INIT_BODY,
    });
    expect(res.status).toBe(401);
  });

  it("403s a /mcp request with a wrong bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${auth.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: ACCEPT,
        authorization: "Bearer nope",
      },
      body: INIT_BODY,
    });
    expect(res.status).toBe(403);
  });

  it("still serves /health without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${auth.port}/health`);
    expect(res.status).toBe(200);
  });
});
