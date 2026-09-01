import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CONFIG } from "../config/index.js";
import { getClient } from "../services/notion.js";
import { registerAllTools } from "../tools/index.js";
import { accessSummary } from "../operations/access.js";

/**
 * Build a fresh, fully-registered MCP server instance.
 *
 * A factory (not a module singleton) because the Streamable HTTP transport needs
 * one server per session. `initOperations()` must have run before this is called —
 * it populates the global operation registry that the tools read from; this factory
 * only wires the server's tools/resources/prompts and never re-registers operations.
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
      },
      instructions: `
      MCP server for Notion.
      It is used to create, update and delete Notion entities.
    `,
    }
  );

  registerAllTools(server);
  return server;
}

/** Log the operation access summary once at startup (not per session). */
export function logAccessSummary(): void {
  const s = accessSummary();
  console.error(
    `Operation access: ${s.enabled}/${s.total} enabled (allow=${s.allow}; block=${s.block}${s.readOnly ? "; read-only" : ""})`
  );
}

/** Fire-and-forget Notion auth probe; logs who we connected as, never throws. */
export function verifyNotionAuth(): void {
  getClient()
    .then((c) => c.users.me({}))
    .then((me) => {
      const who = "name" in me && me.name ? me.name : me.id;
      console.error(`Notion auth OK — connected as ${who} (NOTION_TOKEN)`);
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Notion auth check failed (server still running): ${msg}`);
    });
}

export async function startStdio(): Promise<void> {
  try {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      `${CONFIG.serverName} v${CONFIG.serverVersion} running on stdio`
    );
    logAccessSummary();
    verifyNotionAuth();
  } catch (error) {
    console.error(
      "Server initialization error:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}
