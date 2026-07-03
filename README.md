# Notion MCP Server — Connect Claude, Cursor & VS Code to Notion

[![npm version](https://img.shields.io/npm/v/notion-mcp-server)](https://www.npmjs.com/package/notion-mcp-server)
![NPM Downloads](https://img.shields.io/npm/dw/notion-mcp-server)
![License](https://img.shields.io/badge/license-MIT-green)
![Model Context Protocol](https://img.shields.io/badge/MCP-Streamable_HTTP_+_stdio-purple)
[![notion-mcp-server on Smithery](https://smithery.ai/badge/@awkoy/notion-mcp-server)](https://smithery.ai/server/@awkoy/notion-mcp-server)
![Stars](https://img.shields.io/github/stars/awkoy/notion-mcp-server)

Give your AI full read/write access to Notion with **one token and one paste**. This is an agent-first **Notion MCP server**: your AI client (Claude Code, Claude Desktop, Cursor, VS Code, Cline, Zed — anything that speaks MCP) can create pages, query databases, append blocks, apply templates, comment, and upload files in natural language.

Three reasons it exists when Notion ships its own MCP:

- **Built for agents, not humans-in-the-loop.** Notion's hosted MCP is OAuth-only — it cannot run headless. This server authenticates with a token, so it works in **CI, cron jobs, background agents, and self-hosted deployments** where nobody can click "Authorize".
- **~90% less context overhead.** Two MCP tools (`notion_execute` + `notion_describe`) dispatch **43 operations**, instead of one tool schema per endpoint flooding your agent's context.
- **The operational stuff is built in.** Batched mutations with atomic rollback, idempotency keys, automatic retry on rate limits, slim token-efficient responses, full markdown round-trip, and self-healing validation errors that let the model fix its own bad payloads in one turn.

<a href="https://glama.ai/mcp/servers/zrh07hteaa">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/zrh07hteaa/badge" alt="Notion MCP Server on Glama" />
</a>

## ⚡ Quick start

**Step 1 — get a Notion token (1 minute).** Open **[app.notion.com/developers/tokens](https://app.notion.com/developers/tokens)** (the **Personal access tokens** page of Notion's developer portal) → **+ New token** → name it, pick your workspace → **Create token** → copy the `ntn_…` value. That's it — a PAT sees everything *you* can see, no per-page sharing required. (Page missing or empty? Your admin disabled PATs — see [auth alternatives](#authentication-pat-recommended-vs-internal-integration).)

<img src="https://raw.githubusercontent.com/awkoy/notion-mcp-server/main/assets/notion-pat-page.png" width="640" alt="Notion developer portal — the Personal access tokens page with the + New token button in the top right">

**Step 2 — add the server to your client.**

### Claude Code

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- npx -y notion-mcp-server
```

### Cursor

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=notion&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm5vdGlvbi1tY3Atc2VydmVyIl0sImVudiI6eyJOT1RJT05fVE9LRU4iOiJZT1VSX05PVElPTl9UT0tFTiJ9fQ==)

Click the badge (then replace `YOUR_NOTION_TOKEN` in the generated entry), or add to `~/.cursor/mcp.json` yourself:

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "notion-mcp-server"],
      "env": { "NOTION_TOKEN": "ntn_paste_your_token_here" }
    }
  }
}
```

### VS Code (Copilot agent mode)

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Notion_MCP-0098FF?logo=githubcopilot)](https://insiders.vscode.dev/redirect/mcp/install?name=notion&inputs=%5B%7B%22id%22%3A%22notion_token%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22Notion%20Personal%20Access%20Token%20(ntn_...)%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22notion-mcp-server%22%5D%2C%22env%22%3A%7B%22NOTION_TOKEN%22%3A%22%24%7Binput%3Anotion_token%7D%22%7D%7D)

VS Code prompts for the token on install and stores it as a secret input.

### Claude Desktop

**Easiest: the one-click extension.** Download [`notion-mcp-server.mcpb` from the latest release](https://github.com/awkoy/notion-mcp-server/releases/latest/download/notion-mcp-server.mcpb), double-click it (or drag into Claude Desktop → Settings → Extensions), paste your Notion token when prompted — done. No config files, Node.js not required.

**Or via the config file:** Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "notion-mcp-server"],
      "env": { "NOTION_TOKEN": "ntn_paste_your_token_here" }
    }
  }
}
```

Quit Claude Desktop fully (`Cmd+Q` / tray → Quit) and reopen. **Never used a config file before?** Follow the [step-by-step walkthrough for non-developers](#-complete-walkthrough-no-coding-required) — it assumes nothing.

### Docker / Podman / OrbStack

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- docker run --rm -i -e NOTION_TOKEN ghcr.io/awkoy/notion-mcp-server:latest
```

The `-i` flag is required (stdio transport). The image is OCI-compliant — Podman, OrbStack, colima, Rancher Desktop, Finch, and nerdctl all work with the same flags.

**Step 3 — try it.** In a new chat:

> *"Use Notion to make a page called 'Hello from my agent' and add a checklist of three things to try today."*

Your AI calls `notion_execute` and replies with a live page link.

## 💡 What your AI can do with it

- *"Find every row in my Tasks database where Status is 'Doing' and tell me which are overdue."* — typed `where` filters, flattened rows
- *"Rename these 50 pages to the new convention."* — one batched call, 10-way parallel, idempotent retry
- *"Create a page from my 'Weekly review' template and fill in this summary."* — Notion templates support
- *"Rewrite that spec page: fix the headings and add a code sample."* — full markdown round-trip (`get_page_markdown` → edit → `update_page_markdown`)
- *"Comment on yesterday's meeting notes with a one-paragraph summary."*
- *"Upload this diagram to the design page."* — single- and multi-part file uploads

Full capability list in [Features](#-features-what-this-notion-mcp-server-does); the complete operation catalog (43 ops) is in the [Operations menu](#operations-menu-43-ops-plus-one-alias).

## 🧭 Which Notion MCP should you use?

Three options exist. Honest guidance:

| | Best for | Auth | Headless / CI | Notes |
| --- | --- | --- | --- | --- |
| **[Notion hosted MCP](https://developers.notion.com/docs/get-started-with-mcp)** (`mcp.notion.com`) | Interactive chat in claude.ai, ChatGPT, Cursor | OAuth (human must click) | ❌ | First-party, 18 markdown tools, some plan-gated |
| **[Official open-source server](https://github.com/makenotion/notion-mcp-server)** | — | Token | ✅ | Notion has soft-deprecated it (“may sunset this repository… issues and PRs not actively monitored”) |
| **This server** | Agents, automation, CI, self-hosting, token-sensitive workloads | Token (PAT) | ✅ | Actively maintained, agent-first design below |

If you just want to chat with your Notion in claude.ai's web UI, use Notion's hosted connector — it's one click. Use **this** server when your agent runs unattended, when context/token cost matters, or when you want batch/idempotent semantics and self-hosting.

<details>
<summary><b>Detailed comparison vs. the official open-source server</b></summary>

| Capability | Official Notion MCP (open source) | **This server** |
| --- | --- | --- |
| **Tool surface** | ~24 tools (one per endpoint) loaded into context | **2 tools** — the LLM loads ~90% less schema |
| **Operations covered** | ~24 endpoints | **43 operations** (plus a `trash_page` alias) across pages, blocks, databases, data sources, views, templates, comments, users, files |
| **Batch mutations** | Not documented | ✅ Universal `{ items: [...] }` envelope; up to **10 in parallel** |
| **Atomic batches + rollback** | Not documented | ✅ `atomic: true` aborts on first failure, best-effort archives entities created earlier |
| **Idempotency** | Not documented | ✅ `idempotency_key` — same key + op returns the cached result for 5 minutes |
| **Rate-limit handling** | 429s bubble up | ✅ Token-bucket limiter (3 req/s default) + exponential backoff, honors `Retry-After` |
| **Response shapes** | Raw Notion SDK JSON | **Slim shapers** drop noise by default; `verbose: true` opts out |
| **Database queries** | Raw `properties` bag per row | **Flattened** name → primitive map (all 20+ property types) |
| **Wire format** | Default SDK serialization | **Compact JSON** — ~30% smaller payloads |
| **Markdown** | Page-level markdown tools | ✅ Markdown accepted by `create_page` / `append_blocks` / `update_block` / comments + full round-trip (`get_page_markdown` / `update_page_markdown`), full GFM |
| **Templates** | — | ✅ `create_page` from a Notion template + `list_data_source_templates` discovery |
| **File uploads** | Not in the documented tool surface | ✅ Single- and multi-part (5 MB chunks), MIME inferred |
| **Validation errors** | Plain error string | **Self-healing**: `{ code, message, path, issues, schema, example, fix }` — corrected in one round-trip |
| **Notion API version** | — | Pinned `2026-03-11` (data sources, views, templates) |

**Real-world impact:**

- **Renaming 50 pages** — one `notion_execute` call with `{ items: [...], concurrency: 10 }` instead of 50 separate tool calls through the agent's reasoning loop: roughly an order of magnitude faster, and the prompt-token savings are the bigger win.
- **Tool list in context** — 2 schema blobs per conversation instead of ~24, no matter which of the 43 operations get called.
- **Reading a 100-row database** — flattened rows are typically **5–10× fewer tokens** than the raw `properties` bag, with no information loss.

</details>

## 🪄 Complete walkthrough (no coding required)

<details>
<summary><b>Set up Claude Desktop + Notion in 5 minutes — assumes you've never seen a config file</b></summary>

### What you'll need

1. A Notion account.
2. The [Claude Desktop app](https://claude.ai/download).
3. About 5 minutes.

### Step 1 — Get your Notion token

A Personal Access Token (PAT) is like a key that lets the AI act as **you** inside Notion — it sees every page you can see, with no per-page setup.

1. Open **[app.notion.com/developers/tokens](https://app.notion.com/developers/tokens)** while logged into Notion — that's the **Personal access tokens** page of Notion's developer portal (also reachable from the app via **Settings → Connections → Develop or manage integrations** → **Personal access tokens** in the sidebar).
2. Click **+ New token**.
3. Name it (e.g. `Claude`), pick the workspace, leave the default **Notion API** capability checked, click **Create token**.

   <img src="https://raw.githubusercontent.com/awkoy/notion-mcp-server/main/assets/notion-new-token-modal.png" width="460" alt="The New personal access token dialog: enter a token name, pick the workspace it has access to, keep the Notion API capability checked, then press Create token">

4. **Copy the token now** — Notion shows it only once. It starts with `ntn_`. Treat it like a password.

> PATs **expire 1 year after creation** — set a reminder to rotate. No "Personal access tokens" tab? Your admin disabled them; use the [Internal Integration alternative](#authentication-pat-recommended-vs-internal-integration).

### Step 2 — Tell Claude Desktop about the server

1. Open Claude Desktop → **Claude** menu (top-left on Mac, hamburger on Windows) → **Settings** → **Developer** → **Edit Config**.
2. A file named `claude_desktop_config.json` opens. Don't panic at the curly braces — it's just text.
3. Select all (`Cmd+A` / `Ctrl+A`), delete, and paste:

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

> This block tells Claude Desktop how to launch the connector. `npx` downloads and runs it automatically the first time. The only thing you change is the token.

4. Replace `ntn_paste_your_token_here` with your token — **keep the quotation marks**.
5. Save (`Cmd+S` / `Ctrl+S`).
6. **Quit Claude Desktop completely** (Mac: `Cmd+Q`; Windows: tray icon → Quit) and reopen it.

### Step 3 — Check and try

Type **`/`** in a new chat — you should see `notion_execute` and `notion_describe` in the list. Then ask:

> *"Use Notion to make a new page called 'Hello from Claude' and add a checklist of three things I want to try today."*

Claude calls the tool and replies with a page link. If something's off, it's almost always a token typo or Claude Desktop not fully quit — see [Troubleshooting](#-troubleshooting-the-notion-mcp-server).

</details>

## 🔧 Configuration

### Authentication: PAT (recommended) vs. Internal Integration

Both use the same `NOTION_TOKEN` env var — only where you get the token differs.

| | **Personal Access Token** (recommended) | **Internal Integration** (scoped) |
| --- | --- | --- |
| Where | [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens) → **+ New token** | [app.notion.com/developers/connections](https://app.notion.com/developers/connections) → **+ New connection** |
| Scope | Everything **you** can see | Only pages where you clicked **• • • → Connect → \<integration\>** |
| Friction | None | Per-page Connect step for every page/database |
| Use when | Default: personal + team workspaces, prototyping | Admin requires explicit per-resource scoping, or shared production bots |

> 💡 Most `object_not_found` errors are a wrong auth choice, not a bug: an Internal Integration token that was never Connected to the page. Switch to a PAT.

<details>
<summary><b>PAT details: capabilities, expiry, revocation, admin-disabled fallback</b></summary>

**Can:** read every page you have access to; create/update pages and databases where you have edit rights; comment as you; upload files.
**Can't:** access pages you can't see; bypass workspace permissions; act as another user; change admin settings. A PAT's scope = your account — if you lose access to a page, so does the PAT. Issue separate tokens per teammate.

**Expiry:** PATs expire **1 year after creation** ([Notion docs](https://developers.notion.com/guides/get-started/personal-access-tokens)); set a reminder for ~11 months.

**Revoking:** [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens) → **Revoke** next to the token (immediate). Workspace admins can revoke anyone's from **Settings & members → Connections → All personal access tokens**.

**Admin disabled PATs?** Ask them to enable, or create an Internal Integration at [app.notion.com/developers/connections](https://app.notion.com/developers/connections) (**+ New connection**) and **• • • → Connect** it to every page the agent should touch — same `NOTION_TOKEN` env var.

Official reference: [PAT guide](https://developers.notion.com/guides/get-started/personal-access-tokens) · [Authorization overview](https://developers.notion.com/docs/authorization).

</details>

### Environment variables

| Env var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `NOTION_TOKEN` | ✅ | — | PAT (`ntn_…`, recommended) or Internal Integration secret (`secret_…` / `ntn_…`) |
| `NOTION_PAGE_ID` | — | — | Default parent for `create_page` / `create_database` when no `parent` is passed (page → Share → Copy link; ID = last 32 chars) |
| `NOTION_RATE_LIMIT` | — | `3` | Requests/second for the shared limiter (Notion's documented per-integration limit) |
| `NOTION_READ_ONLY` | — | — | `true`/`1`/`yes` disables every write operation in one switch |
| `NOTION_ALLOWED_OPERATIONS` | — | all | Comma-separated allowlist of operations or group presets — see [Restricting operations](#restricting-operations) |
| `NOTION_BLOCKED_OPERATIONS` | — | — | Comma-separated blocklist (same vocabulary); wins over the allowlist |
| `HTTPS_PROXY` / `HTTP_PROXY` | — | — | Route Notion API traffic through an HTTP(S) proxy (standard env vars, lowercase also accepted) |
| `NOTION_DAILY_LOG_PAGE_ID` | — | — | Only used by the daily-log MCP prompt |

HTTP-transport variables (`MCP_TRANSPORT`, `PORT`, `HOST`, `MCP_AUTH_TOKEN`, …) are covered in [Remote / HTTP transport](#-remote--http-transport).

> **Upgrading from v1.x?** Your env vars all still work unchanged. The only break is the tool surface (v1's five tools became `notion_execute` + `notion_describe`); modern clients rediscover tools automatically. Details: [MIGRATION.md](./MIGRATION.md).

### Restricting operations

Limit what an agent can do with `NOTION_ALLOWED_OPERATIONS` (allowlist) and/or `NOTION_BLOCKED_OPERATIONS` (blocklist) — each a comma-separated list of **group presets** or exact **operation names**.

| Preset | Expands to |
| --- | --- |
| `read` | every non-mutating operation |
| `write` | every mutating operation |
| `destructive` | operations whose purpose is removal (`archive_page`/`trash_page`, `delete_block`, `batch_mixed_blocks`, `delete_comment`, `delete_view`) |
| `pages` `blocks` `databases` `data_sources` `views` `comments` `users` `files` | every operation in that family (read **and** write) |

Read-only deployment (most common):

```json
{ "env": { "NOTION_TOKEN": "ntn_xxx", "NOTION_ALLOWED_OPERATIONS": "read" } }
```

Everything except destructive ops:

```json
{ "env": { "NOTION_BLOCKED_OPERATIONS": "destructive" } }
```

Mix presets and individual ops:

```json
{ "env": { "NOTION_ALLOWED_OPERATIONS": "read,append_blocks,add_page_comment" } }
```

**Rules:** case-insensitive; unknown tokens ignored with a warning; blocklist wins; an allowlist that resolves to zero operations disables **everything** (fail-closed). Disabled operations disappear from `notion_describe` and the `notion://operations` menu, and `notion_execute` rejects them with `operation_not_allowed`.

On startup the server logs one line to stderr summarizing what resolved — check it first if the config doesn't behave as expected:

```text
Operation access: 20/44 enabled (allow=read; block=(none))
```

<details>
<summary><b>Per-operation reference & limitations</b></summary>

| Domain | Read | Write |
| --- | --- | --- |
| `pages` | `search_pages` `get_page` `get_page_markdown` | `create_page` `set_page_title` `set_page_property` `set_page_properties` `update_page_markdown` `move_page` `restore_page` `archive_page`† `trash_page`† |
| `blocks` | `get_block` `get_block_children` | `append_blocks` `update_block` `delete_block`† `batch_mixed_blocks`† |
| `databases` | `query_database` | `create_database` `update_database` |
| `data_sources` | `list_data_sources` `get_data_source` `list_data_source_templates` | `update_data_source` |
| `views` | `list_views` `get_view` `query_view` | `create_view` `update_view` `delete_view`† |
| `comments` | `list_comments` `get_comment` | `add_page_comment` `add_discussion_comment` `update_comment` `delete_comment`† |
| `users` | `list_users` `get_user` `get_bot_user` `get_self` | — |
| `files` | `list_file_uploads` `get_file_upload` | `upload_file` |

† = also in the `destructive` group.

**Limitations** (control is per-operation, not per-parameter): a few *write* ops can remove content via a parameter — `update_database` / `update_data_source` accept `in_trash`, and `update_page_markdown` can replace a page body. Blocking `destructive` does **not** disable those. For a guaranteed no-mutation deployment use `NOTION_ALLOWED_OPERATIONS=read` or `NOTION_READ_ONLY=true`. MCP *prompts* may still mention disabled operations, but execution is rejected.

</details>

## 🌐 Remote / HTTP transport

By default the server speaks **stdio** (the local path above). To run it as a remote/hosted endpoint — web clients, networked agents, shared deployments — set `MCP_TRANSPORT=http`:

```bash
MCP_TRANSPORT=http PORT=3000 NOTION_TOKEN=ntn_xxx npx -y notion-mcp-server
# -> notion-mcp-server vX.Y.Z running on http://127.0.0.1:3000/mcp
```

It serves MCP **Streamable HTTP** at `POST/GET/DELETE /mcp` (stateful sessions via the `mcp-session-id` header) plus an unauthenticated `GET /health`. It's **single-tenant** — every request acts as the one `NOTION_TOKEN` the process started with.

| env | default | meaning |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | set to `http` to enable HTTP |
| `PORT` | `3000` | listen port (`0` = OS-assigned) |
| `HOST` | `127.0.0.1` | bind address; set `0.0.0.0` to expose externally (**only with `MCP_AUTH_TOKEN`**) |
| `MCP_AUTH_TOKEN` | — | when set, every `/mcp` request must send `Authorization: Bearer <token>` |
| `MCP_ALLOWED_HOSTS` | localhost + bound host | comma-list for DNS-rebinding `Host` allowlist |
| `MCP_ALLOWED_ORIGINS` | localhost origins | comma-list for browser `Origin` allowlist |

> ⚠️ **Whoever reaches `/mcp` acts as your `NOTION_TOKEN`.** On loopback (the default) that's just local processes. Before binding a non-loopback `HOST`, set `MCP_AUTH_TOKEN` (the server warns if you don't) and/or front it with an authenticating reverse proxy.

Connect from clients that support headers (Claude Code, Cursor, VS Code):

```bash
claude mcp add --transport http notion https://your-host/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Try it locally:

```bash
curl http://127.0.0.1:3000/health
# -> {"status":"healthy","transport":"http","port":3000}
npx @modelcontextprotocol/inspector --transport http --server-url http://127.0.0.1:3000/mcp
```

In Docker:

```bash
docker run --rm -e NOTION_TOKEN=ntn_xxx -e MCP_TRANSPORT=http -p 3000:3000 ghcr.io/awkoy/notion-mcp-server
```

## 🌟 Features: what this Notion MCP server does

- **Two-tool surface** — `notion_execute` (do it) + `notion_describe` (learn the shape). The whole API is one schema deep.
- **Universal batch envelope** — every mutating op accepts `{ items: [...], atomic?, idempotency_key?, concurrency? }` with per-item validation and results.
- **Atomic batches with best-effort rollback** — `atomic: true` aborts on first failure and archives anything created earlier in the batch.
- **Idempotency keys** — same `(operation, idempotency_key)` returns the cached result for 5 minutes. Safe to retry on flaky networks.
- **Rate-limit + retry baked in** — token-bucket limiter (3 req/s default, `NOTION_RATE_LIMIT` to change) with exponential backoff on 429/5xx/timeouts, honoring `Retry-After`.
- **Self-healing validation errors** — failures return `{ schema, example, fix }` so the model corrects bad payloads in one round-trip.
- **Markdown everywhere** — `create_page` / `append_blocks` / `update_block` / comment bodies accept a `markdown` string (full GFM: headings 1–4, lists, nested to-dos, blockquotes, fenced code with language detection, images, dividers, inline formatting), plus full round-trip via `get_page_markdown` / `update_page_markdown`.
- **Notion templates** — `create_page` can apply a data source's template (`template: { type: "template_id" | "default" }`), with `list_data_source_templates` to discover template IDs.
- **Database views** — list/get/query/create/update/delete views; `query_view` runs a view's stored filters/sorts and returns hydrated rows.
- **Typed `where` filter shorthand** — `query_database` takes `{Status: {equals: "Done"}, AND: [...]}` and compiles it to Notion filter JSON (raw `filter` still accepted for edge cases).
- **Slim responses + flattened rows** — noisy fields dropped by default, `query_database` rows flattened to name → primitive maps, compact JSON wire format (~30% smaller). `verbose: true` opts out per call.
- **File uploads** — single-part and multi-part (5 MB chunks) transparently; MIME inferred from filename.
- **Opt-in auto-pagination** — `paginate: true` on `search_pages` / `list_comments` / `query_database` walks `next_cursor` for you (default cap ≈ 1000 items).
- **HTTP(S) proxy support** — standard `HTTPS_PROXY` / `HTTP_PROXY` env vars for corporate networks.
- **Access control** — `NOTION_READ_ONLY` one-switch read-only mode plus per-operation allow/block lists.

## 📚 MCP tools (`notion_execute` & `notion_describe`)

The server exposes exactly **two** MCP tools — your client loads two schemas regardless of which of the 43 operations gets called.

### `notion_execute`

Run any operation: `{ operation, payload }`, where payload is a single object or `{ items: [...] }` for batch mode.

```jsonc
// single call
{
  "operation": "set_page_title",
  "payload": { "page_id": "<page-id>", "title": "Q3 plan" }
}
```

```jsonc
// batch
{
  "operation": "set_page_title",
  "payload": {
    "items": [
      { "page_id": "<p1>", "title": "First" },
      { "page_id": "<p2>", "title": "Second" }
    ],
    "atomic": false,
    "concurrency": 3,
    "idempotency_key": "rename-pass-2026-07-02"
  }
}
```

```jsonc
// markdown shortcut (create_page, append_blocks, update_block, update_page_markdown)
{
  "operation": "create_page",
  "payload": {
    "parent": { "type": "page_id", "page_id": "<parent>" },
    "title": "Notes",
    "markdown": "# Heading\n\n- [ ] todo\n- [x] done\n\n```ts\nconst x = 1;\n```"
  }
}
```

If a payload doesn't validate, the error response includes the operation's full JSON Schema, a working example, and a `fix` hint — the next call can be corrected without a `notion_describe` round-trip.

### `notion_describe`

Returns the JSON Schema + working example for one operation — useful before complex calls (filter expressions, mixed block batches, database property definitions).

```jsonc
{ "operation": "query_database" }
```

### Operations menu (43 ops, plus one alias)

| Area | Operations |
| --- | --- |
| **Pages** | `create_page`, `get_page`, `set_page_title`, `set_page_property`, `set_page_properties`, `archive_page` (alias: `trash_page`), `restore_page`, `search_pages`, `move_page`, `get_page_markdown`, `update_page_markdown` |
| **Blocks** | `append_blocks`, `get_block`, `get_block_children`, `update_block`, `delete_block`, `batch_mixed_blocks` |
| **Databases** | `create_database`, `query_database`, `update_database` |
| **Data sources** | `list_data_sources`, `get_data_source`, `update_data_source`, `list_data_source_templates` |
| **Views** | `list_views`, `get_view`, `query_view`, `create_view`, `update_view`, `delete_view` |
| **Comments** | `list_comments`, `add_page_comment`, `add_discussion_comment`, `get_comment`, `update_comment`, `delete_comment` |
| **Users** | `list_users`, `get_user`, `get_bot_user`, `get_self` |
| **Files** | `upload_file`, `list_file_uploads`, `get_file_upload` |

The authoritative list (with batchability) is served as an MCP resource at `notion://operations`.

### MCP resources

Clients that support resource attachment (`@`-mention) can pull Notion content into context without a tool call:

| Resource URI | Returns |
| --- | --- |
| `notion://operations` | Markdown cheat sheet of every enabled operation |
| `notion://page/<page_id>` | Page body as markdown |
| `notion://database/<data_source_id>` | Data source schema as JSON |

Dynamic resources route through the same auth, rate limiting, and access gating as tool calls.

## ❓ Troubleshooting the Notion MCP server

- **`object_not_found` / "Could not find …"** — an Internal Integration token only sees pages explicitly Connected to it. Switch to a PAT to skip per-page sharing.
- **"Notion auth failed" on every call** — token missing, revoked, or expired (PATs expire after 1 year). Check `NOTION_TOKEN` in your client config, then confirm the token is still listed as Active at [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens).
- **"No parent page configured"** — pass `parent` in the call, or set `NOTION_PAGE_ID`.
- **`multi_source_database` from `query_database`** — the database has multiple data sources. Call `list_data_sources`, then pass `data_source_id` instead of `database_id`.
- **Tools don't appear in Claude Desktop** — token typo (must stay inside the quotes) or the app wasn't fully quit (`Cmd+Q`, not window close) before reopening.
- **Startup logs "Notion auth check failed" but tools work** — the startup check is best-effort; ignore if calls succeed.
- **Docker exits immediately / "Connection closed"** — the `-i` flag is required: `docker run --rm -i …`.
- **Docker: "NOTION_TOKEN is not set" despite `-e`** — use `-e NOTION_TOKEN` (forwards from parent env) or `-e NOTION_TOKEN=ntn_xxx`, not `-e NOTION_TOKEN ntn_xxx`.

Still stuck? [GitHub Issues](https://github.com/awkoy/notion-mcp-server/issues) · [Notion API reference](https://developers.notion.com/reference/intro) · [MCP spec](https://modelcontextprotocol.io)

## 💬 FAQ: Notion MCP server

### What is the Notion MCP server and how does it work?

A Model Context Protocol server that connects AI assistants — Claude, Cursor, VS Code Copilot, Cline, Zed, Continue, anything that speaks MCP — to your Notion workspace. It runs locally (or in Docker, or as an HTTP endpoint) and exposes two MCP tools the AI calls to read and write Notion. You authenticate once with a Notion token; everything else is natural language.

### How do I connect Claude to Notion using MCP?

See the [Quick start](#-quick-start): get a PAT at [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens), then one `claude mcp add` command (Claude Code) or one JSON paste (Claude Desktop). Non-developers: the [complete walkthrough](#-complete-walkthrough-no-coding-required) assumes nothing.

### What's the difference between this and Notion's official MCP?

Notion's **hosted** MCP (`mcp.notion.com`) is OAuth-only and built for interactive chat — it can't run headless. Their **open-source** server is soft-deprecated and exposes one tool per endpoint. This server authenticates with a token (works in CI/automation), exposes 2 tools dispatching 43 operations, batches mutations with idempotency and retries, and slims responses to cut token cost. See [Which Notion MCP should you use?](#-which-notion-mcp-should-you-use).

### Can I use it with Cursor, VS Code, ChatGPT, or Cline?

Cursor, VS Code (Copilot agent mode), Cline, Zed, Continue: yes — install badges and config blocks are in the [Quick start](#-quick-start). ChatGPT's built-in connectors require OAuth-hosted servers, so use Notion's hosted MCP there; developers can still reach this server from the OpenAI API's `mcp` tool by pointing it at a self-hosted [HTTP endpoint](#-remote--http-transport) with a bearer token.

### Is it safe to give an AI my Notion token?

The token lives in your MCP client's local config and is only sent to `api.notion.com` over HTTPS. The server is open source — read every line. A PAT has the same access you do, so don't paste it into untrusted clients, and revoke it at [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens) if a laptop is lost. For agents that should never write, set `NOTION_READ_ONLY=true`.

### Does it work with self-hosted or local-only LLMs?

Yes — anything that speaks MCP stdio (or Streamable HTTP) works. The server doesn't care what's on the other side of the protocol.

## 🛠 Development

```bash
git clone https://github.com/awkoy/notion-mcp-server.git
cd notion-mcp-server
npm install
echo "NOTION_TOKEN=ntn_xxx" > .env

npm run build       # tsc -> build/
npm test            # vitest suite
npm run inspector   # MCP inspector against the built binary
```

Local build instead of npx:

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_xxx \
  -- node "$(pwd)/build/index.js"
```

<details>
<summary><b>Technical details: how it's built</b></summary>

- TypeScript + MCP SDK (`^1.29.0`); stdio + Streamable HTTP transports
- Notion SDK `@notionhq/client@^5.22.0`, pinned `Notion-Version: 2026-03-11`
- Zod 4 payload validation; emits draft-7 JSON Schema with `$defs` deduplication for error envelopes
- Markdown → Notion blocks via `remark` / `remark-gfm`
- Bounded-concurrency batch worker (default 3, max 10); shared token-bucket rate limiter; `withRetry` with exponential backoff around every dispatched call
- In-memory idempotency cache (5-minute TTL, 512 entries)
- Slim shapers per entity type with `verbose: true` opt-out
- Vitest suite covering the markdown parser, shapers, schema emitter, dispatcher, batch semantics (partial success / atomic rollback / idempotency), access control, and HTTP transport

</details>

## 🤝 Contributing

PRs welcome. Fork → branch → commit → push → PR. Run `npm test` before submitting.

## 📄 License

MIT — see [LICENSE](./LICENSE).

---

mcp-name: io.github.awkoy/notion-mcp-server
