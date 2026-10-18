# Notion MCP Server — Connect Claude, Cursor, VS Code & Codex to Notion

[![npm version](https://img.shields.io/npm/v/notion-mcp-server)](https://www.npmjs.com/package/notion-mcp-server)
[![npm downloads](https://img.shields.io/npm/dw/notion-mcp-server)](https://www.npmjs.com/package/notion-mcp-server)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**notion-mcp-server** is a Model Context Protocol (MCP) server that gives Claude Code, Claude Desktop, Cursor, VS Code, Codex and any other MCP client read/write access to Notion with one token. Your AI can search, create and edit pages, query databases, comment and upload files, in plain language.

- **Token auth on every Notion plan, Free included.** No browser sign-in, so it also runs headless: in CI, cron jobs, background agents and on your own server.
- **Light on context.** Its three tools cost 1,005 tokens at connection, against 17,163 for Notion's open-source server, and page reads come back 82% smaller. [Benchmark →](./benchmarks)
- **Built for agents.** Batched writes with atomic rollback and idempotency keys, retry on rate limits, markdown in and out, and errors that tell the model how to fix the call.

## Quick start

**1. Get a Notion token.** Open **[app.notion.com/developers/tokens](https://app.notion.com/developers/tokens)** → **+ New token** → name it, pick your workspace → **Create token** → copy the `ntn_…` value. A Personal Access Token sees everything *you* can see, with no per-page sharing. Can't create one? See the [other token option](#token-pat-or-internal-integration).

**2. Install it.**

```bash
npx add-mcp notion-mcp-server --env NOTION_TOKEN=ntn_paste_your_token_here
```

[`add-mcp`](https://github.com/neon-solutions/add-mcp) finds the MCP clients on your machine and writes the config for the ones you pick: Claude Code, Claude Desktop, Cursor, VS Code, Codex, Gemini CLI, Cline, Windsurf, Zed and more. Add `-g` to install for your user instead of the current project.

> Keep the `--env` flag. Without it the entry is written without a token, and every call fails with an auth error.

Or install in one click:

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=notion&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm5vdGlvbi1tY3Atc2VydmVyIl0sImVudiI6eyJOT1RJT05fVE9LRU4iOiJZT1VSX05PVElPTl9UT0tFTiJ9fQ==)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Notion_MCP-0098FF?logo=githubcopilot)](https://insiders.vscode.dev/redirect/mcp/install?name=notion&inputs=%5B%7B%22id%22%3A%22notion_token%22%2C%22type%22%3A%22promptString%22%2C%22description%22%3A%22Notion%20Personal%20Access%20Token%20(ntn_...)%22%2C%22password%22%3Atrue%7D%5D&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22notion-mcp-server%22%5D%2C%22env%22%3A%7B%22NOTION_TOKEN%22%3A%22%24%7Binput%3Anotion_token%7D%22%7D%7D)
[![Claude Desktop extension](https://img.shields.io/badge/Claude_Desktop-Download_.mcpb-D97757?logo=anthropic)](https://github.com/awkoy/notion-mcp-server/releases/latest/download/notion-mcp-server.mcpb)

- **Cursor:** replace `YOUR_NOTION_TOKEN` in the generated entry.
- **VS Code (Copilot agent mode):** it asks for the token and stores it as a secret.
- **Claude Desktop:** double-click the `.mcpb` file (or drag it into Settings → Extensions) and paste your token. No Node.js needed. New to all this? The [step-by-step walkthrough](./docs/claude-desktop-walkthrough.md) assumes nothing.

**Using Claude Code? Install it as a plugin instead.** The plugin bundles the server with a Notion workflow skill, which teaches Claude when to search, how to filter a database with `where`, and how to batch writes. Claude Code asks for the token when you install it (or later with `/plugin configure notion-mcp-server@awkoy`) and keeps it in your system keychain:

```
/plugin marketplace add awkoy/notion-mcp-server
/plugin install notion-mcp-server@awkoy
```

The plugin runs the npm release that matches its own version and needs Node.js 20 or later. It also offers a default parent page and a read-only switch; [the plugin's README](./plugins/notion-mcp-server/README.md) has the details.

<details>
<summary><b>Manual setup: JSON config, Claude Code, Codex, Gemini CLI, Docker</b></summary>

**Any client that reads an `mcpServers` block** (Cursor's `~/.cursor/mcp.json`, Claude Desktop's `claude_desktop_config.json`, Cline, Zed, Continue…):

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

**Claude Code:**

```bash
claude mcp add notion -s user -e NOTION_TOKEN=ntn_paste_your_token_here -- npx -y notion-mcp-server
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.notion]
command = "npx"
args = ["-y", "notion-mcp-server"]
env = { NOTION_TOKEN = "ntn_paste_your_token_here" }
```

**Gemini CLI:** `gemini extensions install https://github.com/awkoy/notion-mcp-server` asks for the token once and keeps it in your system keychain.

**Docker** (Podman, OrbStack and colima take the same flags; `-i` is required for stdio):

```bash
claude mcp add notion -s user -e NOTION_TOKEN=ntn_paste_your_token_here \
  -- docker run --rm -i -e NOTION_TOKEN ghcr.io/awkoy/notion-mcp-server:latest
```

</details>

**3. Try it.** In a new chat:

> *"Use Notion to make a page called 'Hello from my agent' and add a checklist of three things to try today."*

Your AI calls `notion_write` and replies with a link to the new page.

## What you can ask

- *"Find every row in my Tasks database where Status is 'Doing' and tell me which are overdue."*
- *"Rename these 50 pages to the new convention."* One batched call, not 50.
- *"Create a page from my 'Weekly review' template and fill in this summary."*
- *"Rewrite that spec page: fix the headings and add a code sample."* The page round-trips as markdown.
- *"Comment on yesterday's meeting notes with a one-paragraph summary."*
- *"Upload this diagram to the design page."*
- *"Look at the screenshot on that bug report and tell me what's wrong."* The model gets the image itself.

## Which Notion MCP should you use?

| | Best for | Auth | Headless / CI | Notes |
| --- | --- | --- | --- | --- |
| **[Notion hosted MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp)** (`mcp.notion.com`) | Interactive chat in claude.ai, ChatGPT, Cursor; Notion AI features | OAuth on every plan. MCP tokens on Business and Enterprise, created by workspace owners | Business and Enterprise only | First-party and the largest tool set (meeting notes, SQL across data sources, Custom Agents); several tools need a paid plan or Notion AI |
| **[Notion open-source server](https://github.com/makenotion/notion-mcp-server)** | — | Token | ✅ | Notion calls it deprecated and "no longer actively maintained" |
| **This server** | Agents, automation, CI, self-hosting, long sessions | Token, every plan | ✅ | Actively maintained; 3 tools, batched and idempotent writes |

To chat with Notion in claude.ai or ChatGPT, Notion's hosted connector is one click. Use this server when an agent runs unattended, when your plan has no MCP tokens, when context cost matters, or when you want it on your own host. [Detailed comparison →](./docs/comparison.md)

## Configuration

### Token: PAT or internal integration

Both go in the same `NOTION_TOKEN` env var; only where you get them differs.

| | **Personal Access Token** (recommended) | **Internal Integration** (scoped) |
| --- | --- | --- |
| Where | [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens) → **+ New token** | [app.notion.com/developers/connections](https://app.notion.com/developers/connections) → **+ New connection** |
| Scope | Everything **you** can see | Only pages where you clicked **• • • → Connect → \<integration\>** |
| Use when | Default: personal and team workspaces | You can't create a PAT, or an admin wants explicit per-page scoping |

- **Who can create a PAT.** Workspace owners always can. On Free and Business plans only owners can by default, on Plus every member can, and admins can change the policy on Business and Enterprise. Guests can't.
- **Expiry and revoking.** You pick the lifetime when you create it, a year at most. Revoke it on the same tokens page; it stops working immediately. Details: [Notion's PAT guide](https://developers.notion.com/guides/get-started/personal-access-tokens).
- **`object_not_found` on a page you can see?** That's an Internal Integration that was never Connected to the page. Connect it, or switch to a PAT.

### Environment variables

| Env var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `NOTION_TOKEN` | ✅ | — | PAT (`ntn_…`) or Internal Integration secret |
| `NOTION_PAGE_ID` | — | — | Default parent for `create_page` / `create_database` when no `parent` is passed (page URL or id) |
| `NOTION_RATE_LIMIT` | — | `3` | Requests per second (Notion's documented limit) |
| `NOTION_READ_ONLY` | — | — | `true` disables every write operation |
| `NOTION_ALLOWED_OPERATIONS` / `NOTION_BLOCKED_OPERATIONS` | — | — | Allowlist / blocklist of operations, see [Restricting operations](#restricting-operations) |
| `NOTION_CONFIRM_DESTRUCTIVE` | — | — | `true` asks you before a destructive operation runs |
| `NOTION_UPLOAD_ROOT` | — | — | Confines `upload_file`'s local `path` source to one directory, see [Files](#files) |
| `NOTION_FILE_URLS` | — | `full` | `ref` swaps Notion's long signed file URLs for short refs, see [Files](#files) |
| `HTTPS_PROXY` / `HTTP_PROXY` | — | — | Send all outbound traffic through a proxy |
| `NOTION_DAILY_LOG_PAGE_ID` | — | — | Only used by the daily-log MCP prompt |

HTTP variables are in [Remote / HTTP transport](#remote--http-transport). Upgrading from v1 or v2? Every env var still works; the tool names changed, see [MIGRATION.md](./MIGRATION.md).

### Restricting operations

`NOTION_READ_ONLY=true` turns off every write. For finer control, `NOTION_ALLOWED_OPERATIONS` and `NOTION_BLOCKED_OPERATIONS` take comma-separated operation names or presets: `read`, `write`, `destructive` (archive, trash and delete), or a family (`pages`, `blocks`, `databases`, `data_sources`, `views`, `comments`, `users`, `files`). The blocklist wins.

```jsonc
{ "env": { "NOTION_ALLOWED_OPERATIONS": "read" } }                       // read-only
{ "env": { "NOTION_BLOCKED_OPERATIONS": "destructive" } }                // everything except removals
{ "env": { "NOTION_ALLOWED_OPERATIONS": "read,append_blocks,add_page_comment" } }
```

Disabled operations disappear from the tool schemas, so the model never sees them. The server prints what resolved at startup, for example `Operation access: 22/48 enabled (allow=read; block=(none))`.

To be asked instead of blocked, set `NOTION_CONFIRM_DESTRUCTIVE=true`: before a destructive operation runs, your client shows a yes/no dialog naming the target. The client has to support MCP elicitation. The full rules, the per-operation list and the limits of per-operation control are in [docs/configuration.md](./docs/configuration.md#restricting-operations).

### Files

`upload_file` accepts base64, a public URL or a local path. A local path can be any file the server can read, so set `NOTION_UPLOAD_ROOT` to confine it to one directory when the model picks the path.

Notion's signed file URLs are about 500 tokens each and expire within an hour. `NOTION_FILE_URLS=ref` replaces them in responses with short `notion-file:` refs that `get_file_url` and `get_image` resolve on demand. [How refs work →](./docs/configuration.md#files)

## Remote / HTTP transport

The server speaks stdio by default. Set `MCP_TRANSPORT=http` to run it as a Streamable HTTP endpoint for web clients, networked agents and shared deployments:

```bash
MCP_TRANSPORT=http PORT=3000 NOTION_TOKEN=ntn_xxx npx -y notion-mcp-server
# -> notion-mcp-server vX.Y.Z running on http://127.0.0.1:3000/mcp
```

| env | default | meaning |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | set to `http` to enable HTTP |
| `PORT` | `3000` | listen port (`0` = OS-assigned) |
| `HOST` | `127.0.0.1` | bind address; `0.0.0.0` exposes it externally (**only with `MCP_AUTH_TOKEN`**) |
| `MCP_AUTH_TOKEN` | — | when set, every `/mcp` request must send `Authorization: Bearer <token>` |
| `MCP_ALLOWED_HOSTS` | localhost + bound host | comma-list for the DNS-rebinding `Host` allowlist |
| `MCP_ALLOWED_ORIGINS` | localhost origins | comma-list for the browser `Origin` allowlist |

> ⚠️ **Whoever reaches `/mcp` acts as your `NOTION_TOKEN`.** On loopback, the default, that means local processes only. Before binding a non-loopback `HOST`, set `MCP_AUTH_TOKEN` and put an authenticating reverse proxy in front.

```bash
claude mcp add --transport http notion https://your-host/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Docker, health checks and protocol versions: [docs/http-transport.md](./docs/http-transport.md).

## Tools and operations

Three tools, whichever of the 46 operations you end up calling: `notion_read` runs reads, `notion_write` runs writes, and `notion_describe` returns an operation's JSON Schema with a working example. Every id field also accepts a Notion URL, so paste what **Share → Copy link** gives you. Call examples, batch options and MCP resources: [docs/operations.md](./docs/operations.md).

### Per-tool permissions

The read/write split lets you approve reads once and keep writes behind a prompt. In Claude Code's `settings.json` (where `notion` is whatever you named the server):

```json
{ "permissions": { "allow": ["mcp__notion__notion_read", "mcp__notion__notion_describe"] } }
```

### Operations menu (46 ops, plus two aliases)

| Area | Operations |
| --- | --- |
| **Pages** | `create_page`, `get_page`, `set_page_title`, `set_page_property`, `set_page_properties`, `archive_page` (alias: `trash_page`), `restore_page`, `search_pages`, `move_page`, `get_page_markdown`, `update_page_markdown` |
| **Blocks** | `append_blocks`, `get_block`, `get_block_children`, `update_block`, `delete_block`, `batch_mixed_blocks` |
| **Databases** | `create_database`, `query_database`, `update_database`, `delete_database` |
| **Data sources** | `list_data_sources`, `get_data_source`, `update_data_source`, `delete_data_source`, `list_data_source_templates` |
| **Views** | `list_views`, `get_view`, `query_view`, `create_view`, `update_view`, `delete_view` |
| **Comments** | `list_comments`, `add_page_comment`, `add_discussion_comment`, `get_comment`, `update_comment`, `delete_comment` |
| **Users** | `list_users`, `get_user`, `get_bot_user` (alias: `get_self`) |
| **Files** | `upload_file`, `list_file_uploads`, `get_file_upload`, `get_file_url`, `get_image` |

## FAQ

**Does it work on the Notion Free plan?** Yes. A workspace owner can create a Personal Access Token on every plan, and the server needs nothing else.

**Is there a Notion MCP server without OAuth?** This one. It authenticates with a token, so nobody has to click Authorize. Notion's hosted MCP skips OAuth only on Business and Enterprise, with an MCP token a workspace owner creates.

**Which clients does it work with?** Any MCP client: Claude Code, Claude Desktop, Cursor, VS Code (Copilot agent mode), Codex, Gemini CLI, Cline, Windsurf, Zed, Continue, and local models through any MCP host. More in the [FAQ](./docs/faq.md).

## Troubleshooting

- **"Notion auth failed" on every call:** the token is missing, revoked or expired. Check `NOTION_TOKEN` in your client config, then that the token is still active at [app.notion.com/developers/tokens](https://app.notion.com/developers/tokens). Installed with `add-mcp` without `--env`? Re-run it with the flag.
- **`object_not_found` / "Could not find …":** an Internal Integration only sees pages Connected to it. Connect the page, or switch to a PAT.
- **"No parent page configured":** pass `parent` in the call, or set `NOTION_PAGE_ID`.
- **`multi_source_database`:** the database has several data sources. Call `list_data_sources`, then pass a `data_source_id` instead of the `database_id`.
- **A successful result carries `warnings`:** the call ran. Each entry names a field that was ignored or a property name that was corrected.
- **Tools don't appear in Claude Desktop:** a typo in the token (it must stay inside the quotes), or the app wasn't fully quit (`Cmd+Q`) before reopening.
- **Startup logs "Notion auth check failed" but tools work:** the startup check is best effort; ignore it if calls succeed.
- **Docker exits at once or says "NOTION_TOKEN is not set":** add `-i`, and write `-e NOTION_TOKEN` or `-e NOTION_TOKEN=ntn_xxx`, not `-e NOTION_TOKEN ntn_xxx`.

Still stuck? Check the [FAQ](./docs/faq.md) or open a [GitHub issue](https://github.com/awkoy/notion-mcp-server/issues).

## Privacy

The server runs on your machine or your own host and talks only to `api.notion.com`, over HTTPS, with the token you configure (or through your proxy when `HTTPS_PROXY` is set). No telemetry, no analytics, no server of ours in the path. The token stays where your MCP client keeps it. `get_image` fetches only the signed URLs Notion returns for files it hosts, and `upload_file` reads a local file only when asked to. Notion's own handling of your data is covered by [Notion's privacy policy](https://www.notion.com/privacy).

## Development

```bash
git clone https://github.com/awkoy/notion-mcp-server.git && cd notion-mcp-server
npm install && npm run build && npm test
```

Architecture, running a local build in a client, and the end-to-end test against a real workspace: [docs/development.md](./docs/development.md). PRs are welcome; run `npm test` before opening one.

## License

MIT — see [LICENSE](./LICENSE).

---

mcp-name: io.github.awkoy/notion-mcp-server
