# FAQ

## What is the Notion MCP server and how does it work?

A Model Context Protocol server that connects AI assistants — Claude, Cursor, VS Code Copilot, Cline, Zed, Continue, anything that speaks MCP — to your Notion workspace. It runs locally, in Docker, or as an HTTP endpoint, and exposes three MCP tools the AI calls to read, write and inspect Notion operations. You authenticate once with a Notion token; the rest is natural language.

## How do I connect Claude to Notion using MCP?

Get a PAT at [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens), then run:

```bash
npx add-mcp notion-mcp-server --env NOTION_TOKEN=ntn_xxx
```

It writes the config for whichever installed client you pick. Manual config blocks for each client are in the [Quick start](../README.md#quick-start), and there's a [walkthrough for Claude Desktop](./claude-desktop-walkthrough.md) that assumes no prior setup.

## What's the difference between this and Notion's official MCP?

Notion's **hosted** MCP (`mcp.notion.com`) is OAuth-only and built for interactive chat, so it can't run headless; Notion says non-interactive authorization is in the works. Their **open-source** server is, in Notion's words, "no longer actively maintained", and exposes one tool per endpoint.

This server authenticates with a token, so it works in CI and automation, exposes three tools dispatching 47 operations, batches mutations with idempotency and retries, and slims responses to cut token cost. Full table: [Which Notion MCP should you use?](../README.md#which-notion-mcp-should-you-use)

## Can I use it with Cursor, VS Code, ChatGPT or Cline?

Cursor, VS Code (Copilot agent mode), Cline, Zed, Continue, Codex, Windsurf, Gemini CLI: yes, and `add-mcp` configures most of them for you.

ChatGPT's built-in connectors require OAuth-hosted servers, so use Notion's hosted MCP there. Developers can still reach this server from the OpenAI API's `mcp` tool by pointing it at a self-hosted [HTTP endpoint](../README.md#remote--http-transport) with a bearer token.

## Is it safe to give an AI my Notion token?

The token lives in your MCP client's local config and is only ever sent to `api.notion.com` over HTTPS. The server is open source, so you can read every line of it.

A PAT has the same access you do, so don't paste it into clients you don't trust, and revoke it at [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens) if a laptop goes missing. For agents that should never write, set `NOTION_READ_ONLY=true`; for finer control, see [Restricting operations](../README.md#restricting-operations).

## Does it work with self-hosted or local-only LLMs?

Yes. Anything that speaks MCP over stdio or Streamable HTTP works — the server doesn't care what's on the other side of the protocol.
