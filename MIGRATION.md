# Upgrading from v2.3 → v2.4

v2.4 is a focused fix-up of the rough edges discovered while live-testing v2.3 against real Notion workspaces as an LLM caller. The tool surface (`notion_execute`, `notion_describe`) is unchanged. One breaking field rename, several "less typing, fewer round-trips" wins, and dramatically smaller validation envelopes.

## Breaking changes

### `upload_file` source discriminator renamed `kind` → `type`

Every other discriminated union in this API uses `type` as the discriminator (`parent.type`, `icon.type`, `block.type`, `property value.type`, …). `upload_file` was the lone exception; it's been brought in line.

```jsonc
// Before (v2.3)
{ "operation": "upload_file",
  "payload": { "filename": "x.pdf", "content_type": "application/pdf",
               "source": { "kind": "base64", "data": "..." } } }

// After (v2.4)
{ "operation": "upload_file",
  "payload": { "filename": "x.pdf", "content_type": "application/pdf",
               "source": { "type": "base64", "data": "..." } } }
```

The old `kind` field is now rejected at the schema layer (clear validation_error envelope).

## Added

### `get_self` alias for `get_bot_user`

LLMs reach for `get_self` reflexively when probing identity. Both names now resolve to the same handler — no change needed, but `get_self` calls no longer fail with `unknown_operation`.

### `include_properties` on `get_page`

Defaults to `false`. Pass `true` to receive the flattened `properties` map (same shape `query_database` emits per row) alongside the page metadata.

```jsonc
{ "operation": "get_page",
  "payload": { "page_id": "...", "include_properties": true } }
```

## Quality-of-life changes (non-breaking)

### Validation error envelopes are now path-sliced

Instead of dumping the full operation schema (5–13KB on `set_page_property`, `update_database`, `query_database`), the envelope slices the schema down to the failing field and summarizes any large unions into one-line-per-branch discriminator tags. Typical envelopes shrink from ~10KB to <1KB. The full schema is still one `notion_describe` call away.

### `set_page_property` / `set_page_properties` accept a plain string for the title

When `name === "title"` (singular) or `properties.title` (plural) is a string, the server wraps it into Notion's `{title:[{type:"text",text:{content}}]}` shape before validation.

```jsonc
// Both shapes now work:
{ "operation": "set_page_property",
  "payload": { "page_id": "...", "name": "title", "value": "My new title" } }

{ "operation": "set_page_properties",
  "payload": { "page_id": "...", "properties": { "title": "My new title" } } }
```

### `update_block` infers block type from `data`

When `data` contains exactly one recognized block-type key (e.g. `{ paragraph: {...} }`), the server fills in the `type` discriminator automatically. The old explicit shape continues to work.

```jsonc
// New, inferred:
{ "operation": "update_block",
  "payload": { "block_id": "...", "data": { "paragraph": { "rich_text": [...] } } } }

// Still valid (explicit form):
{ "operation": "update_block",
  "payload": { "block_id": "...",
               "data": { "type": "paragraph",
                         "paragraph": { "rich_text": [...] } } } }
```

### `upload_file` mode defaults to `"single"`

No need to pass `mode` for files <5MB; only specify `"multi"` for larger files.

### `batch_mixed_blocks` returns `wrong_envelope` instead of `not_batchable`

Calling `batch_mixed_blocks` with the universal `{ items: [...] }` envelope used to surface the generic `not_batchable` error. It now returns `wrong_envelope` with a fix that points at the correct `{ operations: [...] }` shape.

## Call sites to audit

- [ ] Rename `upload_file` `source.kind` → `source.type` everywhere.
- [ ] Drop the explicit `mode: "single"` on small `upload_file` calls (still accepted, just unnecessary).
- [ ] Optional: replace `set_page_property` rich-text title payloads with the string shorthand for readability.
- [ ] Optional: replace `update_block`'s redundant `type` field with the inferred form.

---

# Upgrading from v2.2 → v2.3

v2.3 is a follow-up token / clarity pass after live-testing every operation as an LLM caller. Tool surface (`notion_execute`, `notion_describe`) and operation names are unchanged. A handful of slim shapes and one field name are tightened; the WHERE DSL accepts more keyword cases. Pass `verbose: true` to fall back to v2.2-equivalent shapes for the slim changes.

## What changed

### `move_page` field renamed

`new_parent` → `parent`, matching `create_page`'s parent field. Drop-in: rename your payload key.

