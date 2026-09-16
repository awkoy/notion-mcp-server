import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import http from "node:http";

// Protocol revision 2026-07-28 end to end, next to the 2025-era clients that
// keep using the same endpoint: the stateless HTTP leg on the wire (envelope,
// cache hints, no session, the header shim), the same leg through the SDK
// client, multi-round-trip confirmation with a sealed requestState, and the
// stdio matrix through serveStdio.

const notionStub = {
  databases: { retrieve: vi.fn(), query: vi.fn(), create: vi.fn(), update: vi.fn() },
  dataSources: { query: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
  pages: {
    retrieve: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
    retrieveMarkdown: vi.fn(),
    updateMarkdown: vi.fn(),
  },
  comments: { retrieve: vi.fn(), update: vi.fn(), delete: vi.fn() },
  blocks: { retrieve: vi.fn(), delete: vi.fn(), children: { append: vi.fn() } },
  views: { delete: vi.fn() },
  users: { me: vi.fn(async () => ({ id: "bot", name: "Test Bot" })) },
};
vi.mock("../src/services/notion.js", () => ({ getClient: async () => notionStub }));

import { initOperations } from "../src/operations/index.js";
import { startHttp, type HttpHandle } from "../src/server/http.js";
import { parseHttpConfig } from "../src/config/http.js";
import { createServer } from "../src/server/index.js";
import { LIST_CACHE } from "../src/tools/index.js";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const MODERN = "2026-07-28";
const FLAG = "NOTION_CONFIRM_DESTRUCTIVE";

const PAGE = {
  object: "page",
  id: "p-1",
  created_time: "2026-01-01T00:00:00.000Z",
  last_edited_time: "2026-01-01T00:00:00.000Z",
  created_by: { object: "user", id: "u-1" },
  last_edited_by: { object: "user", id: "u-1" },
  archived: false,
  in_trash: false,
  parent: { type: "workspace", workspace: true },
  icon: null,
  cover: null,
  public_url: null,
  url: "https://www.notion.so/p-1",
  properties: {
    title: {
      id: "title",
      type: "title",
      title: [
        {
          type: "text",
          text: { content: "Roadmap", link: null },
          plain_text: "Roadmap",
          href: null,
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: "default",
          },
        },
      ],
    },
  },
};
const ACCEPT = { action: "accept" };
const ARCHIVE = { operation: "archive_page", payload: { page_id: "p-1" } };

let server: HttpHandle;
let port: number;

beforeAll(async () => {
  await initOperations();
  server = await startHttp(
    parseHttpConfig({ MCP_TRANSPORT: "http", PORT: "0", HOST: "127.0.0.1" })
  );
  port = server.port;
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  notionStub.pages.retrieve.mockReset().mockResolvedValue(PAGE);
  notionStub.pages.update.mockReset().mockResolvedValue({ ...PAGE, in_trash: true });
});

// ── helpers ────────────────────────────────────────────────────────────────

type Rpc = {
  jsonrpc: "2.0";
  id?: unknown;
  method?: string;
  params?: unknown;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: Record<string, any> };
};
type Raw = { status: number; headers: http.IncomingHttpHeaders; messages: Rpc[] };

/** One request over node:http, with full control of the headers (Host included). */
function rawRequest(opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: opts.method ?? "POST",
        headers: {
          accept: "application/json, text/event-stream",
          ...(payload !== undefined
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
            : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            messages: parseMessages(res.headers["content-type"], Buffer.concat(chunks).toString("utf8")),
          })
        );
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function parseMessages(contentType: string | undefined, text: string): Rpc[] {
  if (text.trim() === "") return [];
  if (contentType?.includes("text/event-stream")) {
    return text.split(/\n\n+/).flatMap((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      return data ? [JSON.parse(data) as Rpc] : [];
    });
  }
  const parsed = JSON.parse(text) as Rpc | Rpc[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "raw-2026", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
};

/** A 2026-07-28 POST as a spec-following client sends it: envelope in `_meta`, SEP-2243 headers. */
function modernPost(
  method: string,
  params: Record<string, unknown> = {},
  extra: { headers?: Record<string, string>; meta?: Record<string, unknown> } = {}
): Promise<Raw> {
  // SEP-2243: Mcp-Name carries the tool/prompt name or the resource uri.
  const named = params.name ?? params.uri;
  const name = typeof named === "string" ? { "mcp-name": named } : {};
  return rawRequest({
    body: { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { ...ENVELOPE, ...extra.meta } } },
    headers: { "mcp-protocol-version": MODERN, "mcp-method": method, ...name, ...extra.headers },
  });
}

