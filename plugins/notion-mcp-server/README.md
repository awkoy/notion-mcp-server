# Notion MCP Server (community plugin)

This plugin connects Claude to your Notion workspace with a Notion token. Claude can search pages and databases, read pages as markdown, query databases with typed filters, create and edit pages and rows, comment, and upload files. It is the Claude Code plugin for the open-source [notion-mcp-server](https://github.com/awkoy/notion-mcp-server). Notion did not make it and does not endorse it.

The plugin contains two things:

- **An MCP server.** It runs `npx -y notion-mcp-server@3.2.0`, the published npm package pinned to this plugin version, on your own computer. It exposes three tools, `notion_read`, `notion_write` and `notion_describe`, in place of one tool per endpoint, which keeps the tool schemas small in Claude's context.
- **The `notion-workflow` skill.** It teaches Claude to find things with `search_pages`, read them with `get_page_markdown`, filter databases with `query_database` and `where`, batch repeated writes into one call, and call `notion_describe` only for complex shapes. It also tells Claude to ask before archiving or deleting anything.

## Requirements

- Node.js 20 or later, so that `npx` can run the server.
- A Notion token. Open [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens), choose **+ New token**, pick your workspace and copy the `ntn_…` value. A Personal Access Token sees everything you can see. An Internal Integration secret also works, but it sees only the pages shared with that integration.

## Install

In Claude Code:

```
/plugin marketplace add awkoy/notion-mcp-server
/plugin install notion-mcp-server@awkoy
```

Claude Code asks for the options below when you install the plugin. If it doesn't ask, or you want to change them later, run `/plugin configure notion-mcp-server@awkoy`.

| Option | What it does |
| --- | --- |
| Notion token | Required. Stored in your system keychain, never in a settings file. |
| Default parent page | Optional. A page URL or ID used when Claude creates a page or database without naming a parent. |
| Read-only mode | Optional. When on, every write operation is disabled. |

Restart Claude Code, or run `/reload-plugins`, then check that `/mcp` lists the server as connected. Try:

> *Find my "Tasks" database in Notion and list everything due this week that isn't done.*

## Data and privacy

The server runs on your computer and talks only to `api.notion.com` over HTTPS, using your token. There is no telemetry, no analytics, and no other server in the path. Whatever Claude reads from Notion goes into your conversation with Claude, and Anthropic handles it under the terms of your Claude plan. `upload_file` reads a local file only when you ask it to. The full policy is in the [privacy section of the main README](https://github.com/awkoy/notion-mcp-server#-privacy).

## Other ways to install

The same server installs in other clients too: Claude Desktop through the `.mcpb` bundle on the [releases page](https://github.com/awkoy/notion-mcp-server/releases/latest), or Cursor, VS Code and Gemini CLI through the [main README](https://github.com/awkoy/notion-mcp-server#quick-start). Report problems in [GitHub Issues](https://github.com/awkoy/notion-mcp-server/issues).

## License

MIT. See [LICENSE](./LICENSE).
