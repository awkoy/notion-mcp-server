import http from "node:http";
import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport, toNodeHandler } from "@modelcontextprotocol/node";
import {
  classifyInboundRequest,
  createMcpHandler,
  isInitializeRequest,
  PROTOCOL_VERSION_META_KEY,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";
import type { HttpConfig } from "../config/http.js";
import { CONFIG } from "../config/index.js";
import { createServer, logAccessSummary, verifyNotionAuth } from "./index.js";
import { checkAuth } from "./auth.js";
import { log } from "../utils/log.js";

// Streamable HTTP on `node:http`, serving two protocol eras side by side:
//
// - 2024-11-05 … 2025-11-25 ("legacy"): the sessionful stack this server has
//   always run. An initialize POST creates a `NodeStreamableHTTPServerTransport`
//   plus its own `McpServer`, later POST/GET/DELETE requests find it by
//   `Mcp-Session-Id`. Kept verbatim so those clients see no change; the whole
//   `transports` map can go once the 2026-07-28 deprecation window closes
//   (twelve months after the revision shipped, so no earlier than 2027-07-28).
// - 2026-07-28 ("modern"): stateless. Every POST carries its own envelope in
//   `params._meta`, `createMcpHandler` builds a fresh `McpServer` per request
//   and answers on that request's response. No sessions, no standalone GET
//   stream, so GET/DELETE without a session id have nothing to reach.
//
// `isLegacyPost` decides per POST with the SDK's own classifier: only a
// request that makes no envelope claim at all (a 2025-era initialize, a
// batch, an empty body) is legacy; one that claims any protocol version in
// its `_meta` or `MCP-Protocol-Version` header — modern, legacy-but-in-an-
// envelope, or nonsense — goes to the modern handler, which is where the
// spec'd -32020 mismatch answers come from.

export type HttpHandle = {
  /** Actually-bound port (resolves PORT=0 to the OS-assigned port). */
  port: number;
  close: () => Promise<void>;
};

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** The 2025-era revisions the legacy stack negotiates. */
const LEGACY_PROTOCOL_VERSIONS: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;

class BodyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BodyError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Discard any remaining request body and resolve once it's fully consumed. */
function drain(req: http.IncomingMessage): Promise<void> {
  if (req.readableEnded || req.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    req.on("end", resolve);
    req.on("close", resolve);
    req.on("error", () => resolve());
    req.resume();
  });
}

async function sendJsonRpcError(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string
): Promise<void> {
  // Fully drain the request body before responding. Ending the response while the
  // client is still streaming the body resets the socket (ECONNRESET) and the client
  // never sees our status — so we wait for the upload to finish first.
  await drain(req);
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  // Connection: close — we rejected this request without reusing the socket; some
  // keep-alive clients (Node's undici fetch) otherwise RST when they get an early
  // response while still uploading the body. Explicit length avoids chunked framing.
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    connection: "close",
  });
  res.end(payload);
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]"
  );
}

/** Localhost Host-header allowlist for DNS-rebinding protection, using the
 *  actually-bound port (handles PORT=0). Used when MCP_ALLOWED_HOSTS is unset. */
function defaultAllowedHosts(host: string, port: number): string[] {
  const names = new Set<string>(["127.0.0.1", "localhost", "[::1]", host]);
  const out: string[] = [];
  for (const n of names) out.push(n, `${n}:${port}`);
  return out;
}

function defaultAllowedOrigins(port: number): string[] {
  return ["127.0.0.1", "localhost", "[::1]"].map((h) => `http://${h}:${port}`);
}

/**
 * DNS-rebinding guard for the modern leg, the same exact-match rule the legacy
 * transport applies from `enableDnsRebindingProtection`: the Host header must
 * be listed, and an Origin header, when the client sends one, must be too.
 * Deliberately not the SDK's `hostHeaderValidation` / `originValidation`
 * guards, which compare hostnames only and would let any port through; the
 * lists here are `host:port`, as the legacy transport reads them.
 * Returns the reason to refuse, or undefined to let the request through.
 */
function hostOriginRejection(
  req: http.IncomingMessage,
  allowedHosts: readonly string[],
  allowedOrigins: readonly string[]
): string | undefined {
  const host = req.headers.host;
  if (!host || !allowedHosts.includes(host)) {
    return `Invalid Host header: ${host ?? "(none)"}`;
  }
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    return `Invalid Origin header: ${origin}`;
  }
  return undefined;
}

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Does this POST belong to the 2025-era sessionful stack? The SDK's inbound
 * classifier answers from the headers and the parsed body, the way
 * `isLegacyRequest` does — except that it rejects a bodiless POST outright,
 * whereas the legacy transport is what has always answered those.
 */
function isLegacyPost(req: http.IncomingMessage, body: unknown): boolean {
  if (body === undefined) return true;
  const classification = classifyInboundRequest({
    httpMethod: "POST",
    protocolVersionHeader: firstHeader(req.headers["mcp-protocol-version"]),
    mcpMethodHeader: firstHeader(req.headers["mcp-method"]),
    mcpNameHeader: firstHeader(req.headers["mcp-name"]),
    body,
  });
  return classification.kind === "legacy";
}

/** The protocol revision the body's `params._meta` envelope claims, if any. */
function envelopeProtocolVersion(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const version = (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY];
  return typeof version === "string" ? version : undefined;
}

