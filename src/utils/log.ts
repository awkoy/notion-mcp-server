import type {
  LoggingLevel,
  LoggingMessageNotificationParams,
  McpServer,
  ServerContext,
} from "@modelcontextprotocol/server";

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
 *   line belongs to that client. The HTTP transport runs one server per
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
 * The MCP logging capability is deprecated as of protocol 2026-07-28
 * (SEP-2577) in favour of stderr and OpenTelemetry, with at least a
 * twelve-month window in which it keeps working; this server negotiates up to
 * 2025-11-25, where it is fully supported. The stderr line is the one that
 * outlives it.
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
 * Detaches itself when that server's transport closes; pass `undefined` to
 * detach explicitly.
 */
export function setProcessLogServer(server: McpServer | undefined): void {
  processServer = server;
  if (!server) return;
  attachLogServer(server);
  const previous = server.server.onclose;
  server.server.onclose = () => {
    if (processServer === server) processServer = undefined;
    previous?.();
  };
}

/** The level `server`'s client receives at (`info` until it says otherwise). */
export function clientLogLevel(server: McpServer): LoggingLevel {
  return clientLevels.get(server) ?? DEFAULT_LEVEL;
}

function forward(target: LogTarget, params: LoggingMessageNotificationParams): void {
  const { server, ctx } = target;
  if (!server.isConnected()) return;
  if (severity(params.level) < severity(clientLogLevel(server))) return;
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
  const to = target ?? (processServer ? { server: processServer } : undefined);
  if (!to) return;
  forward(to, { level, logger: LOGGER_NAME, data: { message, ...data } });
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
