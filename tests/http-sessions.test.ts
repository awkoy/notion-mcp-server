import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock the Notion client so dispatch/auth-probe work without a real token.
const notionStub = {
  users: { me: vi.fn(async () => ({ id: "bot", name: "Test Bot" })) },
};
vi.mock("../src/services/notion.js", () => ({ getClient: async () => notionStub }));

import { initOperations } from "../src/operations/index.js";
import { startHttp, type HttpHandle } from "../src/server/http.js";
import { parseHttpConfig } from "../src/config/http.js";

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

const config = parseHttpConfig({ MCP_TRANSPORT: "http", PORT: "0", HOST: "127.0.0.1" });

/** Open a 2025-era session and return its id. */
async function openSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT },
    body: INIT_BODY,
  });
  expect(res.status).toBe(200);
  await res.body?.cancel();
  const id = res.headers.get("mcp-session-id");
  expect(id).toBeTruthy();
  return id!;
}

/** tools/list on an existing session: 200 while it lives, 404 once it is gone. */
async function listStatus(port: number, sessionId: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  await res.body?.cancel();
  return res.status;
}

beforeAll(async () => {
  await initOperations();
});

describe("startHttp refuses an unauthenticated non-loopback bind", () => {
  it("rejects before binding", async () => {
    await expect(
      startHttp(parseHttpConfig({ MCP_TRANSPORT: "http", PORT: "0", HOST: "0.0.0.0" }))
    ).rejects.toThrow(/MCP_AUTH_TOKEN/);
  });
});

describe("legacy session limits", () => {
  let idle: HttpHandle;
  let capped: HttpHandle;

  beforeAll(async () => {
    idle = await startHttp(config, { idleMs: 150, sweepMs: 50, max: 100 });
    capped = await startHttp(config, { idleMs: 60_000, sweepMs: 60_000, max: 2 });
  });
  afterAll(async () => {
    await idle.close();
    await capped.close();
  });

  it("closes a session nobody has used for idleMs", async () => {
    const id = await openSession(idle.port);
    expect(await listStatus(idle.port, id)).toBe(200);
    await new Promise((r) => setTimeout(r, 400));
    expect(await listStatus(idle.port, id)).toBe(404);
  });

  it("keeps a session whose requests keep coming", async () => {
    const id = await openSession(idle.port);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 80));
      expect(await listStatus(idle.port, id)).toBe(200);
    }
  });

  it("at the cap, a new initialize evicts the session idle the longest", async () => {
    const first = await openSession(capped.port);
    await new Promise((r) => setTimeout(r, 20));
    const second = await openSession(capped.port);
    await new Promise((r) => setTimeout(r, 20));
    // Touch `first` so `second` is now the longest idle.
    expect(await listStatus(capped.port, first)).toBe(200);
    const third = await openSession(capped.port);
    expect(await listStatus(capped.port, first)).toBe(200);
    expect(await listStatus(capped.port, second)).toBe(404);
    expect(await listStatus(capped.port, third)).toBe(200);
  });
});
