---
name: notion-workflow
description: Use when the user wants to find, read, summarise, create or change something in Notion — a page, doc, note, wiki, task list or database row — or pastes a notion.so link. Covers which notion_read / notion_write operation to pick, filtering a database with `where`, turning many edits into one batched call, and when notion_describe is worth a round-trip.
---

# Working with Notion through notion-mcp-server

The server exposes three tools. `notion_read` runs read operations, `notion_write` runs write operations, and `notion_describe` returns one operation's JSON Schema with a working example. Each call is `{ operation, payload }`. The `operation` enum on each tool is the full menu of what is enabled. In read-only mode `notion_write` isn't listed at all; say that edits are turned off rather than offering them.

Most tasks follow the same path: find the thing, read it, then change it in as few calls as possible.

## 1. Find it

- **The user pasted a link:** skip the search. Every id field (`page_id`, `database_id`, `block_id`, `view_id`, …) accepts a Notion URL as it is.
- **The user named something:** `notion_read` → `search_pages` with `{ query: "<words from the title>" }`. The search matches titles only, never body text. Each result carries `object` (`page`, `database` or `data_source`), `id`, `title` and `url`. A database id is not a valid parent for `create_page`; a row's parent is a data source.
- **A loose match** (accents, word order): add `ranking: "title_relevance"` to re-rank by title similarity.
- **Nothing found:** with an Internal Integration token, the page may not be shared with the integration. Say so instead of guessing.

## 2. Read it

| Need | Operation | Payload |
| --- | --- | --- |
| A page's prose, to summarise or edit | `get_page_markdown` | `{ page_id }` |
| A database row's fields | `get_page` | `{ page_id, include_properties: true }` |
| Block ids, to edit one block | `get_block_children` | `{ block_id }` |
| A database's columns and options | `get_data_source` | `{ data_source_id }` |

Prefer `get_page_markdown` to walking blocks. One call returns the body, and it round-trips with `update_page_markdown`. When it returns `truncated: true` or `unknown_block_ids`, the markdown is missing blocks: don't replace the page with `update_page_markdown`, which would delete them. Edit with `insert_content`, `append_blocks` or `update_block` instead.

## 3. Query a database with `where`

`notion_read` → `query_database`. Pass `database_id` (a single-source database resolves itself) or `data_source_id`. Filter with `where` instead of raw Notion filter JSON:

```json
{
  "database_id": "<id or URL>",
  "where": {
    "Status": "In progress",
    "Priority": { "in": ["High", "Urgent"] },
    "Due": { "before": "2026-11-01" },
    "Assignee": { "is_not_empty": true }
  },
  "sorts": ["-Due"]
}
```

- Keys at one level are ANDed together. Use `OR: [ {...}, {...} ]`, `AND: [...]` or `NOT: {...}` to compose them.
- A plain value means equals, and `null` means empty. The operators are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `contains`, `notContains`, `startsWith`, `endsWith`, `in`, `notIn`, `is_empty`, `is_not_empty`, `before`, `after`, `on_or_before` and `on_or_after`.
- Property types come from the database schema, so `status`, `select` and dates work without type hints.
- Rows come back as flat `name → value` maps, so there's no need to dig through Notion's property objects.
- One page holds at most 100 rows. For "all of them", pass `paginate: true` (with an optional `page_limit`).
- A `multi_source_database` error means the database has several data sources. Call `list_data_sources`, then query by `data_source_id`.

Filter on the server with `where` rather than fetching every row and filtering it yourself.

## 4. Write

- **A new page with prose:** `create_page` with `parent`, `title` and `markdown`. The markdown is GFM, so headings, lists, `- [ ]` checkboxes, tables and code blocks all work. Use raw `children` blocks only for what markdown can't express.
- **A new database row:** `create_page` with `parent: { type: "data_source_id", data_source_id }` and plain `properties` such as `{ "Status": "Done", "Due": "2026-10-01", "Tags": ["q3"] }`. A wrong property name or option is rejected, and the error lists the valid ones.
- **Changing row fields:** `set_page_properties` with `{ page_id, properties }`.
- **Adding to a page:** `append_blocks` with `{ block_id: <page id>, markdown }`.
- **Rewriting a page:** `get_page_markdown`, edit the text, then `update_page_markdown`. Replacing the body deletes the blocks that aren't kept and needs `allow_deleting_content: true`, so show the user what will go first. To add without removing anything, pass `insert_content: { position: "end" }`.

## 5. Batch repeated writes into one call

When the same write applies to more than one item (rename 30 pages, tick off 12 rows, add five comments), send one `notion_write` call with `items`. Don't loop over single calls:

```json
{
  "operation": "set_page_properties",
  "payload": {
    "items": [
      { "page_id": "<row-1>", "properties": { "Status": "Done" } },
      { "page_id": "<row-2>", "properties": { "Status": "Done" } }
    ],
    "concurrency": 5,
    "idempotency_key": "close-sprint-42"
  }
}
```

- The result has one entry per item. Report the items that failed; don't assume the whole batch worked.
- `atomic: true` stops at the first failure and archives what the batch already created. Use it when a half-finished result would be worse than none.
- `idempotency_key` makes a retry safe: the same batch under the same key returns the cached result for five minutes instead of writing twice. Use a new key for a different batch; reusing one fails with `idempotency_conflict`.
- `concurrency` defaults to 3 and goes up to 10. Atomic batches always run one item at a time. The server rate-limits and retries on its own.

## 6. When to call notion_describe

Usually you don't need to. A payload that fails validation comes back with `code`, `message`, `fix` and the part of the schema you got wrong. Correct it and retry.

Call `notion_describe` first only for shapes that are hard to get right blind:

- property definitions in `create_database` or `update_data_source`
- `batch_mixed_blocks` and raw `children` block trees
- a raw `filter` that `where` can't express
- `create_view` and `update_view`

A successful result can carry `warnings` that name fields the server ignored. Fix them on the next call; nothing needs retrying.

## 7. Confirm before anything permanent

`archive_page` (alias `trash_page`), `delete_block`, `delete_database`, `delete_data_source`, `delete_view`, `delete_comment`, and `update_page_markdown` used to replace a body can't be undone through the API. Say what will be removed and wait for the user's yes. If a call fails with `confirmation_declined`, the user said no: don't retry it, ask what they want instead.
