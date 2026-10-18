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

`upload_file` takes its bytes as `base64`, a public `url`, or a local `path` that the server reads directly. A `path` source can read any file the server process can, so when a model composes the path, set `NOTION_UPLOAD_ROOT` to confine it. Relative paths resolve inside the root, and symlinks are resolved before the check so they can't point out of it. `mode: "multi"` sends a large file in 5 MB parts, and the MIME type is inferred from the file name when `content_type` isn't passed.

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

`HTTPS_PROXY` / `HTTP_PROXY` (lowercase also accepted) route all outbound traffic through an HTTP(S) proxy: Notion API calls, the downloads in `get_image`, and `upload_file`'s `url` source.

## Logs

Logs go to stderr and are also sent to the client as MCP `notifications/message` entries (logger `notion-mcp-server`). They show up in the client's own log view, such as VS Code's output channel, MCP Inspector or Claude Desktop's logs, where stderr is usually hidden.

- 2025-era clients pick the level with `logging/setLevel` (default `info`).
- MCP 2026-07-28 clients have no such call. They ask per request with the `io.modelcontextprotocol/logLevel` envelope key, so a request without it gets no log notifications.

Stderr is unaffected either way. At `debug` you also get one line per `notion_read` / `notion_write` call: operation, batch size, duration, ok or error. The payload and page content are never logged.
