# Markdown v2 and safe targeted page edits (2026-03-11 API)

The existing `get_page_markdown` and `update_page_markdown` operations accept
`markdown_version: "v2"`. It is opt-in: without it, both use Notion's
enhanced Markdown v1, the default at the pinned API version. Read and
write a page with the same version.

Read without writing:
```json
{"page_id":"<id>","markdown_version":"v2"}
```
Set `include_transcript:true` only when authorized for meeting transcripts.
The response preserves `truncated`, `unknown_block_ids`, and
`content_warnings`; warnings are also shown in the operation envelope.

Prefer targeted edits:
```json
{"page_id":"<id>","markdown_version":"v2",
 "content_updates":[{"old_str":"old exact text","new_str":"new text"}]}
```
Each `old_str` must be nonempty. Use `replace_all_matches:true` only when
you intend to change every occurrence. Notion rejects ambiguous matches
otherwise. `allow_deleting_content:true` can delete child content; use only
on an explicitly authorized operation.

The API may apply some matching edits and report failures to match the
others. Treat returned `content_warnings` and envelope `warnings` as
a reconciliation requirement, **not** proof every requested edit applied.
Do not blindly repeat a potentially partially applied write.

`allow_async:true` returns `data.queued:true` and a task receipt if
Notion responds with an async task. Poll the returned task ID using
`get_async_task` before claiming that the page was updated.
Synchronous responses include `truncated` and `unknown_block_ids`.

Use anchored insertions for surgical placement next to an existing block:
```json
{"page_id":"<id>","markdown":"New content","markdown_version":"v2",
 "insert_content":{"position":{"type":"after_content","anchor":"## Action items"}}}
```
`before_content` inserts before the uniquely matched block; both positions
require `markdown_version:"v2"`. The exact `anchor` must start where a
block begins and match **one** location, including leading Markdown syntax.
Read the page with `get_page_markdown` using v2 first. A nonexistent,
ambiguous, or partial-block anchor is rejected by Notion; never blindly retry
a potentially applied write.

`insert_content.after` remains available for existing callers, but it is
a **deprecated ellipsis text selector**, not a block ID. Choose exactly
one of `after` or `position`. Legacy `position:"start"|"end"` is also
supported. Do not combine `content_updates` with `markdown` or
`insert_content`. Replacing the whole page remains backwards compatible
but can lose content behind inaccessible or truncated blocks.

**Other v2 coverage:** When `create_page` receives `markdown_version:"v2"`
with a `markdown` body, the original markdown is sent natively to Notion.
With the version omitted, legacy local GFM-to-block conversion remains
unchanged. `add_page_comment`, `add_discussion_comment` and `update_comment`
also accept `markdown_version:"v2"` with a Markdown body. All version
selectors are rejected if no markdown body is supplied. This is API
compatibility, not Custom Agent or meeting-note integration.

**SDK compatibility:** `@notionhq/client` 5.32.0 adds typed anchored positions
and fixes native Node 22 ESM imports. Keep the existing Node 22 interop bridge
until an independently tested release gate confirms removing it is safe.

Primary docs:
- https://developers.notion.com/reference/retrieve-page-markdown
- https://developers.notion.com/reference/update-page-markdown
- https://developers.notion.com/page/changelog
