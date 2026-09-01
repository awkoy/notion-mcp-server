import http from "node:http";
import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { isInitializeRequest } from "@modelcontextprotocol/server";
import type { HttpConfig } from "../config/http.js";
import { CONFIG } from "../config/index.js";
import { createServer, logAccessSummary, verifyNotionAuth } from "./index.js";
import { checkAuth } from "./auth.js";
import { log } from "../utils/log.js";

export type HttpHandle = {
  /** Actually-bound port (resolves PORT=0 to the OS-assigned port). */
  port: number;
  close: () => Promise<void>;
};

const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB

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

export async function startHttp(config: HttpConfig): Promise<HttpHandle> {
  // One transport per session; the connected server instance lives behind it.
  const transports: Record<string, NodeStreamableHTTPServerTransport> = {};

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
      await sendJsonRpcError(req, res, auth.status, auth.status === 401 ? -32001 : -32002, auth.message);
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
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const transport = sessionId ? transports[sessionId] : undefined;
      if (!transport) {
        await sendJsonRpcError(req, res, 400, -32000, "Bad Request: invalid or missing session ID");
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    await sendJsonRpcError(req, res, 405, -32601, "Method not allowed");
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

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      for (const id of Object.keys(transports)) {
        try {
          transports[id].close();
        } catch {
          // best-effort
        }
      }
      httpServer.closeAllConnections?.();
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });

  return { port, close };
}
