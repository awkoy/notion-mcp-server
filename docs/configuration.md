# Configuration in depth

The [README](../README.md#configuration) covers the token and the environment variables. This page has the details behind the access controls, file handling and logs.

## Restricting operations

`NOTION_ALLOWED_OPERATIONS` (allowlist) and `NOTION_BLOCKED_OPERATIONS` (blocklist) each take a comma-separated list of group presets or exact operation names. `NOTION_READ_ONLY=true` is the same as `NOTION_BLOCKED_OPERATIONS=write` and composes with both lists.

| Preset | Expands to |
| --- | --- |
| `read` | every non-mutating operation |
| `write` | every mutating operation |
| `destructive` | operations whose purpose is removal (marked † below) |
| `pages` `blocks` `databases` `data_sources` `views` `comments` `users` `files` | every operation in that family, read **and** write |

Rules:

- Names are case-insensitive. Unknown tokens are ignored with a warning.
- The blocklist is applied after the allowlist, so a name in both is blocked.
- An allowlist that resolves to zero operations disables everything (fail-closed).
- Disabled operations vanish from the tools' `operation` enums, from `notion_describe` and from the `notion://operations` menu, so naming one fails validation before it runs. When no write operation is enabled, `notion_write` is not advertised at all.
- One line on stderr at startup says what resolved. Check it first when the config doesn't behave:

```text
Operation access: 22/48 enabled (allow=read; block=(none))
```

### Per-operation reference

| Family | Read | Write |
| --- | --- | --- |
| `pages` | `search_pages` `get_page` `get_page_markdown` | `create_page` `set_page_title` `set_page_property` `set_page_properties` `update_page_markdown` `move_page` `restore_page` `archive_page`† `trash_page`† |
| `blocks` | `get_block` `get_block_children` | `append_blocks` `update_block` `delete_block`† `batch_mixed_blocks`† |
| `databases` | `query_database` | `create_database` `update_database` `delete_database`† |
| `data_sources` | `list_data_sources` `get_data_source` `list_data_source_templates` | `update_data_source` `delete_data_source`† |
| `views` | `list_views` `get_view` `query_view` | `create_view` `update_view` `delete_view`† |
| `comments` | `list_comments` `get_comment` | `add_page_comment` `add_discussion_comment` `update_comment` `delete_comment`† |
| `users` | `list_users` `get_user` `get_bot_user` `get_self` | — |
| `files` | `list_file_uploads` `get_file_upload` `get_file_url` `get_image` | `upload_file` |

† = also in the `destructive` group. `trash_page` is an alias of `archive_page`.

**Limitations.** Control is per operation, not per parameter. `update_page_markdown` is a write operation that can replace a page's whole body, and blocking `destructive` does not disable it. For a guaranteed no-mutation deployment use `NOTION_ALLOWED_OPERATIONS=read` or `NOTION_READ_ONLY=true`. MCP prompts may still mention disabled operations, but running them is rejected.

## Confirming destructive operations

`NOTION_CONFIRM_DESTRUCTIVE=true` keeps destructive operations available and makes `notion_write` ask you before running one, through [MCP elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation). You get a yes/no dialog naming the operation and its target: the page, database, data source or block title when one retrieve can fetch it within 5 seconds, otherwise the id, and for a batch, how many items.

How the question reaches the client depends on the protocol revision it speaks:

- **2025-era clients** get an `elicitation/create` request.
- **MCP 2026-07-28 clients** get an `input_required` result. The retry carries a sealed `requestState` that only matches the call it was minted for, so an answer can't be replayed onto a different call.

What never prompts: restores (`restore_page`, and `delete_database` / `delete_data_source` with `in_trash: false`) and a `batch_mixed_blocks` call with no `delete` entry. A blocked operation is rejected with `operation_not_allowed` before anyone is asked.

What the model sees:

| Outcome | Result |
| --- | --- |
| You decline, cancel or answer no | `confirmation_declined`. The server instructions tell the model not to retry and to ask you instead. |
| The client hasn't declared the elicitation capability | `confirmation_unavailable`, rather than a silent run. Use a client that supports elicitation, unset the variable, or block destructive operations outright. |

## Files

### Uploads

`upload_file` takes its bytes as `base64`, a public `url`, or a local `path` that the server reads directly. The model composes the source, so the server guards the two it reads itself.

| Env var | Default | Effect |
| --- | --- | --- |
| `NOTION_UPLOAD_ROOT` | — | Directory a `path` source is confined to. `/` turns confinement off. |
| `NOTION_UPLOAD_MAX_BYTES` | `1073741824` (1 GiB) | Largest file accepted from any source. |
| `NOTION_UPLOAD_URL_TIMEOUT_MS` | `30000` | Time limit for a `url` source: DNS, every redirect and the body. |
| `NOTION_UPLOAD_ALLOW_PRIVATE_URLS` | — | `true` (or `1`, `yes`, `on`) lets a `url` source reach private addresses. |

**Paths.** With `NOTION_UPLOAD_ROOT` set, relative paths resolve inside the root and anything landing outside is refused with `path_not_allowed`. Symlinks are resolved before the check, so a link inside the root can't point out of it. Inside the root nothing is filtered: dotfiles such as `.env` and `.git` upload like any other file. Over HTTP that makes the root everything a caller can read, so pick a directory that holds only files you would hand them. Without a root:

- Over the HTTP transport, path sources are refused. The caller may not be on the server's machine, and could otherwise read any file the server can.
- Over stdio, a path whose real location goes through a dot-named file or directory (`~/.ssh`, `~/.aws`, `.env`, `.git`) is refused, and so is one under a system or app-data folder:
  - `/proc`, `/sys` and `/dev` (`/proc/self/environ` holds the server's own environment, `NOTION_TOKEN` included), `/run/secrets` and `/var/run/secrets`;
  - on macOS, `~/Library`, where Claude Desktop, Cursor, Windsurf and VS Code keep their MCP config, except iCloud Drive (`~/Library/Mobile Documents`) and `~/Library/CloudStorage`;
  - on Windows, `~\AppData`, `%APPDATA%` and `%LOCALAPPDATA%`;
  - `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME` when they are set.

  This is a heuristic that catches the usual credential stores, not a sandbox: set a root to be sure, or `NOTION_UPLOAD_ROOT=/` to turn it off.

The server stats the file before reading it and refuses anything that isn't a regular file (a directory, `/dev/zero`, a FIFO) or is over the size limit. It opens the file without following a symlink and checks that the open file is the one it stat'ed, so a file swapped in between is refused.

**URLs.** Only `http` and `https`. Before each request the server resolves the host and refuses it unless every address it gets back is public: loopback, private ranges, carrier-grade NAT, link-local (cloud metadata at `169.254.169.254` and `fd00:ec2::254`), multicast and reserved ranges are all out, as are IPv6 forms that carry one of those IPv4 addresses. The connection is pinned to the addresses it checked, so DNS can't answer differently a moment later. Redirects are followed by hand, at most five, and each hop is checked the same way. The body is streamed and the fetch stops when it passes the size limit or the timeout. Behind `HTTPS_PROXY` the proxy makes the connection, so the server checks its own DNS answer and the proxy's resolution is up to the proxy. The server still has to resolve the name itself: where only the proxy can, URL sources fail with `fetch_failed` unless `NOTION_UPLOAD_ALLOW_PRIVATE_URLS=true`, which skips the check and the lookup. Set `NOTION_UPLOAD_ALLOW_PRIVATE_URLS=true` when uploads legitimately come from an intranet host.

**Size and mode.** Notion takes a file in one request up to 20 MiB and in 5 to 20 MiB parts above that. Omit `mode` and the size picks it; `mode: "single"` on a file over 20 MiB is refused with `too_large`. Notion's own limit per file is 5 MiB on free workspaces and 5 GiB on paid ones. The server holds the whole file in memory while it uploads, about twice its size at the peak, so keep `NOTION_UPLOAD_MAX_BYTES` within what the host can spare.

**Content type.** It is inferred from the file name when `content_type` isn't passed. An extension the server doesn't know is sent as `application/octet-stream`, and Notion works out the type from the file name. A file name with no extension needs an explicit `content_type`. CAD and 3D files (`dwg`, `dxf`, `step`, `stl`, `obj`, `glb`, …) attach as file blocks.

**Error codes.** `path_not_allowed` (outside the root, a dot-named path or a system or app-data folder, or any path over HTTP without a root), `validation_error` (a path that doesn't exist or can't be read, or isn't a regular file), `url_refused` (a scheme other than http(s), or a host that resolves to a non-public address), `too_large`, `timeout`, and `fetch_failed` (DNS failure, a non-2xx answer, too many redirects).

### File URLs and `notion-file:` refs

Notion mints a fresh signed S3 URL for every hosted file on every read: about 1,650 characters (~500 tokens), valid for an hour, different each time, and easy for a small model to mangle. `NOTION_FILE_URLS=ref` replaces them in slim responses (`get_page`, `search_pages`, `query_database`, `query_view`, `get_block`, `get_block_children`, …) with short, stable refs.

| Ref | Names | Resolved by |
| --- | --- | --- |
| `notion-file:block/<block-id>` | The file in an image block | `get_file_url` → `{ ref, url }`, a fresh signed URL good for about an hour |
| `notion-file:page/<page-id>/<property>/<index>` | One entry of a page's `files` property (property name URL-encoded) | `get_image` → the image as MCP image content, so the model can look at it (`image/*` only, up to 5 MB) |

Both resolvers re-read the object through the Notion API, so a ref stays valid as long as the file does. The default, `full`, leaves every response as it was. `get_page_markdown` is Notion's own rendered markdown and is never rewritten.

### Why `get_image` can't be pointed at arbitrary URLs

`get_image` fetches only the URL Notion returned for a Notion-hosted file, never one supplied by the caller. A model can't steer it at a LAN host, a cloud metadata endpoint or an exfiltration target. External URLs (linked images, `external` files) are short and stable already: they pass through untouched in either mode, and `get_image` returns them as text rather than fetching them.

## Proxy

`HTTPS_PROXY` / `HTTP_PROXY` (lowercase also accepted) route all outbound traffic through an HTTP(S) proxy: Notion API calls, the downloads in `get_image`, and `upload_file`'s `url` source. For the `url` source the private-address check runs on the server's own DNS answer, since the proxy opens the connection. So the server must be able to resolve names itself; on a network where only the proxy can, set `NOTION_UPLOAD_ALLOW_PRIVATE_URLS=true` to skip the check, or URL uploads fail with `fetch_failed`.

## Logs

Logs go to stderr and are also sent to the client as MCP `notifications/message` entries (logger `notion-mcp-server`). They show up in the client's own log view, such as VS Code's output channel, MCP Inspector or Claude Desktop's logs, where stderr is usually hidden.

- 2025-era clients pick the level with `logging/setLevel` (default `info`).
- MCP 2026-07-28 clients have no such call. They ask per request with the `io.modelcontextprotocol/logLevel` envelope key, so a request without it gets no log notifications.

Stderr is unaffected either way. At `debug` you also get one line per `notion_read` / `notion_write` call: operation, batch size, duration, ok or error. The payload and page content are never logged.