```jsonc
// Before
{ "operation": "move_page", "payload": { "page_id": "...", "new_parent": { "type": "page_id", "page_id": "..." } } }
// After
{ "operation": "move_page", "payload": { "page_id": "...", "parent":     { "type": "page_id", "page_id": "..." } } }
```

### `get_data_source` returns a typed property map

Previously `properties` was a name-only array (`["Name", "Status"]`). Now it's a `{ name: type }` map (`{ Name: "title", Status: "status" }`). Same wire size; you no longer need `verbose: true` to plan a `query_database` payload.

### `query_database` hoists `parent` to the list level

Slim default — every row in a `query_database` response shares the same parent (single data source), so the parent is now emitted once at the list level and removed from each row. On a 100-row page that's ≈8KB saved. Verbose responses keep per-row parents.

```jsonc
// Slim shape (v2.3)
{ "parent": { "type": "data_source_id", "data_source_id": "..." },
  "results": [{ "id": "...", "title": "...", "properties": {...} }, ...] }
```

### `slimUser` / `slimComment` clean-ups

- `avatar_url` is only emitted when non-null (no more `"avatar_url": null` lines).
- Bot users only carry `workspace_name` when set.
- Comments drop `created_time` from the slim shape (other ops already did in v2.2). Use `verbose: true` if you need it.

### WHERE DSL keywords are case-insensitive

`and`/`or`/`not` (canonical) and `AND`/`OR`/`NOT` (SQL-style) both work. If you have a property literally named `and`/`or`/`not`, wrap it as an operator object with `__type` to keep it from being parsed as a combinator.

### `unique_id` prefix validated locally

Notion rejects single-letter prefixes with a generic 400; we now reject `prefix` values that aren't 2–10 chars, letter-prefixed, alphanumeric + hyphen with a precise schema error instead.

### `upload_file` description spells out source shapes

No behavior change — the description now lists the two `source` variants (`{ kind: "base64", data: "<b64>" }` and `{ kind: "url", url: "..." }`) so a planner doesn't need to call `notion_describe` first.

## Call sites to audit

- [ ] Rename `move_page` `new_parent` → `parent`.
- [ ] If you read `get_data_source.properties[i]` as a string, switch to `Object.keys(properties)` (or read the type via the value).
- [ ] If you read `parent` off each `query_database` row, read it from the list level instead (or pass `verbose: true`).
- [ ] If you depended on `slimComment.created_time` or `slimUser.avatar_url: null`, pass `verbose: true`.

---

# Upgrading from v2.1 → v2.2

v2.2 is a **shape-only** revision of the slim response shapers. Tool surface (`notion_execute`, `notion_describe`) and operation names are unchanged. The goal is to cut token bloat on default reads. Pass `verbose: true` anywhere you depended on the v2.1 raw fields — that gives you the full Notion SDK response.

## What changed

### Slim defaults are tighter

| Op family | Removed by default | Kept |
| --- | --- | --- |
| **Pages** (`get_page`, `query_database`, batch reads) | `archived`, `created_time`, `last_edited_time`, `in_trash: false` | `id`, `url`, `title`, `parent`, `icon` (type only), `in_trash: true` (only when trashed) |
| **Databases** (`get_database`, search) | `in_trash: false`, `is_inline: false`, `is_locked: false`, empty `description` | `id`, `url`, `title`, `description` (only when non-empty), `parent`, `data_sources`, `icon`, the three trash/inline/locked booleans when **true** |
| **Blocks** (`get_block`, `get_block_children`, …) | `has_children: false`, `in_trash: false`, timestamps | `id`, `type`, `text`, `has_children: true` (only when true), type-specific extras (`checked` for to-do, `language` for code, `image` URL) |
| **Data sources** (`get_data_source`, `list_data_sources`) | empty `description`, top-level `count` on lists | `id`, `url`, `title`, `parent`, `properties`, `icon` |

### `query_database` now flattens row properties

Previously each row's `properties` was the raw Notion bag (huge nested objects). Now slim rows include a `properties` map of name → primitive (or small object) covering `title`, `rich_text`, `number`, `select`, `multi_select`, `status`, `date`, `people`, `files`, `checkbox`, `url`, `email`, `phone_number`, `formula`, `relation`, `rollup`, `created_time`, `last_edited_time`, `created_by`, `last_edited_by`, `unique_id`, `verification`. Title is already surfaced as the top-level `title` and is omitted from the map.

Empty / `null` values are dropped. If every property is empty, the `properties` field is omitted entirely.

### `append_blocks` returns IDs only

Slim default response is `{ appended, ids }` instead of the full slim block array. Pass `verbose: true` if you need the appended blocks back. The same applies to the `append` branch inside `batch_mixed_blocks`.

