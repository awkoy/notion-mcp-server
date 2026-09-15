import {
  LOG_LEVEL_META_KEY,
  type LoggingLevel,
  type LoggingMessageNotificationParams,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { isModernRequest } from "./mcp-era.js";

/**
 * Server-side logger. Every line goes to stderr exactly as it always has, and
 * is also forwarded to the MCP client as a `notifications/message` when a
 * connected server is available, so it shows up in the client's own log view
 * (VS Code's output channel, MCP Inspector, Claude Desktop's log files) where
 * stderr is usually hidden.
 *
 * Which server a line is forwarded to — the session-scoping rule:
 *
 * - Process-level lines (the startup banner, the operation-access summary, the
 *   Notion auth probe, unhandled errors) have no request behind them. They go
 *   to the one server registered with `setProcessLogServer()`. Only the stdio
 *   transport registers one: it runs exactly one server per process, so the
 *   line belongs to that client. That server is created lazily, when the
 *   client's first message arrives, so lines written before then (the
 *   startup ones) are held — a few dozen at most — and replayed once the
 *   client has finished `initialize`. The HTTP transport runs one server per
 *   session, sessions come and go, and a process line has no single session
 *   to belong to — so it registers none and those lines stay on stderr. A
 *   session therefore never sees another session's traffic.
 * - Request-level lines name their target: `log.debug(msg, data, { server, ctx })`
 *   from inside a tool callback reaches that session's client and no other.
 *   With `ctx` the notification travels with the request (`ctx.mcpReq.notify`),
 *   which on Streamable HTTP means the POST's own response stream rather than
 *   the optional standalone GET stream a client may never open.
 *
 * Level filtering is done here, not by the SDK. `McpServer.sendLoggingMessage`
 * forwards everything, `debug` included, until the client calls
 * `logging/setLevel`, and then keys the level it stores by transport session
 * id, which `sendLoggingMessage` is never given. So `attachLogServer()` takes
 * over the `logging/setLevel` handler, remembers the level per server, and
 * defaults to `info`: a client that never asks for `debug` never gets the
 * per-call lines. Forwarding is fire-and-forget and never throws into the
 * caller — a log call before `connect()` or after the transport closed just
 * writes stderr.
 *
 * Protocol 2026-07-28 has no `logging/setLevel` (SEP-2575): a client that
 * wants log notifications says so per request with the
 * `io.modelcontextprotocol/logLevel` envelope key, and one that says nothing
 * gets nothing. The SDK lifts that envelope into `ctx.mcpReq.envelope`, so a
 * request-level line on a 2026-07-28 request is gated by the request's own
 * level, and process-level lines never apply (there is no connection to send
 * them on). The capability itself is deprecated in that revision (SEP-2577)
 * in favour of stderr and OpenTelemetry, with at least a twelve-month window
 * in which it keeps working. The stderr line is the one that outlives it.
 */

const LOGGER_NAME = "notion-mcp-server";
const DEFAULT_LEVEL: LoggingLevel = "info";

/** Spec order, least to most severe (RFC 5424). */
const LEVELS: readonly LoggingLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];
const severity = (level: LoggingLevel): number => LEVELS.indexOf(level);

export type LogData = Record<string, unknown>;

/**
 * Where a request-level line goes: the server handling the request and, when
 * the caller has one, the request context so the notification rides with the
 * request.
 */
export type LogTarget = { server: McpServer; ctx?: ServerContext };

const attached = new WeakSet<McpServer>();
/** Level the client picked via `logging/setLevel`; absent means DEFAULT_LEVEL. */
const clientLevels = new WeakMap<McpServer, LoggingLevel>();
let processServer: McpServer | undefined;
/** Process-level lines written before a process server existed, oldest first. */
const pending: LoggingMessageNotificationParams[] = [];
const PENDING_LIMIT = 32;

/**
 * Make `server` a log target: own its `logging/setLevel` so the level its client
 * picks is known here. Call once per server (every server the process creates),
 * before it connects. Idempotent.
 */