/** The response message (result or error) in a raw exchange. */
function reply(raw: Raw): Rpc {
  const found = raw.messages.find((m) => "result" in m || "error" in m);
  if (!found) throw new Error(`No response in ${JSON.stringify(raw)}`);
  return found;
}

function readJson(result: { content: Array<{ type: string; text?: string }> }): any {
  const block = result.content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error(`Expected text content, got: ${JSON.stringify(result)}`);
  }
  return JSON.parse(block.text);
}

async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

type Answer = { action: "accept"; content: Record<string, unknown> } | { action: "decline" | "cancel" };

/** A client that answers every elicitation with `answer` and records the prompts. */
function askingClient(options: ConstructorParameters<typeof Client>[1]) {
  const prompts: string[] = [];
  const state: { answer: Answer } = { answer: ACCEPT };
  const client = new Client(
    { name: "confirm-2026", version: "0.0.0" },
    { ...options, capabilities: { elicitation: { form: {} } } }
  );
  client.setRequestHandler("elicitation/create", async (req) => {
    prompts.push((req.params as { message: string }).message);
    return state.answer;
  });
  return { client, prompts, state };
}

async function callWrite(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: "notion_write", arguments: args });
  return readJson(result as Parameters<typeof readJson>[0]);
}

// ── HTTP, on the wire ──────────────────────────────────────────────────────

describe("2026-07-28 over HTTP: the wire", () => {
  it("answers server/discover statelessly", async () => {
    const raw = await modernPost("server/discover");
    expect(raw.status).toBe(200);
    expect(raw.headers["mcp-session-id"]).toBeUndefined();
    const result = reply(raw).result!;
    expect(JSON.stringify(result)).toContain(MODERN);
    expect(result.resultType).toBe("complete");
  });

  it("stamps cache hints on every cacheable method", async () => {
    const lists = [
      "server/discover",
      "tools/list",
      "prompts/list",
      "resources/list",
      "resources/templates/list",
    ];
    for (const method of lists) {
      const result = reply(await modernPost(method)).result;
      expect(result, method).toBeDefined();
      expect(result!.ttlMs, method).toBe(LIST_CACHE.ttlMs);
      expect(result!.cacheScope, method).toBe("private");
    }
    const index = reply(await modernPost("resources/read", { uri: "notion://operations" })).result!;
    expect(index.ttlMs).toBe(LIST_CACHE.ttlMs);
    expect(index.cacheScope).toBe("private");
  });

  it("lists the tools read → write → describe, without a session", async () => {
    const raw = await modernPost("tools/list");
    expect(raw.headers["mcp-session-id"]).toBeUndefined();
    const names = reply(raw).result!.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["notion_read", "notion_write", "notion_describe"]);
  });

  it("has no standalone stream and no session to end: GET/DELETE are 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      const raw = await rawRequest({ method, headers: { "mcp-protocol-version": MODERN } });
      expect(raw.status, method).toBe(405);
    }
  });

  it("realigns a 2025-era header over a 2026-07-28 body (claude-code#93290)", async () => {
    const raw = await modernPost("tools/list", {}, { headers: { "mcp-protocol-version": "2025-11-25" } });
    expect(raw.status).toBe(200);
    expect(reply(raw).result!.tools.length).toBeGreaterThan(0);
  });

  it("keeps every other header/body mismatch a 400", async () => {
    const unknown = await modernPost("tools/list", {}, { headers: { "mcp-protocol-version": "2099-01-01" } });
    expect(unknown.status).toBe(400);
    expect([-32020, -32022]).toContain(reply(unknown).error?.code);

    const legacyBody = await modernPost("tools/list", {}, {
      meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" },
    });
    expect(legacyBody.status).toBe(400);
    expect([-32020, -32022, -32602]).toContain(reply(legacyBody).error?.code);
  });

  it("guards Host and Origin on the stateless leg", async () => {
    const origin = await modernPost("tools/list", {}, { headers: { origin: "http://evil.example" } });
    expect(origin.status).toBe(403);
    expect(reply(origin).error?.code).toBe(-32000);

    const host = await modernPost("tools/list", {}, { headers: { host: "evil.example" } });
    expect(host.status).toBe(403);
    expect(reply(host).error?.code).toBe(-32000);
  });

  it("forwards log lines only at the level the request asks for", async () => {
    const call = { name: "notion_read", arguments: { operation: "get_page", payload: { page_id: "p-1" } } };
    const quiet = await modernPost("tools/call", call);
    expect(quiet.status).toBe(200);
    expect(readJson(reply(quiet).result as never).ok).toBe(true);
    expect(quiet.messages.some((m) => m.method === "notifications/message")).toBe(false);

    const chatty = await modernPost("tools/call", call, {
      meta: { "io.modelcontextprotocol/logLevel": "debug" },
    });
    expect(chatty.status).toBe(200);
    expect(chatty.messages.some((m) => m.method === "notifications/message")).toBe(true);
  });
});