### Wire format

`notion_execute` / `notion_describe` now serialize JSON without indentation. Roughly 30% smaller; identical to parse.

### `archived` is no longer back-filled

v2.1 surfaced both `archived` and `in_trash` for forward-compat. v2.2 only emits `in_trash`, and only when it's `true`. If you still read `archived`, switch to `in_trash`, or pass `verbose: true` to get the raw SDK response (which carries `archived`).

## Call sites to audit

- [ ] If you read `archived`, `created_time`, `last_edited_time`, `has_children`, or `is_inline`/`is_locked` from slim responses, either switch to the new names / behavior, or add `verbose: true`.
- [ ] If you read `query_database` row `properties` expecting the raw Notion bag, switch to the flattened map (or pass `verbose: true`).
- [ ] If you parse `append_blocks` slim output expecting the full block array, switch to `ids` (or pass `verbose: true`).
- [ ] If you depend on JSON indentation in tool responses, parse the result — it's still valid JSON.

---

# Upgrading from v2.0 → v2.1

v2.1 is **additive** at the MCP tool layer — the two-tool surface (`notion_execute`, `notion_describe`) is unchanged. The server now talks to `@notionhq/client@5.x` with `Notion-Version: 2025-09-03`, which exposes data sources, new block / property types, and a handful of new endpoints. New operations were added; existing ones still work.

The only semi-breaking call-site change: `query_database` now routes through `dataSources.query`. Single-source databases continue to work transparently when you pass `database_id`. Multi-source databases require `data_source_id` (the server returns a clear self-healing error pointing to `list_data_sources` if you pass a multi-source database_id).

## What's new

1. **API version bump** — server pins `Notion-Version: 2025-09-03`.
2. **`query_database` accepts `data_source_id`** — pass either `database_id` (auto-resolves single-source databases) or `data_source_id` (required for multi-source). Multi-source ambiguity returns a `multi_source_database` error envelope with the available source IDs.
3. **New ops** — `move_page`, `get_page_markdown`, `update_page_markdown`, `list_data_sources`, `get_data_source`, `update_data_source`, `get_comment`, `update_comment`, `delete_comment`.
4. **New parent types** — `data_source_id`, `workspace`, `block_id` are valid `parent` values on `create_page`.
5. **New block types** — `heading_4`, `tab` accepted in markdown (`####` parses to `heading_4`) and structured input.
6. **New property types** — `button`, `unique_id`, `verification` available in database schemas. `verification` is writable on pages.
7. **Markdown comments** — `add_page_comment`, `add_discussion_comment`, and `update_comment` accept `markdown` as an alternative to plain text / rich text.
8. **`position` param** on `append_blocks` (preferred over legacy `after`).

## Call sites to audit

- [ ] If you call `query_database` against a database that has multiple data sources, switch to `data_source_id` (use `list_data_sources` to discover them).
- [ ] If you call `add_page_comment` or `add_discussion_comment` with `text`, no change needed. If you'd rather pass formatted bodies, use the new `markdown` field.

---

# Migrating from notion-mcp-server v1.x → v2.0.0

v2 is a **hard cutover**. The five `notion_*` tools are gone; everything now goes through `notion_execute` (do something) and `notion_describe` (learn its schema). If your client code talks to specific tool names, it needs the rename below.

If you're running an LLM that calls tools by JSON schema discovery (Claude Code, Cursor, Claude Desktop, etc.), the model will pick up the new surface automatically the next time it starts a session — no manual prompt update is needed.

---

## What stayed the same

- The MCP transport (stdio).
- The install paths (PAT, internal integration, Docker, Smithery).
- `NOTION_TOKEN` and `NOTION_PAGE_ID` env vars.
- The set of Notion capabilities you can call — every action available in v1 is still available, just under a slightly cleaner name.

## What changed

### Tools

| v1 tool             | v2                  |
| ------------------- | ------------------- |
| `notion_pages`      | `notion_execute` with `operation: "create_page"` / `"get_page"` / `"set_page_title"` / `"set_page_property"` / `"set_page_properties"` / `"archive_page"` / `"restore_page"` / `"search_pages"` |
| `notion_blocks`     | `notion_execute` with `operation: "append_blocks"` / `"get_block"` / `"get_block_children"` / `"update_block"` / `"delete_block"` / `"batch_mixed_blocks"` |
| `notion_database`   | `notion_execute` with `operation: "create_database"` / `"query_database"` / `"update_database"` |
| `notion_comments`   | `notion_execute` with `operation: "list_comments"` / `"add_page_comment"` / `"add_discussion_comment"` |
| `notion_users`      | `notion_execute` with `operation: "list_users"` / `"get_user"` / `"get_bot_user"` |
| (none)              | `notion_describe` (returns JSON Schema + example for one op) |
| (none)              | `notion://operations` MCP resource (markdown cheat sheet) |

