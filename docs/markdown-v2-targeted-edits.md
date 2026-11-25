# Markdown v2 and safe targeted page edits (2026-03-11 API)

The existing `get_page_markdown` and `update_page_markdown` operations now accept
`markdown_version: "v2"`. This is opt-in: the pinned Notion API version
still defaults to enhanced Markdown v1. The next API version will default
to v2 and reject explicit v1. Use matched read/write versions during tests.

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

Legacy `insert_content` is supported, but its `after` value is an
ellipsis text selector, not a block ID. Choose exactly one of `after`
or `position`. Do not combine `content_updates` with `markdown`
or `insert_content`. Replacing the whole page remains backwards
compatible but can lose content behind inaccessible or truncated blocks.

## Release gates

- Confirm source builds with `@notionhq/client 5.29.0`.
- Run handler and operation-registry unit tests.
- Run full Node 22/24/Docker CI (Windows file path-policy tests are
  separately tracked as host-specific known failures).
- On an isolated disposable Notion page, verify read v2, exact-match
  update, unmatched edit warnings, and `unknown_block_ids` behavior.
- Do not replace production pages, switch global API versions, or
  alter the multi-account wrapper in this source-only release.

Primary docs:
- https://developers.notion.com/reference/retrieve-page-markdown
- https://developers.notion.com/reference/update-page-markdown
- https://developers.notion.com/page/changelog