// ── HTTP, through the SDK client ───────────────────────────────────────────

describe("2026-07-28 over HTTP: SDK client", () => {
  const asking = askingClient({ versionNegotiation: { mode: { pin: MODERN } } });

  beforeAll(async () => {
    await asking.client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    );
  });
  afterAll(async () => {
    await asking.client.close();
  });
  beforeEach(() => {
    asking.prompts.length = 0;
    asking.state.answer = ACCEPT;
  });

  it("negotiates the pinned revision and lists the tools", async () => {
    const { tools } = await asking.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["notion_read", "notion_write", "notion_describe"]);
  });

  it("confirms a destructive call through input_required and the retry", async () => {
    await withFlag("true", async () => {
      const body = await callWrite(asking.client, ARCHIVE);
      expect(asking.prompts).toHaveLength(1);
      expect(asking.prompts[0]).toContain('page "Roadmap" (p-1)');
      expect(body.ok).toBe(true);
      expect(notionStub.pages.update).toHaveBeenCalledWith({ page_id: "p-1", in_trash: true });
    });
  });

  it("runs nothing when the user declines", async () => {
    await withFlag("true", async () => {
      asking.state.answer = { action: "decline" };
      const body = await callWrite(asking.client, ARCHIVE);
      expect(asking.prompts).toHaveLength(1);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("confirmation_declined");
      expect(body.error.message).toContain('page "Roadmap" (p-1)');
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });

  it("does not ask when the flag is off", async () => {
    await withFlag(undefined, async () => {
      const body = await callWrite(asking.client, ARCHIVE);
      expect(asking.prompts).toHaveLength(0);
      expect(body.ok).toBe(true);
    });
  });
});

// ── requestState: what comes back is attacker-controlled ───────────────────

