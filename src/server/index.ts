import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CONFIG } from "../config/index.js";
import { getClient } from "../services/notion.js";
import { registerAllTools } from "../tools/index.js";
import { accessSummary } from "../operations/access.js";
import { attachLogServer, log, setProcessLogServer } from "../utils/log.js";

/**
 * Build a fresh, fully-registered MCP server instance.
 *
 * A factory (not a module singleton) because the Streamable HTTP transport needs
 * one server per session. `initOperations()` must have run before this is called —
 * it populates the global operation registry that the tools read from; this factory
 * only wires the server's tools/resources/prompts and never re-registers operations.
 */
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
    const server = createServer();
    // stdio runs one server per process, so the process-level lines (banner,
    // access summary, auth probe) belong to this client. The HTTP transport
    // never does this: one server per session, and a process line has no
    // single session to go to.
    setProcessLogServer(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
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