### Call shape

v1:

```jsonc
// notion_pages
{
  "payload": {
    "action": "create_page",
    "params": { "title": "Hi", "parent": { "type": "page_id", "page_id": "..." } }
  }
}
```

v2:

```jsonc
// notion_execute
{
  "operation": "create_page",
  "payload": { "title": "Hi", "parent": { "type": "page_id", "page_id": "..." } }
}
```

The outer `payload.action` / `payload.params` indirection is gone — you pass the operation name as a sibling of `payload`, and `payload` is just the op's fields.

### Operation renames

| v1 action                                | v2 operation             |
| ---------------------------------------- | ------------------------ |
| `update_page_properties` (title rename)  | `set_page_title`         |
| `update_page_properties` (single field)  | `set_page_property`      |
| `update_page_properties` (multi field)   | `set_page_properties`    |
| `retrieve_block`                         | `get_block`              |
| `retrieve_block_children`                | `get_block_children`     |
| `append_block_children`                  | `append_blocks`          |
| `batch_append_block_children`            | `append_blocks` with `{ items: [...] }` |
| `batch_update_blocks`                    | `update_block` with `{ items: [...] }`  |
| `batch_delete_blocks`                    | `delete_block` with `{ items: [...] }`  |
| `batch_mixed_operations`                 | `batch_mixed_blocks`     |
| `get_comments`                           | `list_comments`          |

### Batch envelope

v1 had five separate batch tools/actions. v2 has one shape that applies to every batchable op:

```jsonc
{
  "operation": "set_page_title",
  "payload": {
    "items": [
      { "page_id": "p1", "title": "First" },
      { "page_id": "p2", "title": "Second" }
    ],
    "atomic": false,            // default false; true aborts + rolls back on first failure
    "concurrency": 3,           // 1..10, default 3
    "idempotency_key": "..."    // optional; same key = cached batch result for 5 min
  }
}
```

The response is `{ ok, summary: { total, succeeded, failed }, results: [{ index, ok, data | error }], rolled_back? }`.

### Errors

v1 returned a free-form text error. v2 returns a structured envelope:

```jsonc
{
  "ok": false,
  "error": {
    "code": "validation_error",
    "operation": "set_page_title",
    "message": "Invalid input for operation set_page_title",
    "issues": [{ "path": ["title"], "message": "Expected string, received number" }],
    "schema": { /* full JSON Schema for the op */ },
    "example": { "page_id": "<page-id>", "title": "New title" },
    "fix": "Patch your payload to match `schema`, then retry."
  }
}
```

If you're an LLM hitting a validation error, you can correct and retry without first calling `notion_describe` — the schema and a working example come back in the error itself.

### Response shape

Reads are slimmed by default. `slimPage` drops the raw properties bag and surfaces a compact projection (`{ id, url, title, parent, icon, in_trash? }` in current versions — see the v2.1/v2.2 sections above for exact fields). Pass `verbose: true` (single call) or per item (batch) if you specifically need the full Notion SDK shape.

### Markdown

`create_page`, `append_blocks`, and `update_block` accept either a structured `children` array (Notion block-request objects) or a `markdown` string. Supported: paragraphs, headings 1–3, bulleted / numbered lists, GFM to-do items (`- [ ]`, `- [x]`) with nested children, blockquotes, fenced code (language is normalized through a small alias map: `ts → typescript`, `js → javascript`, `py → python`, `rs → rust`, …), thematic breaks (`---`), images (`![alt](url)`), and inline annotations (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, links).

`update_block` with `markdown` must parse to **exactly one** block (returns `markdown_multiblock` error otherwise).

## Quick checklist

- [ ] Replace `notion_pages` / `notion_blocks` / `notion_database` / `notion_comments` / `notion_users` calls with `notion_execute`.
- [ ] Move `payload.action` to top-level `operation`, lift `payload.params` to `payload`.
- [ ] Rename actions per the table above.
- [ ] Update any batch sites to use the unified `{ items: [...] }` envelope.
- [ ] If you depend on raw Notion SDK fields, add `verbose: true` to those call sites.
- [ ] Drop any custom error parsing — the new envelope is structured.
