# MCP Catalog submission

The server definition for the [Docker MCP Catalog](https://hub.docker.com/mcp), kept here so it
can be reviewed alongside the code it describes. `server.yaml` is a copy of
`servers/notion-mcp-awkoy/server.yaml` in [`docker/mcp-registry`](https://github.com/docker/mcp-registry),
in that repo's current format (`about:` block, pinned `source.commit`).

## Status

Submitted as [docker/mcp-registry#4227](https://github.com/docker/mcp-registry/pull/4227) from
`awkoy/mcp-registry:add-notion-mcp-awkoy`, slug `notion-mcp-awkoy`. Open and awaiting review since
2026-07-03: no review and no CI run yet.

That PR still describes 2.x: "43 operations … behind 2 context-efficient tools", the `NOTION_PAGE_ID`
parameter only, and `source.commit` pinned to `c855bd5` (three commits after v2.10.0). To bring it up
to v3.2.0:

1. Replace `servers/notion-mcp-awkoy/server.yaml` on the PR branch with this folder's `server.yaml`.
   It pins `cefd835f5afe7a29b418b944fb8dc4adb827470e`, the v3.2.0 release commit.
2. Edit the PR description to match: 47 operations behind three tools (`notion_read`, `notion_write`,
   `notion_describe`), and the optional settings listed under [Configuration](#configuration).
3. If a reviewer asks for test credentials, the registry takes them through the form linked in its
   CONTRIBUTING.md, never in the PR.

The `notion` slug is taken by the official server (`makenotion/notion-mcp-server`), which is why this
one is `notion-mcp-awkoy`.

## Configuration

| Docker parameter | Env var | Notes |
| --- | --- | --- |
| secret `notion-mcp-awkoy.notion_token` | `NOTION_TOKEN` | Required. A Personal Access Token (`ntn_...`) or an Internal Integration secret. |
| `notion_page_id` | `NOTION_PAGE_ID` | Default parent for `create_page` / `create_database`. |
| `read_only` | `NOTION_READ_ONLY` | Disables every write operation. |
| `allowed_operations` | `NOTION_ALLOWED_OPERATIONS` | Allowlist of operation names or groups. |
| `blocked_operations` | `NOTION_BLOCKED_OPERATIONS` | Blocklist, same vocabulary; wins over the allowlist. |
| `confirm_destructive` | `NOTION_CONFIRM_DESTRUCTIVE` | Asks before destructive operations. The Docker MCP gateway forwards elicitation to the client, so the client has to support it. |
| `upload_root` | `NOTION_UPLOAD_ROOT` | Confines `upload_file`'s `path` source. In the container this is a container path, since none of the host's files are mounted. |
| `file_urls` | `NOTION_FILE_URLS` | `ref` swaps signed file URLs for short `notion-file:` refs. |

Every parameter is optional, and an empty value behaves as if the variable were unset.

Not exposed in the catalog entry: `NOTION_RATE_LIMIT` (the default of 3 requests per second is Notion's
limit), `NOTION_DAILY_LOG_PAGE_ID` (used only by one MCP prompt), `HTTPS_PROXY` / `HTTP_PROXY`
(Docker has its own proxy settings), and the HTTP transport variables (`MCP_TRANSPORT`, `PORT`, `HOST`,
`MCP_AUTH_TOKEN`, `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS`), because the catalog runs the image over
stdio. The full list is in `notion-mcp-server --help` and the main README.

## Updating the entry

When a release should reach the catalog, edit `server.yaml` here first, then copy it to the
registry fork:

```bash
cp mcp-registry-submission/server.yaml ../mcp-registry/servers/notion-mcp-awkoy/server.yaml
```

- Set `source.commit` to the full 40-character SHA of the release commit. Docker builds the image from
  the `Dockerfile` at the repository root at that commit, so nothing else gets copied.
- `about.title` must not contain "MCP" or "Server", and every word except "and" / "for" starts with a
  capital letter.
- `env` values must reference parameters as `{{notion-mcp-awkoy.<param>}}`, and each one needs a matching
  entry under `config.parameters.properties`.
- The registry checks formatting with `npx prettier --check servers/notion-mcp-awkoy/server.yaml`, and
  runs the full validation with `go run ./cmd/validate --name notion-mcp-awkoy` from the registry checkout.
- The server lists its tools without a token, so the catalog build needs no `tools.json`.

After the entry is merged, the registry's nightly job opens PRs that bump `source.commit`, and Docker
builds the image as `mcp/notion-mcp-awkoy` for the Docker Desktop MCP Toolkit.
