import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG } from "../config/index.js";
import { getClient } from "../services/notion.js";

export const server = new McpServer(
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
    },
    instructions: `
      MCP server for Notion.
      It is used to create, update and delete Notion entities.
    `,
  }
);

export async function startServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      `${CONFIG.serverName} v${CONFIG.serverVersion} running on stdio`
    );

    getClient()
      .then((c) => c.users.me({}))
      .then((me) => {
        const who = "name" in me && me.name ? me.name : me.id;
        console.error(
          `Notion auth OK — connected as ${who} (NOTION_TOKEN)`
        );
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `Notion auth check failed (server still running): ${msg}`
        );
      });
  } catch (error) {
    console.error(
      "Server initialization error:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
}