/**
 * Interop shim for anthropics/claude-code#93290: Claude Desktop and some
 * Claude Code builds send a 2026-07-28 body (envelope in `params._meta`)
 * under a 2025-era `MCP-Protocol-Version` header. The SDK answers that
 * mismatch with -32020 before any handler runs, which would lock out the
 * largest client base. When — and only when — the header names a legacy
 * revision while the body claims the modern one, the header is realigned to
 * the body before the request reaches the SDK. Every other mismatch (an
 * unknown value, a modern header on a legacy body, a missing header on a
 * modern body when the SDK requires one) still gets the spec'd rejection.
 * Remove once the client-side fix has shipped widely.
 */
function realignProtocolVersionHeader(req: http.IncomingMessage, body: unknown): void {
  const header = req.headers["mcp-protocol-version"];
  if (typeof header !== "string" || !LEGACY_PROTOCOL_VERSIONS.includes(header)) return;
  if (envelopeProtocolVersion(body) !== MODERN_PROTOCOL_VERSION) return;
  req.headers["mcp-protocol-version"] = MODERN_PROTOCOL_VERSION;
}

export async function startHttp(config: HttpConfig): Promise<HttpHandle> {
  // Legacy leg: one transport per session; the connected server lives behind it.
  const transports: Record<string, NodeStreamableHTTPServerTransport> = {};

  // Modern leg: one server per request, no session state at all. `legacy:
  // "reject"` because everything legacy-shaped has already been routed to the
  // sessionful stack above; anything that still lands here without an
  // envelope is malformed and gets the SDK's answer.
  // Both hooks also fire for every request the SDK's own ladder refuses (a
  // 400 mismatch, a 405, an unsupported media type), which is client input,
  // not a server fault: a warning line, no stack trace.
  const modern = createMcpHandler(createServer, {
    legacy: "reject",
    onerror: (error) => log.warning(`MCP handler: ${error.message}`),
  });
  const serveModern = toNodeHandler(modern, {
    onerror: (error) => log.warning(`MCP adapter: ${error.message}`),
  });

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch(async (err) => {
      log.error(
        `HTTP handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
      );
      await sendJsonRpcError(req, res, 500, -32603, "Internal server error");
    });
  });

  // Bind first so we know the real port (PORT=0 -> OS-assigned) before building
  // the DNS-rebinding allowlist. Reject (don't hang) on a bind failure like EADDRINUSE.
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : config.port;

  const allowedHosts =
    config.allowedHosts.length > 0
      ? config.allowedHosts
      : defaultAllowedHosts(config.host, port);
  const allowedOrigins =
    config.allowedOrigins.length > 0
      ? config.allowedOrigins
      : defaultAllowedOrigins(port);

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    // Liveness probe — no auth, no session.
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", transport: "http", port }));
      return;
    }

    if (pathname !== "/mcp") {
      await sendJsonRpcError(req, res, 404, -32601, "Not found");
      return;
    }

    const auth = checkAuth(req.headers, config.authToken);
    if (!auth.ok) {
      // 2026-07-28 frozen codes: -32001 unauthorized, -32003 forbidden.
      await sendJsonRpcError(req, res, auth.status, auth.status === 401 ? -32001 : -32003, auth.message);
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        const status = e instanceof BodyError ? e.status : 400;
        await sendJsonRpcError(req, res, status, -32700, e instanceof Error ? e.message : "Parse error");
        return;
      }

      if (isLegacyPost(req, body)) {
        await handleLegacyPost(req, res, body, sessionId);
        return;
      }
      await handleModern(req, res, body);
      return;
    }

    // A session id names a legacy session: the standalone stream to open, or
    // the session to end. Everything else — GET/DELETE without one, any other
    // verb — is the modern leg's to answer (405 with the SDK's error body),
    // since the 2026-07-28 era has no standalone stream and no session.
    if (sessionId && (req.method === "GET" || req.method === "DELETE")) {
      const transport = transports[sessionId];
      if (!transport) {
        await sendJsonRpcError(req, res, 400, -32000, "Bad Request: invalid or missing session ID");
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    await handleModern(req, res);
  }

  async function handleModern(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body?: unknown
  ): Promise<void> {
    const rejection = hostOriginRejection(req, allowedHosts, allowedOrigins);
    if (rejection) {
      await sendJsonRpcError(req, res, 403, -32000, rejection);
      return;
    }
    if (body !== undefined) realignProtocolVersionHeader(req, body);
    await serveModern(req, res, body);
  }

  async function handleLegacyPost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: unknown,
    sessionId: string | undefined
  ): Promise<void> {
    let transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      if (!sessionId && isInitializeRequest(body)) {
        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport!;
          },
          enableDnsRebindingProtection: true,
          allowedHosts,
          allowedOrigins,
        });
        transport.onclose = () => {
          if (transport!.sessionId) delete transports[transport!.sessionId];
        };
        const server = createServer();
        await server.connect(transport);
      } else {
        await sendJsonRpcError(req, res, 400, -32000, "Bad Request: no valid session ID");
        return;
      }
    }
    await transport.handleRequest(req, res, body);
  }

  log.info(
    `${CONFIG.serverName} v${CONFIG.serverVersion} running on http://${config.host}:${port}/mcp`
  );
  if (!config.authToken && !isLoopbackHost(config.host)) {
    log.warning(
      "WARNING: HTTP endpoint bound to a non-loopback host without MCP_AUTH_TOKEN — anyone who can reach it acts as your NOTION_TOKEN. Set MCP_AUTH_TOKEN."
    );
  }
  logAccessSummary();
  verifyNotionAuth();

  const close = async (): Promise<void> => {
    // Best effort, but waited for: a session whose stream is still flushing
    // would otherwise be cut off by closeAllConnections below.
    await Promise.allSettled(Object.values(transports).map((t) => t.close()));
    await modern.close().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      httpServer.closeAllConnections?.();
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { port, close };
}
