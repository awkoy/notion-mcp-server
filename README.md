# Notion MCP Server — Connect Claude, Cursor & ChatGPT to Notion via Model Context Protocol

![License](https://img.shields.io/badge/license-MIT-green)
![TypeScript](https://img.shields.io/badge/TypeScript-4.9+-blue)
![Model Context Protocol](https://img.shields.io/badge/MCP-Enabled-purple)
[![notion-mcp-server on Smithery](https://smithery.ai/badge/@awkoy/notion-mcp-server)](https://smithery.ai/server/@awkoy/notion-mcp-server)
![NPM Downloads](https://img.shields.io/npm/dw/notion-mcp-server)
![Stars](https://img.shields.io/github/stars/awkoy/notion-mcp-server)

An agent-first **Notion MCP server** (Model Context Protocol) that connects Claude, Cursor, ChatGPT, Claude Desktop, Cline, Zed and other MCP-compatible AI clients to Notion. Sign in once with your Notion **Personal Access Token (PAT)** — no per-page sharing dance, no extra integration to set up. Your AI sees the Notion pages you authorize the token for (typically your whole workspace) and can create pages, query databases, append blocks, leave comments, and upload files in natural language.

> **v2.4 — built for AI agents, not REST clients.** Two MCP tools instead of 36 endpoints, batched mutations, idempotency keys, automatic retries on Notion rate limits, self-healing validation errors (now path-sliced to <1KB), slim token-efficient responses, and a markdown shortcut so the model can write a whole page in one call.

<a href="https://glama.ai/mcp/servers/zrh07hteaa">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/zrh07hteaa/badge" alt="Notion MCP Server on Glama" />
</a>

## 📑 Table of Contents

- [5-minute install (no coding required)](#-5-minute-install-no-coding-required)
- [Why this server? (vs. the official Notion MCP)](#-why-this-server-vs-the-official-notion-mcp)
- [Developer install](#-developer-install)
  - [Authentication: PAT (recommended) vs. Internal Integration](#authentication-pat-recommended-vs-internal-integration)
  - [Get a Personal Access Token — full walkthrough](#get-a-personal-access-token--full-walkthrough)
  - [Backward compatibility from v1.x](#backward-compatibility-from-v1x)
  - [Claude Code / Cursor / Claude Desktop](#claude-code--cursor--claude-desktop)
  - [Docker / Podman / OrbStack](#docker--podman--orbstack)
  - [Optional `NOTION_PAGE_ID`](#optional-notion_page_id)
- [Remote / HTTP transport](#-remote--http-transport)
- [Features: what this Notion MCP server does](#-features-what-this-notion-mcp-server-does)
- [MCP tools for Notion (`notion_execute` & `notion_describe`)](#-mcp-tools-for-notion-notion_execute--notion_describe)
  - [`notion_execute`](#notion_execute)
  - [`notion_describe`](#notion_describe)
  - [Operations menu (35 ops, plus one alias)](#operations-menu-35-ops-plus-one-alias)
- [Development](#-development)
- [Technical details: how the Notion MCP server is built](#-technical-details-how-the-notion-mcp-server-is-built)
- [Troubleshooting the Notion MCP server](#-troubleshooting-the-notion-mcp-server)
- [FAQ: Notion MCP server](#-faq-notion-mcp-server)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🪄 5-minute install (no coding required)

You don't need to know what a terminal is. If you can copy text and paste it into two boxes, you can finish this.

### What you'll get
After setup, you can tell Claude things like:

- *"Make a page in my Personal workspace called 'Q3 plan' and add a checklist of these five items."*
- *"Find every page in my Tasks database where Status is 'Doing' and tell me which are overdue."*
- *"Comment on yesterday's meeting notes with a one-paragraph summary."*

Claude reads and writes Notion directly — no copy/paste, no browser tabs.

### What you'll need
1. A Notion account.
2. The [Claude Desktop app](https://claude.ai/download) installed. (Cursor and Claude Code work too — see [Developer install](#-developer-install).)
3. About 5 minutes.

### Step 1 — Get your Notion Personal Access Token

A Personal Access Token (PAT) is like a key that lets the AI act as **you** inside Notion. It can see every page **you** can see — no per-page setup.

1. Open the Notion developer portal: **[notion.so/profile/integrations](https://www.notion.so/profile/integrations)** (while logged into Notion). Same page if you go through the app: **Settings → Connections → Develop or manage integrations**.
2. Open the **Personal access tokens** tab → click **+ New personal access token**.
3. Give it a name like `Claude`, pick the **workspace** the token should act in, leave the default capabilities checked, and click **Create token**.
4. **Copy** the token — Notion shows the full value **only once**. It starts with `ntn_`. Treat it like a password.

> PATs **expire 1 year after creation**. Set a calendar reminder to rotate before then, or auth will start failing.
>
> Don't see a "Personal access tokens" tab? Your workspace admin may have disabled them — use the [Internal Integration alternative](#authentication-pat-recommended-vs-internal-integration).
>
> Need more detail (rotation, revocation, what a PAT can/can't do)? See the [full PAT walkthrough](#get-a-personal-access-token--full-walkthrough) further down. Official reference: [Notion PAT guide](https://developers.notion.com/guides/get-started/personal-access-tokens).

### Step 2 — Tell Claude Desktop where the server lives

1. Open Claude Desktop → click **Claude** (top-left menu on Mac, or the hamburger menu on Windows) → **Settings** → **Developer** → **Edit Config**.
2. A file called `claude_desktop_config.json` opens in a text editor. **Don't panic at the curly braces** — it's just text. We're going to swap all of it out.
3. **Select all** the text in that file (`Cmd+A` on Mac, `Ctrl+A` on Windows), **delete it**, then paste the block below.

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

> **What is this block?** It tells Claude Desktop how to launch the Notion connector. `npx` is a small tool that downloads and runs the connector automatically the first time — you don't install anything separately, it happens in the background (the first run may take a few seconds). `env` is where your Notion token goes. Leave every quote mark and bracket exactly as shown; the only thing you change is the token.

4. Replace `ntn_paste_your_token_here` with the token you copied in Step 1 — **leave the quotation marks around it**.
5. **Save** the file (`Cmd+S` / `Ctrl+S`).
6. **Quit Claude Desktop completely** (Mac: `Cmd+Q`, not just closing the window — Windows: right-click the tray icon → Quit) and reopen it.

### Step 2b — Did it work?

After Claude Desktop reopens, start a new chat and type **`/`** in the message box. You should see `notion_execute` and `notion_describe` appear in the slash-command list. If they don't, the connection didn't take — go back to **Settings → Developer → Edit Config**, check there's no typo in the token (it must stay between the quotation marks), and confirm you fully quit and reopened Claude Desktop. Common pitfalls are also covered in [Troubleshooting](#-troubleshooting-the-notion-mcp-server).

### Step 3 — Try it

In a new Claude chat, type:

> *"Use Notion to make a new page called 'Hello from Claude' under my workspace and add a checklist of three things I want to try today."*

You should see Claude call the `notion_execute` tool and report back with a page link. Click it — your new page is live in Notion.

That's it. If something doesn't work, the most common fix is in [Troubleshooting](#-troubleshooting-the-notion-mcp-server) below — usually a token typo or Claude Desktop not being fully quit and reopened. The rest of this README covers Docker, Cursor, Claude Code, and self-hosting for developers.

---

## ⚡ Why this server? (vs. the official Notion MCP)

There's a [first-party Notion MCP server](https://github.com/makenotion/notion-mcp-server). It works for simple one-off calls. For agent workloads — repeated queries, bulk mutations, long context windows — it gets expensive fast: one MCP tool per endpoint, no batching, no idempotency, raw response shapes. Those choices add up to real token cost and real latency.

This server is designed from the agent's side of the protocol.

| Capability | Official Notion MCP | **This server (designed for agents)** |
| --- | --- | --- |
| **Tool surface** | 22 tools (one per endpoint) loaded into context | **2 tools** (`notion_execute`, `notion_describe`) — the LLM loads ~90% less schema |
| **Operations covered** | ~22 endpoints | **35 operations** (plus a `trash_page` alias of `archive_page`) across pages, blocks, databases, data sources, comments, users, files |
| **Primary auth** | Internal Integration token + per-page "Connect" sharing | **Personal Access Token (PAT)** — uses the pages you've authorized for the token, zero per-page Connect step |
| **Batch mutations** | Not documented | ✅ Universal `{ items: [...] }` envelope; runs up to **10 in parallel** |
| **Atomic batches + rollback** | Not documented | ✅ `atomic: true` aborts on first failure, best-effort archives entities created earlier |
| **Idempotency** | Not documented | ✅ `idempotency_key` — same key + same op returns the cached result for 5 minutes |
| **Rate-limit handling** | Not documented (429s bubble up) | ✅ Shared token-bucket limiter (3 req/s default, configurable via `NOTION_RATE_LIMIT`) + exponential backoff on 429/5xx/timeouts, honors `Retry-After` |
| **Response shapes** | Raw Notion SDK JSON | **Slim shapers by default** — drops `archived: false`, `created_time`, `last_edited_time`, `in_trash: false`, empty descriptions, etc. `verbose: true` to opt out |
| **Database queries** | Raw `properties` bag per row | **Flattened** name → primitive map (title, rich_text, number, select, multi_select, status, date, people, files, checkbox, url, email, phone_number, formula, relation, rollup, unique_id, verification, created_by, last_edited_by, timestamps) |
| **Wire format** | Default SDK serialization | **Compact (un-indented) JSON** — ~30% smaller payloads vs. indented output, identical to parse |
| **Markdown input** | Page-level markdown editing supported | ✅ `markdown` shortcut on `create_page` / `append_blocks` / `update_block`, full markdown round-trip via `get_page_markdown` / `update_page_markdown`, plus markdown comment bodies — full GFM (paragraphs, headings 1–4, lists, to-dos with nested children, blockquotes, fenced code with language detection, images, dividers, inline bold/italic/strike/code/links) |
| **File uploads** | Not in the documented tool surface | ✅ `upload_file` handles single-part and multi-part (5 MB chunks) transparently; MIME inferred from filename; rejects `application/octet-stream` |
| **Validation errors** | Plain error string | **Self-healing**: `{ code, message, path, issues, schema, example, fix }` — agent corrects bad payloads in one round-trip without calling describe |
| **Notion API version** | Not pinned in client config | Pinned to `2025-09-03` (the modern data-sources line) |

### Real-world impact

- **Renaming 50 pages.** Without a batch envelope, the agent issues 50 separate `update-page` MCP calls — each one re-loading the tool schema and serialized through the agent's reasoning loop. With this server, the agent issues one `notion_execute` call with `{ items: [...], concurrency: 10 }`. Wall-clock improvement is roughly an order of magnitude on typical batch sizes; the bigger win is the tokens saved on prompt overhead.
- **Loading the tool list into the agent's context.** Official server: 22 schema blobs every conversation. This server: 2 schema blobs — and only those 2 ever appear in the agent's tool list, regardless of which of the 35 operations the agent ends up calling.
- **Reading a 100-row database.** Official server returns the raw Notion `properties` bag per row. This server flattens it; for a typical CRM table this is roughly **5–10× fewer tokens** without losing information.

---

## 🚀 Developer install

### Authentication: PAT (recommended) vs. Internal Integration

There are two ways to authenticate. Both use the `NOTION_TOKEN` env var — only how you obtain the token differs.

| | **Personal Access Token** (recommended) | **Internal Integration** (legacy) |
| --- | --- | --- |
| Where you get it | [notion.so/profile/integrations](https://www.notion.so/profile/integrations) → **Personal access tokens** tab → **+ New personal access token** | [notion.so/profile/integrations/internal](https://www.notion.so/profile/integrations/internal) → **+ New connection** |
| Token prefix | `ntn_…` | `ntn_…` (new) or `secret_…` (older) |
| Scope | Everything **you** can see | Only pages where you've clicked **• • • → Connect → \<integration\>** |
| Setup friction | None — works immediately | Per-page Connect dance for every page or database the agent should touch |
| When to use | Default. Personal workspaces, team workspaces where you're authorized, prototyping. | When a workspace admin requires explicit per-resource scoping for compliance, or for shared production bots. |

The rest of this README assumes PAT. Swap in an integration secret if you prefer the scoped model — every command below is identical.

> 💡 **Heads-up:** most "object_not_found" errors are a wrong auth choice, not a bug. If your agent reports "Could not find page" on pages you can see in Notion, you're almost certainly using an Internal Integration token that hasn't been Connected to those pages — switch to a PAT.

### Get a Personal Access Token — full walkthrough

[Step 1 of the 5-minute install](#step-1--get-your-notion-personal-access-token) covers the happy path. This section covers what surrounds it: capabilities, expiry, revocation, and the admin-disabled fallback.

> 📖 Official: [Notion PAT guide](https://developers.notion.com/guides/get-started/personal-access-tokens) · [Authorization overview](https://developers.notion.com/docs/authorization).

#### What a PAT can and can't do

| Can | Can't |
| --- | --- |
| Read every page you have access to | Access workspaces or pages you personally can't see |
| Create / update pages and databases in workspaces where you have edit rights | Bypass workspace permission rules |
| Add comments under your identity | Act as another user |
| Upload files via the File Upload API | Modify workspace-level admin settings |

A PAT is a **scope = your account**. If you lose edit access to a page, the PAT loses it too. Issue separate tokens to teammates — don't share one.

#### Expiry and rotation

**PATs expire 1 year after creation** ([Notion docs](https://developers.notion.com/guides/get-started/personal-access-tokens)). After expiry, every API call returns an auth error until you replace the token. Set a calendar reminder for ~11 months out.

#### Revoking a PAT

1. Open **[notion.so/profile/integrations](https://www.notion.so/profile/integrations)** → **Personal access tokens** tab.
2. Find the token by name → **• • • → Revoke**.
3. Update `NOTION_TOKEN` in your MCP client config and restart the client.

Workspace admins can revoke any user's PATs from **Settings & members → Connections → All personal access tokens**. Revocation is immediate.

#### Workspace admin disabled PATs?

Some enterprise workspaces only allow scoped Internal Integrations. Two options:

1. **Ask your admin to enable PATs** for your account.
2. **Use the [Internal Integration](#authentication-pat-recommended-vs-internal-integration) path** — same `NOTION_TOKEN` env var; create it at **[notion.so/profile/integrations/internal](https://www.notion.so/profile/integrations/internal) → + New connection**, then click **• • • → Connect** on every page or database you want the agent to touch.

### Backward compatibility from v1.x

If you ran a v1.x setup, **nothing in your environment needs to change**. Both env vars still work:

| Env var | Status in v2.4 | Notes |
| --- | --- | --- |
| `NOTION_TOKEN` | ✅ Required | Accepts **PATs** (`ntn_…`, recommended) and **Internal Integration secrets** (`secret_…` or `ntn_…`, legacy). Identical handling. |
| `NOTION_PAGE_ID` | ✅ Optional | Still works as the default parent page for `create_page` / `create_database` when no `parent` is passed. v2 added a clean `missing_parent` validation error instead of v1's crash when neither is provided. |
| `NOTION_RATE_LIMIT` | ✅ New, optional | Requests per second for the shared limiter. Defaults to `3` (Notion's documented per-integration limit). |
| `NOTION_ALLOWED_OPERATIONS` | ✅ New, optional | Comma-separated allowlist of operations or group presets (`read`, `write`, `destructive`, plus per-domain groups `pages`, `blocks`, `databases`, `data_sources`, `comments`, `users`, `files`). Unset ⇒ all operations enabled. See [Restricting operations](#restricting-operations). |
| `NOTION_BLOCKED_OPERATIONS` | ✅ New, optional | Comma-separated blocklist (same token vocabulary). Applied after the allowlist, so a blocked operation is always disabled. |
| `NOTION_READ_ONLY` | ✅ New, optional | Set to `true`/`1`/`yes` to disable every write operation in one switch (equivalent to `NOTION_BLOCKED_OPERATIONS=write`). Composes with the allow/block lists. See [Restricting operations](#restricting-operations). |
| `NOTION_DAILY_LOG_PAGE_ID` | ✅ Optional | Used only by the daily-log MCP prompt. Ignore if you don't call that prompt. |

The only v2 break is the **tool surface itself** — v1's `notion_pages`, `notion_blocks`, `notion_database`, `notion_comments`, `notion_users` are replaced by `notion_execute` and `notion_describe`. Modern MCP clients (Claude Code, Cursor, Claude Desktop) rediscover tools at startup, so they pick up the new surface automatically. If your client hard-codes the v1 tool names, see [MIGRATION.md](./MIGRATION.md) for the rename map.

A typical v1.x invocation continues to work unchanged:

```bash
NOTION_TOKEN=secret_xxx NOTION_PAGE_ID=abc123... node build/index.js
```

### Restricting operations

By default every operation is available. To limit what an agent can do, set
`NOTION_ALLOWED_OPERATIONS` (an allowlist) and/or `NOTION_BLOCKED_OPERATIONS` (a
blocklist). Each is a comma-separated list of **tokens**, where a token is either a
**group preset** or an exact **operation name**.

**Group presets** (one token expands to many operations):

| Token | Expands to |
| --- | --- |
| `read` | every non-mutating operation |
| `write` | every mutating operation |
| `destructive` | operations whose purpose is removal (marked † below) |
| `pages` `blocks` `databases` `data_sources` `comments` `users` `files` | every operation in that resource family (read **and** write) |

**All operations** — use any name directly for a precise allow/blocklist. († = also in the `destructive` group.)

| Domain | Read | Write |
| --- | --- | --- |
| `pages` | `search_pages` `get_page` `get_page_markdown` | `create_page` `set_page_title` `set_page_property` `set_page_properties` `update_page_markdown` `move_page` `restore_page` `archive_page`† `trash_page`† |
| `blocks` | `get_block` `get_block_children` | `append_blocks` `update_block` `delete_block`† `batch_mixed_blocks`† |
| `databases` | `query_database` | `create_database` `update_database` |
| `data_sources` | `list_data_sources` `get_data_source` | `update_data_source` |
| `views` | `list_views` `get_view` `query_view` | `create_view` `update_view` `delete_view`† |
| `comments` | `list_comments` `get_comment` | `add_page_comment` `add_discussion_comment` `update_comment` `delete_comment`† |
| `users` | `list_users` `get_user` `get_bot_user` `get_self` | — |
| `files` | `list_file_uploads` `get_file_upload` | `upload_file` |

Read-only deployment (the most common case):

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "notion-mcp-server"],
      "env": {
        "NOTION_TOKEN": "ntn_paste_your_token_here",
        "NOTION_ALLOWED_OPERATIONS": "read"
      }
    }
  }
}
```

Allow everything except destructive operations:

```json
{ "env": { "NOTION_BLOCKED_OPERATIONS": "destructive" } }
```

Mix presets and individual ops (read everything, plus append blocks and comments):

```json
{ "env": { "NOTION_ALLOWED_OPERATIONS": "read,append_blocks,add_page_comment" } }
```

**Rules:** tokens are case-insensitive; unknown tokens are ignored with a warning; the
blocklist wins on conflict; and if the allowlist is set but resolves to no enabled
operations (all tokens invalid, or every allowed op also blocked), **all** operations are
disabled (fail-closed). Disabled operations are hidden from the `notion://operations`
menu and from `notion_describe`, and `notion_execute` rejects them with
`operation_not_allowed`.

**Verifying your configuration.** On startup the server prints one line to **stderr**
(visible in your MCP client's server logs) summarizing what resolved, e.g.:

```text
Operation access: 16/37 enabled (allow=read; block=(none))
```

Unknown tokens and a fail-closed allowlist are logged there too. If the count or the
`allow`/`block` values aren't what you expect, check that line first.

**Limitations** (control is per-operation, not per-parameter):

- The `destructive` group covers operations whose *purpose* is removal (`trash_page`,
  `archive_page`, `delete_block`, `delete_comment`, `batch_mixed_blocks`). A few *write*
  operations can also remove content via a parameter — e.g. `update_database` /
  `update_data_source` accept `in_trash`, and `update_page_markdown` can replace a page
  body. Blocking `destructive` does **not** disable those write ops. **For a guaranteed
  no-mutation deployment, use the allowlist** (`NOTION_ALLOWED_OPERATIONS=read`) or the
  shorthand `NOTION_READ_ONLY=true` — both leave only read operations enabled.
- MCP *prompts* (e.g. the daily-log prompt) may still reference operations you have
  disabled. The prompt text is unaffected by the allowlist; the underlying operation is
  still rejected at execution time.

### Claude Code / Cursor / Claude Desktop

**Claude Code:**

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- npx -y notion-mcp-server
```

**Cursor** (`~/.cursor/mcp.json`) **or Claude Desktop** (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` · Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

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

**Local build (no npx):**

```bash
git clone https://github.com/awkoy/notion-mcp-server.git
cd notion-mcp-server
npm install && npm run build

claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- node "$(pwd)/build/index.js"
```

### Docker / Podman / OrbStack

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- docker run --rm -i -e NOTION_TOKEN ghcr.io/awkoy/notion-mcp-server:latest
```

The `-i` flag is required (stdio transport). `-e NOTION_TOKEN` (no `=value`) forwards the env var from the parent process.

For Cursor / Claude Desktop:

```json
{
  "mcpServers": {
    "notion": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-e", "NOTION_TOKEN", "ghcr.io/awkoy/notion-mcp-server:latest"],
      "env": { "NOTION_TOKEN": "ntn_paste_your_token_here" }
    }
  }
}
```

The published image is OCI-compliant — **Podman**, **OrbStack**, **colima**, **Rancher Desktop**, **Finch**, and **nerdctl** all work with the same flags (substitute the runtime's CLI for `docker`). Docker Desktop is not required.

### Optional `NOTION_PAGE_ID`

A default parent page for `create_page` / `create_database` when the caller doesn't pass one. Operations that need a parent and don't get one return a clear validation error instead of crashing.

To find a page ID: open the page in Notion → **Share → Copy link**. The ID is the last 32 characters of the URL.

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_xxx \
  -e NOTION_PAGE_ID=abc123... \
  -- npx -y notion-mcp-server
```

---

## 🌐 Remote / HTTP transport

By default the server speaks **stdio** (the local connector path above). To run it as a remote/hosted endpoint — for web clients, networked agents, or a shared deployment — set `MCP_TRANSPORT=http`:

```bash
MCP_TRANSPORT=http PORT=3000 NOTION_TOKEN=ntn_xxx npx -y notion-mcp-server
# -> notion-mcp-server vX.Y.Z running on http://127.0.0.1:3000/mcp
```

It serves the MCP **Streamable HTTP** protocol at `POST/GET/DELETE /mcp` (stateful sessions via the `mcp-session-id` header) plus an unauthenticated `GET /health`. It's **single-tenant** — every request uses the one `NOTION_TOKEN` the process was started with.

### Configuration

| env | default | meaning |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | set to `http` to enable the HTTP transport |
| `PORT` | `3000` | listen port (`0` = OS-assigned) |
| `HOST` | `127.0.0.1` | bind address. Loopback by default; set `0.0.0.0` to expose externally (do this only with `MCP_AUTH_TOKEN`) |
| `MCP_AUTH_TOKEN` | — | when set, every `/mcp` request must send `Authorization: Bearer <token>` |
| `MCP_ALLOWED_HOSTS` | localhost + bound host | comma-list for DNS-rebinding `Host` allowlist |
| `MCP_ALLOWED_ORIGINS` | localhost origins | comma-list for browser `Origin` allowlist |

> ⚠️ **Single-tenant means whoever reaches `/mcp` acts as your `NOTION_TOKEN`.** On loopback (the default) that's just local processes. Before binding a non-loopback `HOST`, set `MCP_AUTH_TOKEN` (the server logs a warning if you don't) and/or put it behind an authenticating reverse proxy.

### Try it

```bash
# health check
curl http://127.0.0.1:3000/health
# -> {"status":"healthy","transport":"http","port":3000}

# point the MCP Inspector at it
npx @modelcontextprotocol/inspector --transport http --server-url http://127.0.0.1:3000/mcp
```

In Docker, set the env and publish the port:

```bash
docker run --rm -e NOTION_TOKEN=ntn_xxx -e MCP_TRANSPORT=http -p 3000:3000 ghcr.io/awkoy/notion-mcp-server
```

---

## 🌟 Features: what this Notion MCP server does

- **Two-tool surface** — `notion_execute` (do it) + `notion_describe` (learn the shape). The whole API is one schema deep.
- **Universal batch envelope** — every mutating op accepts `{ items: [...], atomic?, idempotency_key?, concurrency? }`. Per-item validation, per-item results, summary counts.
- **Atomic batches with best-effort rollback** — `atomic: true` aborts on first failure and archives anything created earlier in the batch.
- **Idempotency keys** — same `(operation, idempotency_key)` returns the cached batch result for 5 minutes (max 512 entries). Safe to retry on flaky networks.
- **Rate-limit + retry baked in** — shared token-bucket limiter (3 req/s default, configurable via `NOTION_RATE_LIMIT`); transient SDK failures (429, 5xx, timeouts) auto-retry with exponential backoff and honor `Retry-After`.
- **Self-healing validation errors** — every failure returns `{ schema, example, fix }`. The model corrects bad payloads in one round-trip — no extra `notion_describe` call needed.
- **Markdown shortcut** — `create_page` / `append_blocks` / `update_block` / `update_page_markdown` / comment bodies accept a `markdown` string (full GFM: paragraphs, headings 1–4, lists, to-dos with nested children, blockquotes, fenced code with language normalization, dividers, images, inline bold/italic/strike/code/links).
- **Slim responses + flattened rows** — defaults drop noisy fields and the `query_database` rows flatten each property to a name → primitive map. `verbose: true` per call to get the raw SDK shape. Compact JSON wire format (~30% smaller payloads).
- **File uploads** — `upload_file` handles single-part and multi-part (5 MB chunks) transparently; auto-detects MIME from filename; rejects `application/octet-stream`.
- **Opt-in auto-pagination** — pass `paginate: true` on `search_pages`, `list_comments`, or `query_database` and the server walks `next_cursor` for you (capped by `page_limit`, default 10 pages ≈ 1000 items at `page_size: 100`). Other list ops return a single Notion page with `has_more` / `next_cursor`.
- **Typed `where` filter shorthand** — `query_database` accepts a `where` clause like `{Status: {equals: "Done"}, AND: [...]}` with operator objects (`eq`, `ne`, `gte`, `lte`, `contains`, `starts_with`, etc.); the server compiles it to Notion filter JSON. Pass raw Notion `filter` JSON for edge cases the shorthand can't express (the two fields are mutually exclusive).
- **Database views** — `list_views` / `get_view` / `query_view` plus `create_view` / `update_view` / `delete_view`. `query_view` runs a view's stored filters/sorts and returns hydrated rows by default (`hydrate: false` for ids only); `create_view` / `update_view` reuse the same `where` shorthand for filters and take a raw `configuration` for type-specific layout (calendar/board/timeline/chart/map require it).
- **Universal MCP compatibility** — Cursor, Claude Desktop, Claude Code, Cline, Zed, Continue, anything that speaks MCP stdio.

---

## 📚 MCP tools for Notion (`notion_execute` & `notion_describe`)

The v2 server exposes exactly **two** MCP tools — your AI client only ever loads these two schemas, regardless of which of the 35 Notion operations you call.

### `notion_execute`

Run any Notion operation. Pass `{ operation, payload }` — payload is either a single object, or `{ items: [...] }` for batch mode.

**Single call:**

```jsonc
{
  "operation": "set_page_title",
  "payload": { "page_id": "<page-id>", "title": "Q3 plan" }
}
```

**Batch:**

```jsonc
{
  "operation": "set_page_title",
  "payload": {
    "items": [
      { "page_id": "<p1>", "title": "First" },
      { "page_id": "<p2>", "title": "Second" }
    ],
    "atomic": false,
    "concurrency": 3,
    "idempotency_key": "rename-pass-2025-05-26"
  }
}
```

**Markdown shortcut** (works in `create_page`, `append_blocks`, `update_block`, `update_page_markdown`):

```jsonc
{
  "operation": "create_page",
  "payload": {
    "parent": { "type": "page_id", "page_id": "<parent>" },
    "title": "Notes",
    "markdown": "# Heading\n\n- [ ] todo\n- [x] done\n\n```ts\nconst x = 1;\n```"
  }
}
```

**Self-healing errors:** if the payload doesn't validate, the response includes the full JSON Schema for that operation plus a working example, so the next call can be corrected without round-tripping through `notion_describe`.

### `notion_describe`

Return the JSON Schema + working example for a single operation. Use this when you want to see the shape of a complex op (filter expressions, mixed block batches, full database property definitions) before calling `notion_execute`.

```jsonc
{ "operation": "query_database" }
```

### Operations menu (41 ops, plus one alias)

| Area | Operations |
| --- | --- |
| **Pages** | `create_page`, `get_page`, `set_page_title`, `set_page_property`, `set_page_properties`, `archive_page` (alias: `trash_page`), `restore_page`, `search_pages`, `move_page`, `get_page_markdown`, `update_page_markdown` |
| **Blocks** | `append_blocks`, `get_block`, `get_block_children`, `update_block`, `delete_block`, `batch_mixed_blocks` |
| **Databases** | `create_database`, `query_database`, `update_database` |
| **Data sources** | `list_data_sources`, `get_data_source`, `update_data_source` |
| **Views** | `list_views`, `get_view`, `query_view`, `create_view`, `update_view`, `delete_view` |
| **Comments** | `list_comments`, `add_page_comment`, `add_discussion_comment`, `get_comment`, `update_comment`, `delete_comment` |
| **Users** | `list_users`, `get_user`, `get_bot_user` |
| **Files** | `upload_file`, `list_file_uploads`, `get_file_upload` |

The authoritative list (with batchability) is also served as an MCP resource at `notion://operations` — useful as a one-shot cheat sheet for the LLM.

### MCP resources

The server exposes three resources, so clients that support resource attachment (`@`-mention) can pull Notion content into context without a tool call:

| Resource URI | Returns |
| --- | --- |
| `notion://operations` | Markdown cheat sheet of every enabled operation. |
| `notion://page/<page_id>` | The page body as markdown. |
| `notion://database/<data_source_id>` | The data source's schema as JSON. |

The dynamic page/database resources route through the same auth, rate limiting, and access gating as tool calls — a page disabled by your allow/block config (or `NOTION_READ_ONLY`) returns an error envelope, not content.

---

## 🛠 Development

```bash
git clone https://github.com/awkoy/notion-mcp-server.git
cd notion-mcp-server
npm install

# Set NOTION_TOKEN (and optionally NOTION_PAGE_ID) in a .env file.
echo "NOTION_TOKEN=ntn_xxx" > .env

npm run build       # tsc -> build/
npm test            # vitest smoke suite
npm run inspector   # MCP inspector against the built binary
```

---

## 🔧 Technical details: how the Notion MCP server is built

- TypeScript + MCP SDK (`^1.29.0`)
- Notion SDK `@notionhq/client@^5.22.0`, pinned `Notion-Version: 2025-09-03`
- Zod 4 payload validation; emits draft-7 JSON Schema with `$defs` deduplication for error envelopes
- Markdown → Notion blocks via the `remark` / `remark-gfm` pipeline
- Bounded-concurrency batch worker (default 3, max 10)
- Shared token-bucket rate limiter; `withRetry` wraps every dispatched call with exponential backoff on transient failures
- In-memory idempotency cache (5-minute TTL, 512 entries)
- Slim shapers per entity type (`slimPage`, `slimBlock`, `slimDatabase`, `slimDataSource`, `slimUser`, `slimComment`, `slimFileUpload`) with `verbose: true` opt-out
- Vitest smoke harness covering the markdown parser, slim shapers, schema emitter, dispatcher, batch partial success / atomic rollback / idempotency dedupe (`npm test`)

---

## ❓ Troubleshooting the Notion MCP server

- **"object_not_found" / "Could not find ..."** — the integration token can only see pages explicitly shared with it. Switch to a PAT to skip per-page sharing.
- **"Notion auth failed" on every call** — the token was missing, revoked, or expired (PATs expire 1 year after creation). Check `NOTION_TOKEN` is set in your MCP client config, then open [notion.so/profile/integrations](https://www.notion.so/profile/integrations) → **Personal access tokens** and confirm yours is still listed and not past its expiry. If it expired, create a new one and update the env var.
- **"No parent page configured"** — pass `parent` in the call, or set `NOTION_PAGE_ID` to a default.
- **"multi_source_database" error from `query_database`** — your database has more than one data source. Call `list_data_sources` to get the IDs, then pass `data_source_id` instead of `database_id`.
- **Server logs "Notion auth check failed" on startup but tools still work** — the startup check is best-effort. If subsequent tool calls succeed, ignore the warning (Claude Code suppresses MCP stderr anyway).
- **Docker container exits immediately / "Connection closed"** — the `-i` flag is required so Docker keeps stdin open for the MCP stdio transport. `docker run --rm -i ...`, not `docker run --rm ...`.
- **Docker: "NOTION_TOKEN is not set" despite passing `-e`** — make sure the form is `-e NOTION_TOKEN` (forwards from parent env) or `-e NOTION_TOKEN=ntn_xxx` (inline value), not `-e NOTION_TOKEN ntn_xxx` (treated as two separate args).

### Getting help

- [GitHub Issues](https://github.com/awkoy/notion-mcp-server/issues)
- [Notion API reference](https://developers.notion.com/reference/intro)
- [Model Context Protocol spec](https://modelcontextprotocol.io)

---

## 💬 FAQ: Notion MCP server

### What is the Notion MCP server and how does it work?

The Notion MCP server is a Model Context Protocol (MCP) server that connects AI assistants — Claude, Cursor, ChatGPT, Claude Desktop, Cline, Zed, Continue, anything that speaks MCP — to your Notion workspace. It runs locally (or in Docker) and exposes two MCP tools (`notion_execute`, `notion_describe`) that the AI calls to read and write Notion. You authenticate once with a Notion Personal Access Token; everything else is natural language.

### How do I connect Claude to Notion using MCP?

Follow the [5-minute install](#-5-minute-install-no-coding-required) above. The short version: get a Notion Personal Access Token at [notion.so/profile/integrations](https://www.notion.so/profile/integrations) → **Personal access tokens** tab → **+ New personal access token**, then paste it into Claude Desktop's `claude_desktop_config.json` (Settings → Developer → Edit Config). Quit and reopen Claude Desktop and you can ask it to create or read Notion pages directly.

### What is a Notion Personal Access Token and how do I get one?

A Personal Access Token (PAT) is a key that lets an app act as **you** inside Notion. It can see every page you can see — no per-page "Connect" step required. Generate one at **[notion.so/profile/integrations](https://www.notion.so/profile/integrations) → Personal access tokens → + New personal access token**. The token starts with `ntn_…` and expires 1 year after creation. Treat it like a password; don't commit it to git or share it publicly. See the [full walkthrough](#get-a-personal-access-token--full-walkthrough) for capabilities, rotation, and admin restrictions, or the [official Notion guide](https://developers.notion.com/guides/get-started/personal-access-tokens).

### What's the difference between this Notion MCP server and the official Notion MCP?

The official Notion MCP server exposes one MCP tool per REST endpoint (22 tools), uses an Internal Integration token (which requires per-page sharing in Notion's UI), and returns raw Notion JSON. This server exposes two tools that dispatch 36 named operations, defaults to a Personal Access Token (no per-page setup), batches mutations, retries on rate limits, and slims responses to cut token usage. See the [full comparison table](#-why-this-server-vs-the-official-notion-mcp).

### Can I use this Notion MCP server with Cursor, ChatGPT, or Cline?

Yes. Anything that speaks the MCP stdio protocol works: Claude Desktop, Claude Code, Cursor, Cline, Zed, Continue, and self-hosted clients. Cursor uses `~/.cursor/mcp.json`; the config block is in the [Developer install](#-developer-install) section. ChatGPT support depends on the client you're using — any wrapper that supports MCP servers will work.

### Is it safe to give an AI my Notion token?

The token is stored locally in your MCP client's config file and only sent to the Notion API (over HTTPS). It never leaves your machine except to talk to `api.notion.com`. The server itself is open source — you can read every line. That said, a PAT has the same access your account does, so don't paste it into untrusted clients, and revoke it at [notion.so/profile/integrations](https://www.notion.so/profile/integrations) → Personal access tokens if a laptop is lost.

### Does this work with self-hosted or local-only LLMs?

Yes, as long as the LLM client supports MCP stdio (or you run a wrapper that bridges it). The server doesn't care what's on the other side of the protocol.

---

## 🤝 Contributing

PRs welcome. Fork → branch → commit → push → PR. Run `npm test` before submitting.

## 📄 License

MIT — see [LICENSE](./LICENSE).
