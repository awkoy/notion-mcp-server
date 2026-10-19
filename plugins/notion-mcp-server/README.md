# Notion MCP Server (community plugin)

This plugin connects Claude to your Notion workspace with a Notion token. Claude can search pages and databases, read pages as markdown, query databases with typed filters, create and edit pages and rows, comment, and upload files. It is the Claude Code plugin for the open-source [notion-mcp-server](https://github.com/awkoy/notion-mcp-server). Notion did not make it and does not endorse it.

The plugin contains two things:

- **An MCP server.** It runs `npx -y notion-mcp-server@3.2.1`, the published npm package pinned to this plugin version, on your own computer. It exposes three tools, `notion_read`, `notion_write` and `notion_describe`, in place of one tool per endpoint, which keeps the tool schemas small in Claude's context.
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

## Install in Codex

The same folder is also a Codex plugin with the same server and skill. Codex has no form for plugin options, so the server reads the token from the environment Codex starts in. Export it in your shell profile (`~/.zshrc` on macOS), then add the marketplace and the plugin:

```bash
export NOTION_TOKEN=ntn_your_token
```

```bash
codex plugin marketplace add awkoy/notion-mcp-server
```

```bash
codex plugin add notion-mcp-server@awkoy
```

The token sits in plain text in that profile file. `NOTION_PAGE_ID` and `NOTION_READ_ONLY=true` work the same way and are optional. The Codex desktop app reads your shell profile when it starts, so restart it after you add the export.

## Install in Cursor

The folder is also a Cursor plugin. Until it is listed in the Cursor Marketplace, install it as a local plugin by copying the folder from a clone of the repo (Cursor does not follow a symlink here), then restart Cursor:

```bash
git clone https://github.com/awkoy/notion-mcp-server.git
```

```bash
mkdir -p ~/.cursor/plugins/local && cp -R notion-mcp-server/plugins/notion-mcp-server ~/.cursor/plugins/local/
```

To update, pull the clone and copy the folder again. The plugin declares one variable, `NOTION_TOKEN`. Set it where Cursor offers plugin settings, or export `NOTION_TOKEN` in your shell profile and restart Cursor, which then reads it from its environment. If neither is set, the server gets the literal text `${NOTION_TOKEN}` and reports an invalid token. Optional `NOTION_PAGE_ID` and `NOTION_READ_ONLY=true` are read from the same environment.

## If the server fails to start after an update

npm can refuse to install versions younger than a set age: the `min-release-age` setting (npm 11.10 and later, in days) or `before` (a date). The plugin runs one exact version, so if your npm config sets either, the server fails to start for the first days after each plugin update, and `/mcp` shows it as failed. Run the plugin's `npx` command in a terminal to see the cause. npm prints `npm error notarget No matching version found for notion-mcp-server@<version> with a date before …`.

The error clears once the release is older than your setting. On npm 12 you can exempt just this package instead, with this line in `~/.npmrc`:

```ini
min-release-age-exclude=notion-mcp-server
```

## Data and privacy

The server runs on your computer and talks only to `api.notion.com` over HTTPS, using your token. There is no telemetry, no analytics, and no other server in the path. Whatever Claude reads from Notion goes into your conversation with Claude, and Anthropic handles it under the terms of your Claude plan. In Codex or Cursor, it goes to that app's model provider under that app's terms. `upload_file` reads a local file or fetches a URL only when you ask it to, and refuses URLs on private or loopback addresses. The full policy is in the [privacy section of the main README](https://github.com/awkoy/notion-mcp-server#privacy).

## Other ways to install

The same server installs in other clients too: Claude Desktop through the `.mcpb` bundle on the [releases page](https://github.com/awkoy/notion-mcp-server/releases/latest), or Cursor (without the plugin), VS Code and Gemini CLI through the [main README](https://github.com/awkoy/notion-mcp-server#quick-start). Report problems in [GitHub Issues](https://github.com/awkoy/notion-mcp-server/issues).

## License

MIT. See [LICENSE](./LICENSE).
