# Claude Desktop + Notion, step by step

For anyone who has never opened a config file. Fifteen minutes at the outside, usually five.

You need a Notion account, the [Claude Desktop app](https://claude.ai/download), and nothing else.

## Step 1 — get your Notion token

A Personal Access Token (PAT) is a key that lets the AI act as **you** inside Notion. It sees every page you can see, with no per-page setup.

1. Open **[app.notion.com/developers/tokens](https://app.notion.com/developers/tokens)** while logged into Notion. That's the **Personal access tokens** page of Notion's developer portal, also reachable from the app via **Settings → Connections → Develop or manage integrations → Personal access tokens**.
2. Click **+ New token**.
3. Name it (`Claude`, say), pick the workspace, leave the default **Notion API** capability checked, click **Create token**.

   <img src="https://raw.githubusercontent.com/awkoy/notion-mcp-server/main/assets/notion-new-token-modal.png" width="460" alt="The New personal access token dialog: enter a token name, pick the workspace it has access to, keep the Notion API capability checked, then press Create token">

4. **Copy the token now.** Notion shows it once. It starts with `ntn_` and should be treated like a password.

PATs expire a year after creation, so set yourself a reminder to rotate. No "Personal access tokens" page? Your admin disabled them — use the [Internal Integration alternative](../README.md#token-pat-or-internal-integration).

## Step 2 — install the server

**The easy way: the one-click extension.** Download [`notion-mcp-server.mcpb` from the latest release](https://github.com/awkoy/notion-mcp-server/releases/latest/download/notion-mcp-server.mcpb) and double-click it, or drag it into Claude Desktop → **Settings → Extensions**. Paste your token when prompted and you're done. No config file, no Node.js.

**If you'd rather use the config file**, and you have [Node.js](https://nodejs.org) installed:

1. Claude Desktop → **Claude** menu (top-left on Mac, hamburger on Windows) → **Settings** → **Developer** → **Edit Config**.
2. A file called `claude_desktop_config.json` opens. It's just text, curly braces and all.
3. Select all (`Cmd+A` / `Ctrl+A`), delete, paste this:

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "notion-mcp-server"],
      "env": {
        "NOTION_TOKEN": "ntn_paste_your_token_here"
      }
    }
  }
}
```

4. Replace `ntn_paste_your_token_here` with your token, keeping the quotation marks.
5. Save (`Cmd+S` / `Ctrl+S`).
6. **Quit Claude Desktop completely** — `Cmd+Q` on Mac, tray icon → Quit on Windows — and reopen it. Closing the window isn't enough.

That block tells Claude Desktop how to launch the server; `npx` downloads it on first run.

## Step 3 — check it worked

Type **`/`** in a new chat. You should see `notion_read`, `notion_write` and `notion_describe` in the list. Then ask:

> *"Use Notion to make a new page called 'Hello from Claude' and add a checklist of three things I want to try today."*

Claude calls the tool and answers with a link to the page.

If nothing happens, it's nearly always one of two things: a typo in the token, or Claude Desktop not fully quit before reopening. The [troubleshooting list](../README.md#troubleshooting) covers the rest.
