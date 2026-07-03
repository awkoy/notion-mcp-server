# Installation guide for AI agents (Cline, etc.)

This file tells an agent exactly how to install and configure `notion-mcp-server`. If you are Cline (or another MCP-capable agent) setting this up, follow these steps.

## What you need from the user

One value: a **Notion token**. Ask the user to get it at **https://app.notion.com/developers/tokens** → **+ New token** → name it, pick a workspace → **Create token** → copy the `ntn_…` value. A Personal Access Token can see everything the user can see, so no per-page sharing is needed.

Do not proceed until you have the token. Never hard-code it into a file the user might commit — put it in the MCP settings env block as shown below.

## Install (npx — recommended, no build step)

Add this entry to the user's Cline MCP settings file (`cline_mcp_settings.json`, reachable via the MCP Servers icon → **Configure MCP Servers**):

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "notion-mcp-server"],
      "env": {
        "NOTION_TOKEN": "ntn_paste_the_users_token_here"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

That is the whole setup. Cline will download the package on first run via `npx`. No global install or clone required.

## Verify it works

After saving, the `notion` server should show as connected. Confirm by asking the agent to run a read-only call, e.g. *"Use Notion to search for a page called 'Getting Started'."* It should return results (or an empty list) rather than an auth error.

## Optional configuration

All optional — set only if the user asks:

- **`NOTION_PAGE_ID`** — a default parent page ID used by `create_page` / `create_database` when no parent is passed. Omit to always pass a parent explicitly.
- **`NOTION_ALLOWED_OPERATIONS` / `NOTION_BLOCKED_OPERATIONS`** — comma-separated allow/block lists (group presets like `read` / `destructive`, or exact operation names) to restrict what the server can do. E.g. `"NOTION_ALLOWED_OPERATIONS": "read"` for a read-only setup, or `"NOTION_BLOCKED_OPERATIONS": "destructive"` to keep writes but forbid deletes. Blocklist wins. See the README's "Restricting operations" section.

## Docker alternative

If the user prefers a container over npx:

```json
{
  "mcpServers": {
    "notion": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "NOTION_TOKEN", "ghcr.io/awkoy/notion-mcp-server:latest"],
      "env": { "NOTION_TOKEN": "ntn_paste_the_users_token_here" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

The `-i` flag is required (stdio transport). Full documentation is in [README.md](./README.md).
