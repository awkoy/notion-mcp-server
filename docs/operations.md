# Tools, calls and resources

The [README](../README.md#tools-and-operations) lists the 47 operations. This page shows what a call looks like on the wire, which is mostly useful when you're debugging an agent or writing your own client. Models learn all of this from the tool schemas, so you don't need to teach it to them.

## Three tools

| Tool | Runs | Annotation |
| --- | --- | --- |
| `notion_read` | Every read: `get_*`, `list_*`, `search_pages`, `query_database`, `query_view`, `query_meeting_notes` | `readOnlyHint: true` |
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
{
  "operation": "query_meeting_notes",
  "payload": {
    "filter": {
      "property": "created_time",
      "filter": { "operator": "date_is_on_or_after", "value": { "type": "relative", "value": "one_week_ago" } }
    },
    "sort": [{ "property": "created_time", "direction": "descending" }],
    "limit": 20
  }
}

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

// a typed database: Notion builds the schema, so no `properties` (passing both is a validation error);
// tasks: Task name, Assignee, Status, Due — projects: Project name, Owner, Dates, Status —
// skills: Skill name, Description, Files, Tags, Created by. Names follow the language of the token's owner.
// Without `title` the database is named after its type; results carry `database_type`
{ "operation": "create_database", "payload": { "database_type": "tasks", "title": "Sprint tasks" } }

// a status property: `status: {}` gives Notion's defaults (Not started, In progress, Done);
// each option joins one of the fixed groups To-do, In progress or Complete;
// on update, { "id": "<option-id>", "color": "red" } recolors an existing option (Notion keeps its name);
// the list replaces the property's options, so list every option to keep
{
  "operation": "update_data_source",
  "payload": {
    "data_source_id": "<data-source-id>",
    "properties": {
      "Stage": {
        "status": {
          "options": [
            { "name": "Backlog", "color": "gray", "group": "To-do" },
            { "name": "Building", "color": "blue", "group": "In progress" },
            { "name": "Shipped", "color": "green", "group": "Complete" }
          ]
        }
      }
    }
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

// change a page without notifying anyone
{
  "operation": "set_page_property",
  "payload": {
    "page_id": "<page-id>",
    "name": "Owner",
    "value": ["<user-id>"],
    "notifications": { "mode": "silent" }
  }
}
```

## Silent page writes

`create_page`, `set_page_title`, `set_page_property`, `set_page_properties`, `archive_page`, `trash_page` and `restore_page` take an optional `notifications: { "mode": "silent" | "default" }`. In a batch it goes on each item.

`silent` skips page update notifications, @mention notifications and notifications to people added to a Person property. Database automations, reminders and connection webhooks still run, and page history, page activity and audit logs still record the change. Leaving the field out, or passing `default`, gives Notion's standard behaviour.

`create_page` applies the mode to every request it makes, including the appends for content too large for one request. `update_page_markdown` and `move_page` don't have the field, because Notion's endpoints behind them don't accept it.

## Batches

Every mutating operation accepts `{ items: [...] }` and returns a result per item.

- `concurrency` runs up to 10 items in parallel (default 3).
- `atomic: true` stops at the first failure and archives what the batch already created, best effort.
- `idempotency_key` makes a retry safe. For 5 minutes the key stays bound to the operation, the items and `atomic`; `concurrency` can change.
  - The same batch again gets the first result back, marked `idempotency_receipt: { decision: "deduplicated" }`, and nothing runs twice.
  - A different batch under the same key fails with `idempotency_conflict`.
  - A retry while the first call is still running fails with `idempotency_in_progress`.
  - A batch in which no item passed validation is not kept, so the corrected batch can reuse the key.

## Fewer properties in a response

`search_pages`, `create_page`, `set_page_title`, `set_page_property`, `set_page_properties`, `archive_page`, `trash_page` and `restore_page` take `filter_properties`, a list of property names or ids. Notion then returns only those properties.

```jsonc
{ "operation": "set_page_property", "payload": { "page_id": "<page-id>", "name": "Status", "value": "Done", "verbose": true, "filter_properties": ["Status", "Due Date"] } }
```

- It matters with `verbose: true`. On a row with 24 properties, a verbose write went from about 5,260 to 970 bytes, and a verbose search of 7 results from 28,695 to 6,232. The default response carries no properties, so its size stays the same.
- The default response and `ranking: "title_relevance"` read the title, so `title` is added to the list for them. With `verbose: true` and no ranking, the list is sent as given and the title is dropped unless you name it. `title` addresses the title property whatever it is called.
- A name or id that doesn't exist fails a write with `validation_error`, and nothing is written. `search_pages` skips it and returns no error.
- A page outside a data source only ever returns `title`. Data source results in a search keep their full schema.
- `move_page` and `update_page_markdown` don't take it, because their endpoints don't.

## Errors and warnings

A payload that doesn't validate comes back with `{ code, message, path, issues, schema, example, fix }`: the operation's JSON Schema, a working example and a hint, so the next call can be corrected without a `notion_describe` round trip.

A successful result can carry `warnings`. Each entry names a field that was ignored (misspelt or misplaced) along with the accepted ones, or a property name that was corrected, or says that what came back is incomplete. The call still ran.

## Incomplete reads

Notion cuts some reads short. The server passes on what it knows and warns before a write that would lose the missing part.

- **`get_page_markdown`** returns `truncated` and `unknown_block_ids` next to `markdown`. Notion truncates pages over about 20,000 blocks, and blocks the integration can't load (not shared with it, for example) appear as `<unknown>` tags with their ids in `unknown_block_ids`. When either says the page is incomplete, a warning says not to replace the page with `update_page_markdown`, which would delete the missing blocks; edit with `insert_content`, `append_blocks` or `update_block` instead.
- **`get_page` with `include_properties: true`** returns every value of a relation or people property. A page object holds at most 25, so for a longer list the server reads the property itself through Notion's property endpoint, up to 1,000 values. A list longer than that is named in `truncated_properties`, with a warning not to write it back with `set_page_property`, which replaces the whole list. So is a list Notion refuses to read in full: it keeps the 25 values from the page object, and the warning gives Notion's error. With `verbose: true` the raw page comes back as Notion sent it, with a warning naming the cut properties.
- **`query_database` and `query_view`** rows keep the 25 values a query returns. Reading the rest would take an extra call for each cut property in each row, so the server names the properties that may hold more in each row's `truncated_properties` and adds one warning (people carries no `has_more`, so a people list of exactly 25 counts); read the row with `get_page` before writing such a property back.
- **`query_meeting_notes`** returns at most 50 notes, and Notion gives this endpoint no cursor. When more match, `has_more` is `true` and a warning says to narrow the filter or change the sort. The call needs a plan with AI meeting notes (without one Notion answers 400 `validation_error`) and returns only notes the token's user attends. A note comes back with `id`, `title`, `status`, its times, `calendar_event`, `recording` and the `summary_block_id`, `notes_block_id` and `transcript_block_id` of its content blocks; `verbose: true` gives Notion's block objects. `filter` takes one property filter or an `and`/`or` combinator; a single property filter is sent as a one-clause `and`, because the API rejects one at the root.

## MCP resources

Clients that support resource attachment (`@`-mention) can pull Notion content into context without a tool call. Dynamic resources go through the same auth, rate limiting and access controls as tool calls.

| Resource URI | Returns |
| --- | --- |
| `notion://operations` | Markdown cheat sheet of every enabled operation, with batchability and the tool that runs it |
| `notion://page/<page_id>` | Page body as markdown. An incomplete page (see [Incomplete reads](#incomplete-reads)) starts with an HTML comment that says so. |
| `notion://database/<data_source_id>` | Data source schema as JSON |
