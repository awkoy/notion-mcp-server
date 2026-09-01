import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";

// The MCP logging channel end to end: the server declares the `logging`
// capability, forwards its stderr lines as notifications/message, honours the
// level the client sets (info when it never does), scopes the per-call debug
// line to the session that made the call, and never lets a missing or closed
// transport throw into a log call.

const notionStub = {
  pages: { update: vi.fn() },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

// Imports must come after vi.mock() — these load operations that pull the
// stubbed `getClient`.
import { createServer } from "../src/server/index.js";
import { initOperations } from "../src/operations/index.js";
import { log, setProcessLogServer, clientLogLevel } from "../src/utils/log.js";

type LogEntry = { level: string; logger?: string; data?: unknown };
type Session = { client: Client; server: McpServer; received: LogEntry[] };

const PAGE = {
  object: "page",
  id: "p-1",
  url: "https://notion.so/p-1",
  in_trash: true,
  properties: {},
  parent: { type: "page_id", page_id: "parent" },
  created_time: "t1",
  last_edited_time: "t2",
  icon: null,
};

const open: Session[] = [];

async function connect(): Promise<Session> {
  const server = createServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "logging-test", version: "0.0.0" });
  const received: LogEntry[] = [];
  client.setNotificationHandler("notifications/message", (n) => {
    received.push(n.params);
  });
  await client.connect(clientTransport);
  const session = { client, server, received };
  open.push(session);
  return session;
}

function archive(client: Client, payload: Record<string, unknown>) {
  return client.callTool({
    name: "notion_write",
    arguments: { operation: "archive_page", payload },
  });
}

// Send an error-level marker to `session` and wait for it. The transport is
// in-order, so anything the session emitted earlier has landed by then — this
// is how the "not delivered" cases avoid a timer.
async function flush(session: Session, marker = "flush"): Promise<void> {
  log.error(marker, {}, { server: session.server });
  await vi.waitFor(() => {
    const seen = session.received.some(
      (e) => (e.data as { message?: string } | undefined)?.message === marker
    );
    expect(seen).toBe(true);
  });
}

const debugEntries = (received: LogEntry[]): LogEntry[] =>
  received.filter((e) => e.level === "debug");

let stderr: MockInstance<typeof console.error>;

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  notionStub.pages.update.mockReset();
  notionStub.pages.update.mockResolvedValue(PAGE);
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  stderr.mockRestore();
  setProcessLogServer(undefined);
  for (const s of open.splice(0)) await s.client.close();
});

describe("logging capability", () => {
  it("is advertised in the initialize result", async () => {
    const { client } = await connect();
    expect(client.getServerCapabilities()?.logging).toBeDefined();
  });

  it("defaults to info and follows logging/setLevel", async () => {
    const { client, server } = await connect();
    expect(clientLogLevel(server)).toBe("info");
    await client.setLoggingLevel("warning");
    expect(clientLogLevel(server)).toBe("warning");
  });
});

describe("per-call debug line", () => {
  it("reaches a client at debug with operation, outcome and timing — and no payload", async () => {
    const s = await connect();
    await s.client.setLoggingLevel("debug");
    await archive(s.client, { page_id: "p-1" });
    await flush(s);

    const [entry] = debugEntries(s.received);
    expect(entry).toBeDefined();
    expect(entry.logger).toBe("notion-mcp-server");
    expect(entry.data).toMatchObject({
      message: expect.stringContaining("notion_write archive_page ok"),
      operation: "archive_page",
      batch: false,
      ok: true,
      ms: expect.any(Number),
    });
    expect(JSON.stringify(entry.data)).not.toContain("p-1");
  });

  it("reports the batch size and a failed outcome", async () => {
    const s = await connect();
    await s.client.setLoggingLevel("debug");
    notionStub.pages.update
      .mockResolvedValueOnce(PAGE)
      .mockRejectedValueOnce(new Error("boom"));
    await archive(s.client, {
      items: [{ page_id: "p-1" }, { page_id: "p-2" }],
      atomic: false,
    });
    await flush(s);

    expect(debugEntries(s.received)).toHaveLength(1);
    expect(debugEntries(s.received)[0].data).toMatchObject({
      operation: "archive_page",
      batch: true,
      items: 2,
      ok: false,
    });
  });

  it("is not delivered when the client never set a level", async () => {
    const s = await connect();
    await archive(s.client, { page_id: "p-1" });
    await flush(s);
    expect(debugEntries(s.received)).toHaveLength(0);
  });

  it("is not delivered at info", async () => {
    const s = await connect();
    await s.client.setLoggingLevel("info");
    await archive(s.client, { page_id: "p-1" });
    await flush(s);
    expect(debugEntries(s.received)).toHaveLength(0);
  });

  it("goes only to the session that made the call", async () => {
    const a = await connect();
    const b = await connect();
    await a.client.setLoggingLevel("debug");
    await b.client.setLoggingLevel("debug");

    await archive(a.client, { page_id: "p-1" });
    await flush(a);
    await flush(b);

    expect(debugEntries(a.received)).toHaveLength(1);
    expect(debugEntries(b.received)).toHaveLength(0);
  });
});

describe("logger forwarding", () => {
  it("delivers an error-level line to the process server as { message, ...data }", async () => {
    const s = await connect();
    setProcessLogServer(s.server);

    log.error("Notion auth check failed (server still running): nope", {
      code: "unauthorized",
    });
    await vi.waitFor(() => expect(s.received).toHaveLength(1));

    expect(s.received[0]).toMatchObject({
      level: "error",
      logger: "notion-mcp-server",
      data: {
        message: "Notion auth check failed (server still running): nope",
        code: "unauthorized",
      },
    });
  });

  it("drops lines below the client's level but still writes them to stderr", async () => {
    const s = await connect();
    await s.client.setLoggingLevel("warning");

    log.info("quiet", {}, { server: s.server });
    log.warning("loud", {}, { server: s.server });
    await vi.waitFor(() => expect(s.received).toHaveLength(1));

    expect(s.received[0]).toMatchObject({ level: "warning", data: { message: "loud" } });
    expect(stderr).toHaveBeenCalledWith("quiet");
    expect(stderr).toHaveBeenCalledWith("loud");
  });

  it("writes the same one-line text to stderr when no server is attached", () => {
    log.info("notion-mcp-server v0 running on stdio");
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith("notion-mcp-server v0 running on stdio");
  });

  it("does not throw before connect or after close", async () => {
    const unconnected = createServer();
    setProcessLogServer(unconnected);
    expect(() => log.info("before connect")).not.toThrow();
    expect(() => log.debug("before connect", {}, { server: unconnected })).not.toThrow();

    const s = await connect();
    setProcessLogServer(s.server);
    await s.client.close();
    expect(s.server.isConnected()).toBe(false);

    expect(() => log.error("after close")).not.toThrow();
    expect(() => log.debug("after close", {}, { server: s.server })).not.toThrow();
    expect(stderr).toHaveBeenCalledWith("after close");
    expect(s.received).toHaveLength(0);
  });
});
