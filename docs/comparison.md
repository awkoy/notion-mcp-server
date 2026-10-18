# Notion MCP servers compared

There are three ways to connect an AI client to Notion over MCP. The short version is in the [README](../README.md#which-notion-mcp-should-you-use). This page has the detail. Facts about Notion's servers were checked in October 2026 and can change, so follow the links for the current state.

## Notion's hosted MCP (`mcp.notion.com`)

Notion's own remote server, documented in [Notion's MCP guide](https://developers.notion.com/guides/mcp/get-started-with-mcp).

- **Auth.** OAuth on every plan: a person signs in through the browser and clicks Authorize. Business and Enterprise workspaces can also use MCP tokens, bearer tokens that skip the browser, but only workspace owners can create them. Guests can't connect.
- **Tools.** The largest tool set of the three: pages, databases and views as markdown, plus features that sit on top of Notion AI, such as meeting notes, SQL queries across data sources and Custom Agent sessions. Several are limited to paid plans or need Notion AI.
- **Best for.** Interactive chat in claude.ai, ChatGPT and Cursor, and anything that needs Notion AI features.

## Notion's open-source server ([makenotion/notion-mcp-server](https://github.com/makenotion/notion-mcp-server))

Token-authenticated and runnable headless, but Notion calls it deprecated and "no longer actively maintained", and its repo says issues and PRs are not actively monitored. It exposes one tool per API endpoint.

## This server compared with the official open-source server

Both authenticate with a token and run locally, so this is the like-for-like comparison. Token numbers come from the [benchmark](../benchmarks), which reads the same objects through both servers.

| Capability | Official open-source server | **This server** |
| --- | --- | --- |
| **Tool surface** | 24 tools (one per endpoint), 17,163 tokens loaded into context | **3 tools**, 1,005 tokens: [94% less schema at connection](../benchmarks) |
| **Response size** | Full Notion envelope on every read | [**82% less** reading a page's blocks](../benchmarks#part-2--the-responses), 81% on a 25-row database query, 68% on a page object, 71% on a search |
| **Operations covered** | ~24 endpoints | **46 operations** (plus the `trash_page` and `get_self` aliases) across pages, blocks, databases, data sources, views, templates, comments, users, files |
| **Batch mutations** | Not documented | Universal `{ items: [...] }` envelope, up to **10 in parallel** |
| **Atomic batches + rollback** | Not documented | `atomic: true` stops on the first failure and archives what the batch already created, best effort |
| **Idempotency** | Not documented | `idempotency_key`: same key and operation return the cached result for 5 minutes |
| **Rate-limit handling** | 429s bubble up | Token-bucket limiter (3 req/s default) and exponential backoff that honors `Retry-After` |
| **Response shapes** | Raw Notion SDK JSON | **Slim shapers** drop noise by default. `verbose: true` returns the raw shape, within 4 tokens of what the official server returns. |
| **Database queries** | Raw `properties` bag per row | **Flattened** name → value map (all 20+ property types): 16,629 → 3,143 tokens on the benchmark's 25-row query |
| **Writing properties** | Full Notion property JSON | Plain values: `{ Status: "Done", Due: "2026-10-01", Tags: ["a"] }`, typed from the data source schema (cached 5 min). Wrong names and options are rejected with the valid ones. |
| **Filters** | Raw Notion filter JSON | Typed `where` shorthand: `{ Status: "Done", Priority: { in: [...] }, OR: [...] }` and `sorts: ["-Due Date"]`. Raw filters still work. |
| **Unknown fields** | Rejected | Ignored with a `warnings` entry naming the field and the accepted ones, so the call still runs |
| **Pagination** | Manual cursors | Opt-in `paginate: true` walks `next_cursor` (cap ≈ 1000 items) |
| **Search ranking** | Notion's order | Optional `ranking: "title_relevance"` re-ranks up to 100 candidates so exact and phrase title matches come first, with accents optional |
| **Markdown** | Page-level markdown tools | Accepted by `create_page`, `append_blocks`, `update_block` and comments, plus a full round trip (`get_page_markdown` / `update_page_markdown`), GFM included |
| **Templates** | — | `create_page` from a Notion template, with `list_data_source_templates` to find them |
| **Database views** | — | List, get, query, create, update, delete. `query_view` runs a view's stored filters and sorts and returns hydrated rows. |
| **File uploads** | Not in the documented tool surface | Single- and multi-part (5 MB parts), MIME type inferred |
| **Validation errors** | Plain error string | `{ code, message, path, issues, schema, example, fix }`, usually corrected in one round trip |
| **Notion API version** | — | Pinned `2026-03-11` (data sources, views, templates) |

What that buys you in practice: renaming 50 pages is one `notion_write` call with `{ items: [...], concurrency: 10 }`, not 50 trips through the agent's reasoning loop, and the prompt tokens saved are the bigger half of the win. The [benchmark](../benchmarks) has the method, the tokenizer, the control that validates it, an honest worst case, and the limits of its own sample.
