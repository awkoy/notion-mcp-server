# Tools, calls and resources

The [README](../README.md#tools-and-operations) lists the 46 operations. This page shows what a call looks like on the wire, which is mostly useful when you're debugging an agent or writing your own client. Models learn all of this from the tool schemas, so you don't need to teach it to them.

## Three tools

| Tool | Runs | Annotation |
| --- | --- | --- |
| `notion_read` | Every read: `get_*`, `list_*`, `search_pages`, `query_database`, `query_view` | `readOnlyHint: true` |
| `notion_write` | Every mutation | `destructiveHint: true` |
| `notion_describe` | Returns one operation's JSON Schema plus a working example | `readOnlyHint: true` |

Each tool's `operation` field is an enum of exactly what this server has enabled. The menu ships with the tool list, a client can validate a call before sending it, and a name sent to the wrong tool fails in one round trip with a message naming the right one. `notion_describe` is worth a round trip before a complex call: filter expressions, mixed block batches, database property definitions.

Why the server exposes a few tools instead of one per endpoint: [MCP Tool Design for AI Agents, Not API Endpoints](https://yaroslavboiko.com/blog/mcp-tool-surface/).

## Ids and URLs

Every id field (`page_id`, `block_id`, `database_id`, `view_id`, …) also accepts a Notion URL, so paste what **Share → Copy link** gives you. A block link's `#fragment` is used for `block_id` fields, and a database link's `?v=` for `view_id` fields.

## Example calls

```jsonc
// notion_read
{ "operation": "search_pages", "payload": { "query": "Q3 plan" } }
{ "operation": "get_page_markdown", "payload": { "page_id": "https://www.notion.so/Q3-plan-1f3c…" } }

// notion_write, single call
{ "operation": "set_page_title", "payload": { "page_id": "<page-id>", "title": "Q3 plan" } }

// notion_write, batch: every mutating op takes { items: [...], atomic?, concurrency?, idempotency_key? }
{
  "operation": "set_page_title",
  "payload": {
    "items": [{ "page_id": "<p1>", "title": "First" }, { "page_id": "<p2>", "title": "Second" }],
    "concurrency": 3,
    "idempotency_key": "rename-pass-2026-07-02"
  }
}

// markdown shortcut (create_page, append_blocks, update_block, update_page_markdown)
{
  "operation": "create_page",
  "payload": {
    "parent": { "type": "page_id", "page_id": "<parent>" },
    "title": "Notes",
    "markdown": "# Heading\n\n- [ ] todo\n- [x] done\n\n```ts\nconst x = 1;\n```"
  }
}

// a database row: plain property values, typed from the data source's schema
{
  "operation": "create_page",
  "payload": {
    "parent": { "type": "data_source_id", "data_source_id": "<data-source-id>" },
    "title": "Write the report",
    "properties": { "Status": "In Progress", "Due Date": "2026-10-01", "Tags": ["q3", "docs"] }
  }
}

// upload a file and place it on a page in one call
{
  "operation": "upload_file",
  "payload": {
    "source": { "type": "path", "path": "~/Desktop/chart.png" },
    "attach_to": { "block_id": "<page-or-block-id>", "caption": "Q3 revenue" }
  }
}
```

## Batches

Every mutating operation accepts `{ items: [...] }` and returns a result per item.

- `concurrency` runs up to 10 items in parallel (default 3).
- `atomic: true` stops at the first failure and archives what the batch already created, best effort.
- `idempotency_key` makes a retry safe. For 5 minutes the key stays bound to the operation, the items and `atomic`; `concurrency` can change.
  - The same batch again gets the first result back, marked `idempotency_receipt: { decision: "deduplicated" }`, and nothing runs twice.
  - A different batch under the same key fails with `idempotency_conflict`.
  - A retry while the first call is still running fails with `idempotency_in_progress`.
  - A batch in which no item passed validation is not kept, so the corrected batch can reuse the key.

## Errors and warnings

A payload that doesn't validate comes back with `{ code, message, path, issues, schema, example, fix }`: the operation's JSON Schema, a working example and a hint, so the next call can be corrected without a `notion_describe` round trip.

A successful result can carry `warnings`. Each entry names a field that was ignored (misspelt or misplaced) along with the accepted ones, or a property name that was corrected. The call still ran.

## MCP resources

Clients that support resource attachment (`@`-mention) can pull Notion content into context without a tool call. Dynamic resources go through the same auth, rate limiting and access controls as tool calls.

| Resource URI | Returns |
| --- | --- |
| `notion://operations` | Markdown cheat sheet of every enabled operation, with batchability and the tool that runs it |
| `notion://page/<page_id>` | Page body as markdown |
| `notion://database/<data_source_id>` | Data source schema as JSON |
