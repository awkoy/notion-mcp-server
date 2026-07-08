# Running this fork (local changes)

This fork adds a **`path` source** to `upload_file` so the server reads local
files directly from disk instead of receiving them as base64 through the tool
call. See [PR #38](https://github.com/awkoy/notion-mcp-server/pull/38). Because
the change isn't on npm, you run the server from source instead of
`npx -y notion-mcp-server`.

Pick one of the setups below.

## Option A — local clone (recommended)

Fastest startup and easiest to update. Build once, point your client at the
compiled entrypoint.

```bash
git clone -b feat/local-path-source https://github.com/qch2012/notion-mcp-server.git
cd notion-mcp-server
npm install
npm run build      # compiles to build/index.js
```

Then register it with Claude Code — the `claude mcp add` CLI writes the entry
into `~/.claude.json` for you (everything after `--` is how to launch the
server):

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_your_token \
  -e NOTION_RATE_LIMIT=5 \
  -- node /absolute/path/to/notion-mcp-server/build/index.js
```

If a `notion` entry already exists, remove it first:
`claude mcp remove notion -s user`.

Or edit the config file by hand (Claude Code `~/.claude.json`, Claude Desktop
`claude_desktop_config.json`):

```jsonc
"notion": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/notion-mcp-server/build/index.js"],
  "env": {
    "NOTION_TOKEN": "ntn_your_token",
    "NOTION_RATE_LIMIT": "5"
  }
}
```

Reconnect the MCP server (in Claude Code: `/mcp reconnect`).

**To update:** `git pull && npm run build`, then reconnect.

## Option B — `npx` straight from the fork

No local checkout to maintain — npm clones the branch and runs the `prepare`
script (which builds) on install.

```bash
claude mcp add notion -s user \
  -e NOTION_TOKEN=ntn_your_token \
  -e NOTION_RATE_LIMIT=5 \
  -- npx -y github:qch2012/notion-mcp-server#feat/local-path-source
```

Or by hand:

```jsonc
"notion": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "github:qch2012/notion-mcp-server#feat/local-path-source"],
  "env": {
    "NOTION_TOKEN": "ntn_your_token",
    "NOTION_RATE_LIMIT": "5"
  }
}
```

Trade-offs: slower first launch (clone + install devDeps + `tsc`), and `npx`
caches aggressively — after new commits are pushed to the branch, clear the
cache to pick them up:

```bash
rm -rf ~/.npm/_npx      # or: npx clear-npx-cache
```

## Using the new `path` source

Once running, upload local files without base64 — the server reads the bytes
itself, so nothing routes through the model:

```jsonc
// minimal: filename derived from basename, content_type inferred from extension
{ "operation": "upload_file",
  "payload": { "source": { "type": "path", "path": "~/docs/spec.pdf" } } }
```

- `~` and `~/` expand to your home directory.
- `filename` is optional for a `path` source (defaults to the basename); it
  stays required for `base64`/`url`.
- `content_type` is inferred from the extension. The allowlist includes
  Markdown (`.md`) and Office formats (`.docx`, `.pptx`, `.xlsx`, …); pass
  `content_type` explicitly for anything outside it.
- Files over ~5 MB: pass `"mode": "multi"` for chunked multi-part upload.

The existing `base64` and `url` sources are unchanged.

## Notes

- `NOTION_RATE_LIMIT` (default `3`) sets request pacing; `5` speeds up bursts
  of calls, with the built-in backoff absorbing the occasional 429.
- Once PR #38 merges upstream and a release ships, you can switch back to
  `npx -y notion-mcp-server`.