describe("2026-07-28 over HTTP: requestState", () => {
  const archiveCall = (payload: Record<string, unknown>, retry: Record<string, unknown> = {}) =>
    modernPost("tools/call", {
      name: "notion_write",
      arguments: { operation: "archive_page", payload },
      ...retry,
    });

  it("first round: input_required with one elicitation and a sealed state", async () => {
    await withFlag("true", async () => {
      const result = reply(await archiveCall({ page_id: "p-1" })).result!;
      expect(result.resultType).toBe("input_required");
      expect(result.inputRequests.confirm.method).toBe("elicitation/create");
      expect(result.inputRequests.confirm.params.message).toContain('page "Roadmap" (p-1)');
      expect(typeof result.requestState).toBe("string");
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });

  it("second round: the echoed state and an accept run the call", async () => {
    await withFlag("true", async () => {
      const { requestState } = reply(await archiveCall({ page_id: "p-1" })).result!;
      const result = reply(
        await archiveCall({ page_id: "p-1" }, { inputResponses: { confirm: ACCEPT }, requestState })
      ).result!;
      expect(result.resultType).toBe("complete");
      expect(readJson(result as never).ok).toBe(true);
      expect(notionStub.pages.update).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a tampered state before the handler runs", async () => {
    await withFlag("true", async () => {
      const { requestState } = reply(await archiveCall({ page_id: "p-1" })).result!;
      const forged = `${requestState.slice(0, -4)}AAAA`;
      for (const state of ["not-a-state", forged]) {
        const { error } = reply(
          await archiveCall({ page_id: "p-1" }, { inputResponses: { confirm: ACCEPT }, requestState: state })
        );
        expect(error?.code, state).toBe(-32602);
        expect(error?.data?.reason, state).toBe("invalid_request_state");
      }
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });

  it("refuses a confirmation minted for a different call", async () => {
    await withFlag("true", async () => {
      const { requestState } = reply(await archiveCall({ page_id: "p-1" })).result!;
      const result = reply(
        await archiveCall({ page_id: "p-2" }, { inputResponses: { confirm: ACCEPT }, requestState })
      ).result!;
      const body = readJson(result as never);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("confirmation_mismatch");
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });

  it("treats a missing or non-accept answer as declined", async () => {
    await withFlag("true", async () => {
      const { requestState } = reply(await archiveCall({ page_id: "p-1" })).result!;
      const result = reply(
        await archiveCall(
          { page_id: "p-1" },
          { inputResponses: { confirm: { action: "cancel" } }, requestState }
        )
      ).result!;
      expect(readJson(result as never).error.code).toBe("confirmation_declined");
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });
});

// ── 2025-era clients share the endpoint ────────────────────────────────────

describe("2025-era clients on the same endpoint", () => {
  it("still get a session and confirm through elicitation/create", async () => {
    const legacy = askingClient({});
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await legacy.client.connect(transport);
    try {
      expect(transport.sessionId).toBeTruthy();
      const { tools } = await legacy.client.listTools();
      expect(tools).toHaveLength(3);
      await withFlag("true", async () => {
        const body = await callWrite(legacy.client, ARCHIVE);
        expect(legacy.prompts).toHaveLength(1);
        expect(body.ok).toBe(true);
      });
    } finally {
      await legacy.client.close();
    }
  });
});

// ── stdio: serveStdio serves both eras ─────────────────────────────────────

describe("stdio through serveStdio", () => {
  async function connectStdio(options: ConstructorParameters<typeof Client>[1]) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(createServer, {
      transport: serverTransport,
      legacy: "serve",
    });
    const asking = askingClient(options);
    await asking.client.connect(clientTransport);
    return {
      ...asking,
      close: async () => {
        await asking.client.close();
        await handle.close();
      },
    };
  }

  it("serves a 2025-era client", async () => {
    const legacy = await connectStdio({});
    try {
      const { tools } = await legacy.client.listTools();
      expect(tools).toHaveLength(3);
      await withFlag("true", async () => {
        expect((await callWrite(legacy.client, ARCHIVE)).ok).toBe(true);
        expect(legacy.prompts).toHaveLength(1);
      });
    } finally {
      await legacy.close();
    }
  });

  it("serves a client pinned to 2026-07-28", async () => {
    const modern = await connectStdio({ versionNegotiation: { mode: { pin: MODERN } } });
    try {
      const { tools } = await modern.client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["notion_read", "notion_write", "notion_describe"]);
      const read = await modern.client.callTool({
        name: "notion_read",
        arguments: { operation: "get_page", payload: { page_id: "p-1" } },
      });
      expect(readJson(read as never).ok).toBe(true);
      await withFlag("true", async () => {
        expect(await callWrite(modern.client, ARCHIVE)).toMatchObject({ ok: true });
        expect(modern.prompts).toHaveLength(1);
        modern.state.answer = { action: "decline" };
        expect((await callWrite(modern.client, ARCHIVE)).error.code).toBe("confirmation_declined");
      });
    } finally {
      await modern.close();
    }
  });
});