export function attachLogServer(server: McpServer): void {
  if (attached.has(server)) return;
  attached.add(server);
  // Replaces the SDK's built-in handler (registered because the `logging`
  // capability is declared) so this is the only level store the logger reads.
  server.server.setRequestHandler("logging/setLevel", async ({ params }) => {
    clientLevels.set(server, params.level);
    return {};
  });
}

/**
 * Register the server that process-level lines (no request context) are
 * forwarded to — stdio only, where there is exactly one server per process.
 * Lines held from before the registration are replayed once its client has
 * initialized (right away if it already has). Detaches itself when that
 * server's transport closes, dropping anything still held; pass `undefined`
 * to detach explicitly.
 */
export function setProcessLogServer(server: McpServer | undefined): void {
  processServer = server;
  if (!server) {
    pending.length = 0;
    return;
  }
  attachLogServer(server);
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    if (processServer === server) {
      processServer = undefined;
      pending.length = 0;
    }
    previousClose?.();
  };
  const replay = (): void => {
    for (const params of pending.splice(0)) forward({ server }, params);
  };
  // `initialize` has been answered once the client's identity is known; the
  // `notifications/initialized` hook covers a server registered before that.
  if (server.server.getClientVersion()) {
    replay();
    return;
  }
  const previousInit = server.server.oninitialized;
  server.server.oninitialized = () => {
    previousInit?.();
    if (processServer === server) replay();
  };
}

/** The level `server`'s client receives at (`info` until it says otherwise). */
export function clientLogLevel(server: McpServer): LoggingLevel {
  return clientLevels.get(server) ?? DEFAULT_LEVEL;
}

/**
 * The level a request-level line has to reach to be forwarded: the request's
 * own envelope level on 2026-07-28 (none means the client did not ask for
 * logs; the SDK has already validated the value), the `logging/setLevel`
 * store otherwise.
 */
function thresholdFor(server: McpServer, ctx: ServerContext | undefined): LoggingLevel | undefined {
  if (!isModernRequest(ctx)) return clientLogLevel(server);
  const envelope = ctx?.mcpReq.envelope as Record<string, unknown> | undefined;
  return envelope?.[LOG_LEVEL_META_KEY] as LoggingLevel | undefined;
}

function forward(target: LogTarget, params: LoggingMessageNotificationParams): void {
  const { server, ctx } = target;
  if (!server.isConnected()) return;
  const threshold = thresholdFor(server, ctx);
  if (threshold === undefined || severity(params.level) < severity(threshold)) return;
  try {
    const sent = ctx
      ? ctx.mcpReq.notify({ method: "notifications/message", params })
      : server.sendLoggingMessage(params);
    // The transport can close between the check and the send; a lost log line
    // is never the caller's problem.
    void sent.catch(() => {});
  } catch {
    // Same for a synchronous throw from a transport that just closed.
  }
}

function emit(level: LoggingLevel, message: string, data?: LogData, target?: LogTarget): void {
  console.error(message);
  const params = { level, logger: LOGGER_NAME, data: { message, ...data } };
  const to = target ?? (processServer ? { server: processServer } : undefined);
  if (to) {
    forward(to, params);
    return;
  }
  // No process server yet (stdio creates it on the client's first message):
  // hold the line for it. The cap keeps a process that never gets a client —
  // or the HTTP transport, which never registers one — from growing this.
  if (pending.length < PENDING_LIMIT) pending.push(params);
}

/**
 * `log.<level>(message, data?, target?)`: `message` is the stderr line, `data`
 * a few extra fields for the MCP notification (`data: { message, ...data }`),
 * `target` the server (and request context) a request-level line belongs to.
 * Without a target the line goes to the process server, if any.
 */
export const log = {
  debug: (message: string, data?: LogData, target?: LogTarget): void =>
    emit("debug", message, data, target),
  info: (message: string, data?: LogData, target?: LogTarget): void =>
    emit("info", message, data, target),
  warning: (message: string, data?: LogData, target?: LogTarget): void =>
    emit("warning", message, data, target),
  error: (message: string, data?: LogData, target?: LogTarget): void =>
    emit("error", message, data, target),
};
