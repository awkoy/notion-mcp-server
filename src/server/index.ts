import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CONFIG } from "../config/index.js";
import { getClient } from "../services/notion.js";
import { LIST_CACHE, registerAllTools } from "../tools/index.js";
import { accessSummary } from "../operations/access.js";
import { attachLogServer, log, setProcessLogServer } from "../utils/log.js";
import { CONFIRM_TTL_SECONDS, requestStateCodec } from "./request-state.js";

/**
 * Shown to the model by every client at connect time. Claude Code and Cursor
 * load only the tool names plus this text until a tool is actually needed,
 * and Claude Code truncates it at 2 KB, so this is the one place to teach the
 * workflow. tests/manifests.test.ts keeps it under that limit.
 */
export function buildInstructions(): string {
  const { enabled, total, readOnly, confirmDestructive } = accessSummary();
  const scope =
    enabled < total
      ? `\n\nOnly ${enabled} of ${total} operations are enabled here${readOnly ? " (read-only mode)" : ""}; the tool enums and the notion://operations resource list what works.`
      : "";
  const confirm = confirmDestructive
    ? `\n\nDestructive operations ask the user to confirm before running; a confirmation_declined error means the user said no, so do not retry the call — ask what they want instead.`
    : "";
  return `Notion MCP server. notion_read(operation, payload) runs one read operation and notion_write(operation, payload) one write operation; each tool's operation enum is its complete menu. notion_describe(operation) returns an operation's JSON Schema and a working example; the notion://operations resource lists every operation with a one-line summary.

How to work:
- Find things with search_pages (title search across pages and databases) or query_database. Results are slimmed to id, title, url and a few fields. Every id field also accepts a Notion URL, so paste links as-is.
- Read a page with get_page_markdown for prose, or get_page with include_properties:true for a database row's fields.
- Write prose as markdown: create_page and append_blocks take a \`markdown\` field (GFM: headings, lists, checkboxes, tables, code). Use raw \`children\` blocks only for what markdown cannot express.
- A database has one or more data sources. query_database resolves single-source databases itself and filters with where { Status: "Done" }; to create a row use parent { type: "data_source_id", data_source_id } from search results or list_data_sources. Row properties take plain values: { Status: "Done", Due: "2026-01-01", Tags: ["a"] }.
- Batchable operations take payload { items: [...], atomic?, concurrency?, idempotency_key? } and run in one call with per-item results.
- Errors carry code, message and fix plus the slice of the schema you got wrong: correct and retry. A result's warnings list fields that were ignored. Call notion_describe only for complex shapes (property definitions, block trees).
- Archive and delete operations cannot be undone through the API; confirm with the user before running them.` + scope + confirm;
}

/**
 * Build a fresh, fully-registered MCP server instance.
 *
 * A factory (not a module singleton): the legacy Streamable HTTP wiring needs one
 * server per session, and the 2026-07-28 serving path one per request — the SDK
 * pins a protocol era to an instance, so reusing one across requests is unsafe.
 * `initOperations()` must have run before this is called — it populates the
 * global operation registry that the tools read from; this factory only wires
 * the server's tools/resources/prompts and never re-registers operations.
 *
 * Usable directly as the factory `createMcpHandler` / `serveStdio` take: the
 * server is built the same way for both eras, so the request context they
 * pass is not needed here.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: CONFIG.serverName,
      title: CONFIG.serverTitle,
      version: CONFIG.serverVersion,
      websiteUrl: CONFIG.serverUrl,
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
        // Log lines reach the client as notifications/message; utils/log.ts says
        // what goes where and how logging/setLevel is honoured.
        logging: {},
      },
      instructions: buildInstructions(),
      // SEP-2549 cache hints, mandatory on every list/discover result from
      // protocol 2026-07-28 (Claude Code drops a server's tools when they are
      // missing); tools/index.ts says why five minutes and why private.
      cacheHints: {
        "server/discover": LIST_CACHE,
        "tools/list": LIST_CACHE,
        "prompts/list": LIST_CACHE,
        "resources/list": LIST_CACHE,
        "resources/templates/list": LIST_CACHE,
      },
      // Destructive-operation confirmation (tools/confirm.ts) is written as a
      // 2026-07-28 multi-round-trip handler; the SDK's legacy shim turns its
      // input_required return into a real elicitation for 2025-era clients.
      // The round timeout is how long a person gets to answer that dialog.
      inputRequired: { roundTimeoutMs: CONFIRM_TTL_SECONDS * 1000 },
      // The echoed requestState is verified (HMAC, TTL, method binding) before
      // the handler runs; a bad one is answered "Invalid or expired requestState".
      requestState: { verify: requestStateCodec.verify },
    }
  );

  // Own logging/setLevel for this server so a per-request line is filtered by
  // the level *this* client set (one server per HTTP session).
  attachLogServer(server);
  registerAllTools(server);
  return server;
}

/** Log the operation access summary once at startup (not per session). */
export function logAccessSummary(): void {
  const s = accessSummary();
  log.info(
    `Operation access: ${s.enabled}/${s.total} enabled (allow=${s.allow}; block=${s.block}${s.readOnly ? "; read-only" : ""}${s.confirmDestructive ? "; confirm-destructive" : ""})`
  );
}

/** Fire-and-forget Notion auth probe; logs who we connected as, never throws. */
export function verifyNotionAuth(): void {
  getClient()
    .then((c) => c.users.me({}))
    .then((me) => {
      const who = "name" in me && me.name ? me.name : me.id;
      log.info(`Notion auth OK — connected as ${who} (NOTION_TOKEN)`);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Notion auth check failed (server still running): ${msg}`);
    });
}

export async function startStdio(): Promise<void> {
  try {
    // One server per connection in both eras: a 2025-era client pins the
    // instance with its `initialize`, a 2026-07-28 one (Claude Code with
    // MCP_PROTOCOL_NEGOTIATION=auto) with its first request. The factory also
    // runs for a discarded `server/discover` probe, so the process log server
    // is only registered for the instance a legacy `initialize` pins: stdio
    // runs one client per process, so the process-level lines (banner, access
    // summary, auth probe) belong to that client — on a 2025-era connection,
    // where the logging channel still exists. The HTTP transport never does
    // this: a process line has no single session.
    serveStdio(
      (ctx) => {
        try {
          const server = createServer();
          if (ctx.era === "legacy") setProcessLogServer(server);
          return server;
        } catch (error) {
          // serveStdio only reports a failed factory through `onerror`, after
          // which the process would sit on stdin serving nothing. Fail loudly.
          log.error(
            `Failed to start stdio server: ${error instanceof Error ? error.message : String(error)}`
          );
          process.exit(1);
        }
      },
      {
        legacy: "serve",
        onerror: (error) => log.error(`stdio transport error: ${error.message}`),
      }
    );
    log.info(`${CONFIG.serverName} v${CONFIG.serverVersion} running on stdio`);
    logAccessSummary();
    verifyNotionAuth();
  } catch (error) {
    log.error(
      `Server initialization error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}
