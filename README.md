# Notion MCP Server

![License](https://img.shields.io/badge/license-MIT-green)
![TypeScript](https://img.shields.io/badge/TypeScript-4.9+-blue)
![Model Context Protocol](https://img.shields.io/badge/MCP-Enabled-purple)
[![smithery badge](https://smithery.ai/badge/@awkoy/notion-mcp-server)](https://smithery.ai/server/@awkoy/notion-mcp-server)
![NPM Downloads](https://img.shields.io/npm/dw/notion-mcp-server)
![Stars](https://img.shields.io/github/stars/awkoy/notion-mcp-server)

**Notion MCP Server** is a Model Context Protocol (MCP) server implementation that enables AI assistants to interact with Notion's API. This production-ready server provides a complete set of tools and endpoints for reading, creating, and modifying Notion content through natural language interactions.

> 🚧 **Active Development**: Database support is now available! Comments and user management tools have been added. If you find this project useful, please consider giving it a star - it helps me know that this work is valuable to the community and motivates further development.

<a href="https://glama.ai/mcp/servers/zrh07hteaa">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/zrh07hteaa/badge" />
</a>

## 📑 Table of Contents

- [Quick start](#-quick-start)
  - [Option 1 — Personal Access Token (recommended)](#option-1--personal-access-token-recommended)
  - [Option 2 — Internal Integration (legacy)](#option-2--internal-integration-legacy)
  - [Optional: `NOTION_PAGE_ID`](#optional-notion_page_id)
  - [Cursor / Claude Desktop](#cursor--claude-desktop)
- [Features](#-features)
- [Documentation](#-documentation)
  - [Available Tools](#available-tools)
  - [Available Resources](#available-resources)
- [Development](#-development)
- [Technical Details](#-technical-details)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

## 🚀 Quick start

> **Already running notion-mcp-server v1.1.x?** If your `NOTION_TOKEN` is set and tools work today, **nothing changes for you in v1.2.0**. The setup paths below are recommendations for new installs and for users hitting per-page sharing pain.

### Option 1 — Personal Access Token (recommended)

A Personal Access Token (PAT) acts as you. It sees every page you can see — no per-page "Connect" dance in Notion's UI.

1. Open Notion → **Settings → My Settings → Personal Access Tokens** → **Generate**.
2. Copy the `ntn_...` token.
3. Add the MCP server (Claude Code shown; equivalent for Cursor and Claude Desktop below):

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- node /absolute/path/to/notion-mcp-server/build/index.js
```

That's it. The PAT does not expire under your control.

### Option 2 — Internal Integration (legacy)

Use this if you specifically want a workspace-scoped integration with explicit per-page access.

1. Open Notion → **Settings → Connections → Develop or manage integrations** → **New integration**.
2. Copy the Internal Integration Secret (`ntn_...` on new integrations; `secret_...` on older ones).
3. Use the same `claude mcp add` command as above — the env var is identical.
4. **Important:** open each page or database in Notion's UI and click **• • • → Connect → \<your integration name\>** to grant access. This is the per-page friction that PATs eliminate.

### Optional: `NOTION_PAGE_ID`

A default parent page used by `create_page` / `create_database` when the caller doesn't pass one. Operations that need a parent and don't get one now return a clear validation error instead of crashing the server.

To find a page ID: open the page in Notion → **Share → Copy link**. The ID is the last 32 characters of the URL.

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_xxx \
  -e NOTION_PAGE_ID=abc123... \
  -- node /absolute/path/to/notion-mcp-server/build/index.js
```

### Cursor / Claude Desktop

Add this entry to your MCP config JSON (`~/.cursor/mcp.json` for Cursor, `~/Library/Application Support/Claude/claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "notion": {
      "command": "node",
      "args": ["/absolute/path/to/notion-mcp-server/build/index.js"],
      "env": {
        "NOTION_TOKEN": "ntn_paste_your_token_here"
      }
    }
  }
}
```

## 🌟 Features

- **📝 Notion Integration** - Interact with Notion databases, pages, and blocks
- **🔌 Universal MCP Compatibility** - Works with all MCP clients including Cursor, Claude Desktop, Cline, and Zed
- **🔍 Data Retrieval** - Fetch information from Notion pages, blocks, and databases
- **✏️ Content Creation** - Create and update Notion pages and blocks
- **📊 Block Management** - Append, update, and delete blocks within Notion pages
- **💾 Database Operations** - Create, query, and update databases
- **🔄 Batch Operations** - Perform multiple operations in a single request
- **🗑️ Archive & Restore** - Archive and restore Notion pages
- **🔎 Search Functionality** - Search Notion pages and databases by title
- **💬 Comments Management** - Get, create, and reply to comments on pages and discussions
- **👥 User Management** - Retrieve workspace users and user information

## 📚 Documentation

### Available Tools

The server provides the following consolidated tools for interacting with Notion:

#### `notion_pages`

A comprehensive tool for page operations including:
- Creating new pages with specified content
- Updating page properties
- Archiving pages (moving to trash)
- Restoring previously archived pages
- Searching for pages by title

Example operations:
```javascript
{
  "payload": {
    "action": "create_page", // One of: "create_page", "archive_page", "restore_page", "search_pages", "update_page_properties"
    "params": {
      // Parameters specific to the chosen action
    }
  }
}
```

#### `notion_blocks`

A complete toolkit for block operations including:
- Retrieving block content
- Fetching child blocks
- Appending new blocks to a parent
- Updating existing blocks
- Deleting blocks
- Performing batch operations (append, update, delete, mixed)

Example operations:
```javascript
{
  "payload": {
    "action": "append_block_children", // One of: "append_block_children", "retrieve_block", "retrieve_block_children", "update_block", "delete_block", "batch_append_block_children", "batch_update_blocks", "batch_delete_blocks", "batch_mixed_operations"
    "params": {
      // Parameters specific to the chosen action
    }
  }
}
```

#### `notion_database`

A powerful tool for database interactions including:
- Creating new databases with custom properties
- Querying databases with filters and sorting
- Updating database structure and properties

Example operations:
```javascript
{
  "payload": {
    "action": "create_database", // One of: "create_database", "query_database", "update_database"
    "params": {
      // Parameters specific to the chosen action
    }
  }
}
```

#### `notion_comments`

A tool for managing comments on Notion content:
- Retrieving comments from pages and blocks
- Adding new comments to pages
- Replying to existing discussions

Example operations:
```javascript
{
  "payload": {
    "action": "get_comments", // One of: "get_comments", "add_page_comment", "add_discussion_comment"
    "params": {
      // Parameters specific to the chosen action
    }
  }
}
```

#### `notion_users`

A tool for accessing user information:
- Listing all workspace users
- Getting details about specific users
- Retrieving information about the current bot user

Example operations:
```javascript
{
  "payload": {
    "action": "list_users", // One of: "list_users", "get_user", "get_bot_user"
    "params": {
      // Parameters specific to the chosen action
    }
  }
}
```

### Available Resources

The server currently does not expose any resources, focusing instead on tool-based operations.

## 🛠 Development

1. **Clone the Repository**
   ```
   git clone https://github.com/awkoy/notion-mcp-server.git
   cd notion-mcp-server
   ```

2. **Install Dependencies**
   ```
   npm install
   ```

3. **Set Up Environment Variables**
   - Create a `.env` file with:
     ```
     NOTION_TOKEN=your_notion_api_key
     NOTION_PAGE_ID=your_notion_page_id
     ```

4. **Build the Project**
   ```
   npm run build
   ```

5. **Run the Inspector**
   ```
   npm run inspector
   ```

## 🔧 Technical Details

- Built using TypeScript and the MCP SDK (version 1.7.0+)
- Uses the official Notion API client (@notionhq/client v2.3.0+)
- Follows the Model Context Protocol specification
- Implements tools for CRUD operations on Notion pages, blocks, and databases
- Supports efficient batch operations for performance optimization
- Validates input/output with Zod schemas

## ❓ Troubleshooting

- **"object_not_found" / "Could not find ..."** — the integration token can only see pages explicitly shared with it. Switch to a PAT (Option 1) to skip per-page sharing.
- **"Notion auth failed: ..." on every call** — the token was missing, revoked, or rejected. Check `NOTION_TOKEN` is set in your MCP client config, and verify the token is still listed under Notion → Settings → My Settings → Personal Access Tokens (or Settings → Connections → Develop or manage integrations).
- **"No parent page configured"** — pass `parent` in the call, or set `NOTION_PAGE_ID` to a default.
- **Server logs "Notion auth check failed" on startup but tools still work** — the startup check is best-effort. If subsequent tool calls succeed, ignore the warning (Claude Code suppresses MCP stderr in normal operation anyway).

### Getting Help

- Create an issue on the [GitHub repository](https://github.com/awkoy/notion-mcp-server/issues)
- Check the [Notion API documentation](https://developers.notion.com/reference/intro)
- Visit the MCP community channels for assistance

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

