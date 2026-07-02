# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.0] — 2026-07-02

### Added

- **Create pages from Notion templates.** `create_page` gains an optional `template` field — `{ type: "template_id" | "default" | "none", template_id?, timezone? }` — passed through to the Notion API's page-create template support. It is mutually exclusive with `markdown`/`children` (the API rejects body content alongside a template) and requires `template_id` when `type` is `"template_id"`; both rules are validated locally with clear messages. (Thanks @Omee11 — PR #24.)
- **`list_data_source_templates`.** New read operation wrapping the SDK's `dataSources.listTemplates`, returning `{ id, name, is_default }` per template so callers can discover the `template_id` to apply. No new dependencies — the already-pinned `Notion-Version: 2026-03-11` covers both endpoints.

### Changed

- **Dev toolchain bumps:** `vitest` `4.1.8 → 4.1.9`. No runtime impact.

## [2.9.0] — 2026-06-21

### Added

- **HTTP(S) proxy support.** The Notion client now routes its requests through an HTTP(S) proxy when one is configured via the standard `HTTPS_PROXY` / `HTTP_PROXY` (and lowercase) environment variables; with no proxy set, behavior is unchanged. Useful behind corporate proxies. (Thanks @KokomiSensei — original PR #17.)

### Changed

- **Docker base image → `node:24-alpine`** (current Active LTS, digest-pinned), up from `node:22-alpine`. Dependabot proposed the non-LTS `node:26`; we stay on LTS.
- **Dev toolchain bumps:** TypeScript `5.9 → 6.0`, `@types/node` `22 → 25`, `shx` `0.3 → 0.4`, `vitest` `4.1.7 → 4.1.8`, and pinned GitHub Actions SHAs refreshed. No runtime impact.

## [2.8.0] — 2026-06-21

### Added

- **Database views.** Six new operations for Notion database views (GitHub #18): `list_views`, `get_view`, `query_view`, `create_view`, `update_view`, `delete_view`. `query_view` runs a view's stored filters/sorts and returns hydrated rows by default (set `hydrate: false` for ordered ids only), surfacing `total_count` and `truncated`; it hides Notion's create-then-paginate query mechanics. `list_views` hydrates Notion's id-only refs to `{id, name, type}` by default. `create_view` / `update_view` reuse the `where` filter shorthand and accept a raw `configuration` for type-specific layout (calendar/board/timeline/chart/map require it; a missing config is rejected locally with a fix rather than a raw API 400). `delete_view` is destructive and honors `NOTION_READ_ONLY` / the allow/block lists. See [README → Operations menu](./README.md#operations-menu-41-ops-plus-one-alias).

### Changed

- **Pinned `Notion-Version` bumped `2025-09-03` → `2026-03-11`.** The append-children `position` object and page/database `in_trash` field were already in use; this release also routes the legacy `update_data_source` `archived` alias into `in_trash` (the `archived` field was removed on the new surface) and adds `in_trash` to the block response schema. No dependency change (`@notionhq/client@^5.22.0`).

## [2.7.0] — 2026-06-17

### Added

- **Streamable HTTP transport.** The server can now run as a remote/hosted endpoint in addition to stdio. Set `MCP_TRANSPORT=http` (default stays `stdio`) to serve the MCP Streamable HTTP protocol at `POST/GET/DELETE /mcp` plus an unauthenticated `GET /health`. Stateful sessions (one server instance per `mcp-session-id`), built on Node's `http` module (no new dependencies). Single-tenant: it uses the same `NOTION_TOKEN`. Config via env: `PORT` (default `3000`), `HOST` (default `127.0.0.1`), optional `MCP_AUTH_TOKEN` (when set, `Authorization: Bearer <token>` is required on `/mcp`), and `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` for DNS-rebinding protection (localhost defaults). See [README → Remote / HTTP transport](./README.md#-remote--http-transport).

### Security

- **Supply-chain hardening of the build & release pipeline** (no change to the published package's runtime code). Following the 2025–2026 npm attack wave (Shai-Hulud worm, TrapDoor, Miasma/`binding.gyp`): the npm publish job now installs with `--ignore-scripts` (blocking dependency lifecycle scripts, the primary malware vector) and upgrades npm so the existing `min-release-age=7` cooldown is actually enforced in CI; every GitHub Action is pinned to a full commit SHA (not a mutable tag); the Docker base image is pinned to its multi-arch digest; `save-exact=true` prevents version-range drift; a new `CI` workflow gates every PR/push on `npm audit --omit=dev --audit-level=high`, build, and tests; and `dependabot.yml` keeps npm deps (with a matching 7-day cooldown), Actions SHAs, and the base-image digest current via reviewed PRs.

## [2.6.1] — 2026-06-17

### Security

- **Refreshed transitive `hono` and `vite` to their patched releases.** `hono` `4.12.23 → 4.12.25` (clears several advisories incl. GHSA-88fw-hqm2-52qc) and `vite` `8.0.14 → 8.0.16` (GHSA-fx2h-pf6j-xcff). Lockfile-only change — no direct dependency or runtime behavior changed. `hono` arrives transitively via `@modelcontextprotocol/sdk` and is only exercised by HTTP transports (this server is stdio-only); `vite` is a dev-only test-runner dependency and is not shipped in the published package. `npm audit` is now clean.

## [2.6.0] — 2026-06-17

### Added

- **`NOTION_READ_ONLY` switch.** Set `NOTION_READ_ONLY=true` (also accepts `1`/`yes`/`on`) to disable every write operation in one flag — equivalent to `NOTION_BLOCKED_OPERATIONS=write`, and it composes with the existing allow/block lists. Read-only is reflected in the startup access log. Optional; unset means no change. See [README → Restricting operations](./README.md#restricting-operations).
- **Dynamic MCP resources for pages and databases.** In addition to the `notion://operations` cheat sheet, the server now serves `notion://page/<page_id>` (page body as markdown) and `notion://database/<data_source_id>` (data source schema as JSON), so clients that support resource attachment can pull Notion content into context without a tool call. Both route through the normal dispatch path, so they inherit auth, rate limiting, retries, and access gating (a disabled or read-only target returns an error envelope rather than content).

### Fixed

- **Reported server version was stuck at `1.4.0`.** The MCP handshake version was a hand-maintained constant left over from the Zod 4 migration and had drifted from the published package version. It is now read directly from `package.json`, so the handshake and startup log always report the real version.

## [2.5.1] — 2026-06-05

### Fixed

- **Multi-arch Docker publish.** The `linux/amd64` + `linux/arm64` images build concurrently and shared a single npm cache mount (its id defaulted to the target), so the two parallel `npm ci` runs collided writing the same cacache blob (`EEXIST: rename … _cacache/tmp → _cacache/content-v2`) — failing the Docker release on v2.4.5–v2.5.0 while npm always succeeded. The cache mount is now scoped per `$TARGETARCH` with `sharing=locked`. No change to the published package or runtime behavior.

## [2.5.0] — 2026-06-05

### Added

- **Operation access control via `NOTION_ALLOWED_OPERATIONS` / `NOTION_BLOCKED_OPERATIONS`.** Restrict which operations an agent can execute using group presets — `read`, `write`, `destructive`, or a per-domain group (`pages`, `blocks`, `databases`, `data_sources`, `comments`, `users`, `files`) — and/or individual operation names. The most common case, a read-only deployment, is just `NOTION_ALLOWED_OPERATIONS=read`. The blocklist is applied after the allowlist (block wins on conflict); an allowlist that resolves to nothing fails closed. Disabled operations are rejected by `notion_execute` with `operation_not_allowed` and hidden from the `notion://operations` menu and from `notion_describe`. Both env vars are optional — unset means every operation is enabled, exactly as before. Closes [#7](https://github.com/awkoy/notion-mcp-server/issues/7). See [README → Restricting operations](./README.md#restricting-operations).

## [2.4.0] — 2026-05-27

### Breaking changes

- **`upload_file` source discriminator renamed `kind` → `type`.** Brings the file source shape in line with every other discriminated union in the API (`parent.type`, `icon.type`, `block.type`, etc.). Pass `{ source: { type: "base64", data: "..." } }` or `{ source: { type: "url", url: "..." } }`. The legacy `kind` field is rejected outright. See [MIGRATION.md](./MIGRATION.md).

### Added

- **`get_self` alias for `get_bot_user`.** LLMs reach for `get_self` reflexively when probing identity. Both names now resolve to the same handler.
- **`include_properties` flag on `get_page`.** Defaults to `false`. Pass `true` to receive the flattened `properties` map alongside the page metadata — same shape `query_database` emits per row.

### Changed

- **Validation error envelopes are now path-sliced.** Instead of dumping the full operation schema (5–13KB on `set_page_property`, `update_database`, `query_database`), the envelope now slices the schema down to the failing field and summarizes any large unions into one-line-per-branch discriminator tags. Typical envelopes shrink from ~10KB to <1KB. The full schema is still one `notion_describe` call away.
- **`set_page_property` / `set_page_properties` accept a plain string for the title.** When `name === "title"` (singular) or `properties.title` (plural) is a string, the server wraps it into Notion's `{title:[{type:"text",text:{content}}]}` shape before validation. Removes the most common LLM authoring mistake.
- **`update_block` infers the block type from `data`.** When `data` contains exactly one recognized block-type key (e.g. `{ paragraph: {...} }`), the server fills in the `type` discriminator automatically. Old shape `{ type: "paragraph", data: { paragraph: {...} } }` still works.
- **`upload_file` mode defaults to `"single"`.** No need to pass `mode` for the 99% case; only specify `"multi"` for files >5MB.
- **`batch_mixed_blocks` now returns `wrong_envelope` instead of `not_batchable`** when called with the universal `{ items: [...] }` form. The error message points callers at the correct `{ operations: [...] }` envelope.

## [2.3.0] — 2026-05-27

### Changed

- **`get_data_source` now returns `properties` as a `{ name: type }` map** instead of a name-only array. Same byte cost, but the type info is what `query_database` planners actually need — callers no longer have to drop `verbose: true` just to learn property types.
- **`move_page` renamed `new_parent` → `parent`** so the field matches `create_page`. One less inconsistency to memorize.
- **`query_database` hoists the per-row `parent` to the list level.** Every row in a `query_database` result has the same parent (single data source), so the parent is emitted once on the list and stripped from each row — on a 100-row page this saves ≈8KB. `verbose: true` keeps per-row parents.
- **`slimUser` omits `avatar_url`** when it's missing, instead of serializing `avatar_url: null`. Bot `workspace_name` is also conditional now.
- **`slimComment` drops `created_time`** for consistency with other slim shapes (other ops dropped it in v2.2). Use `verbose: true` if you need it.
- **WHERE DSL keywords are case-insensitive.** `and`/`or`/`not` (canonical, matches Notion's filter JSON) and `AND`/`OR`/`NOT` (SQL-style) both work. If a column is literally named `and`/`or`/`not`, wrap it as an operator object with `__type` to disambiguate.
- **`upload_file` description expanded** to spell out the two supported source shapes (`base64` and `url`) up front, so the LLM doesn't have to call `notion_describe` first for the common case.

### Fixed

- **`unique_id` prefix is validated locally.** Notion rejects single-letter prefixes with a generic 400; we now reject them at the schema layer with a precise message (2–10 chars, letter-prefixed, alphanumeric + hyphen only). Saves a round-trip and gives the LLM a clean "fix" instead of an API echo.

## [2.2.0] — 2026-05-27

### Changed

- **Slim shapers trimmed for token efficiency.** Default reads now omit duplicate, default-state, and otherwise noisy fields: pages drop `archived`, `created_time`, `last_edited_time`, and the `in_trash: false` default (only emit when trashed); databases drop the `in_trash: false`, `is_inline: false`, `is_locked: false`, and empty-`description` defaults; blocks omit `has_children: false` and `in_trash: false`; data sources drop empty-`description` defaults. The `count` field is gone from `list_data_sources` (`results.length` is the source of truth). Pass `verbose: true` to get the raw Notion SDK response.
- **`query_database` now flattens property values by default.** Each row carries a `properties` map of name → primitive (or small object) for `title`, `rich_text`, `number`, `select`, `multi_select`, `status`, `date`, `people`, `files`, `checkbox`, `url`, `email`, `phone_number`, `formula`, `relation`, `rollup`, `created_time`, `last_edited_time`, `created_by`, `last_edited_by`, `unique_id`, `verification`. `verbose: true` keeps the full Notion shape.
- **`append_blocks` returns `{ appended, ids }` by default**, slimmed from the full block array. Pass `verbose: true` to receive each appended block in slim shape; the same applies to the `append` branch in `batch_mixed_blocks`.
- **`notion_execute` / `notion_describe` now serialize JSON without indentation** for ~30% smaller wire responses (agents parse JSON either way).

### Fixed

- Rollup `array` rows now flatten each element via the property-value flattener instead of returning the array length (`r.array.length` was emitted as the "value").
- `unique_id` properties with a missing `number` no longer leak the string `"PREFIX-null"` — the property is omitted from the flattened map instead.
- `append_blocks` (and `batch_mixed_blocks` `append`) only emits an `ids` field when the SDK response is long enough to cover the requested children; otherwise the field is omitted so callers don't see incorrect IDs.

## [2.1.0] — 2026-05-26

### Changed

- Bumped to `@notionhq/client@^5.22.0` and pinned `Notion-Version: 2025-09-03`. Server now talks to the modern Notion API line. Tool surface (`notion_execute`, `notion_describe`) is unchanged for callers.
- `query_database` now routes through `dataSources.query` under the hood. Single-source databases continue to work transparently when you pass `database_id`. Multi-source databases require `data_source_id` (returns a `multi_source_database` self-healing error pointing to `list_data_sources` if ambiguous).

### Added

- **Data sources as first-class entities** — `list_data_sources`, `get_data_source`, `update_data_source`.
- **New page endpoints** — `move_page` (relocate without recreating), `get_page_markdown` / `update_page_markdown` (server-rendered markdown round-trip).
- **Comment lifecycle** — `get_comment`, `update_comment`, `delete_comment`. `add_page_comment` / `add_discussion_comment` / `update_comment` also accept a `markdown` body as an alternative to plain text / rich text.
- **New parent types** — `data_source_id`, `workspace`, `block_id` accepted in `create_page` and elsewhere `PARENT_SCHEMA` is used.
- **New block types** — `heading_4`, `tab` accepted in structured input; the markdown parser emits `heading_4` for `####`.
- **New database property types** — `button`, `unique_id`, `verification`. `verification` is writable on pages.
- **`position` param** on `append_blocks` (preferred over legacy `after`; XOR-refined so callers can't pass both).

## [2.0.0] — 2026-05-26

### Breaking changes

- **Replaced five domain tools (`notion_pages`, `notion_blocks`, `notion_database`, `notion_comments`, `notion_users`) with two:** `notion_execute` and `notion_describe`. Any client that hard-codes the old tool names must rename — see [MIGRATION.md](./MIGRATION.md).
- The `action` / `params` envelope is gone. Call sites now pass `{ operation, payload }` directly.
- Renamed operations to verb-first names: `update_page_properties` → `set_page_title` (title rename) / `set_page_property` (single field) / `set_page_properties` (multi field), `get_comments` → `list_comments`, `retrieve_block` → `get_block`, `retrieve_block_children` → `get_block_children`, `append_block_children` → `append_blocks`, etc. Full mapping in MIGRATION.md.

### Added

- **`notion_execute`** — single tool that dispatches every operation by name.
- **`notion_describe`** — returns JSON Schema + a working example for any operation.
- **`get_block`** — retrieve a single block by ID (closes the v1 `retrieve_block` gap). Batchable.
- **`set_page_properties`** — set multiple page properties in a single API call (the multi-field equivalent of v1's `update_page_properties`). Batchable.
- **`notion://operations`** resource — a markdown cheat sheet of every supported operation.
- **Self-healing errors** — validation failures return `{ code, message, path, issues, schema, example, fix }`, so an LLM can correct a malformed payload in one round-trip.
- **Universal batch envelope** — every batchable op accepts `{ items: [...], atomic?: boolean, idempotency_key?: string, concurrency?: 1..10 }`. Per-item validation, per-item results, summary counts.
- **Atomic batches with best-effort rollback** — `atomic: true` aborts on the first failure and (where the op defines a `rollback`) archives entities created earlier in the batch.
- **Idempotency keys** — same `(operation, idempotency_key)` returns the cached batch result for 5 minutes (max 512 entries).
- **Markdown shortcut** — `create_page`, `append_blocks`, and `update_block` accept a `markdown` string. The remark / remark-gfm pipeline converts paragraphs, headings 1–3, bulleted / numbered lists, to-do items (including nested children), blockquotes, fenced code with language normalization, thematic breaks, images, and inline annotations (bold, italic, strikethrough, inline code, links).
- **Slim response shapers** — every read returns a compact projection by default; pass `verbose: true` to get the raw Notion SDK response.
- **JSON Schema `$defs` deduplication** — shared sub-schemas (rich text, parent, icon, file) are hoisted to `$defs` instead of being inlined, shrinking error envelopes significantly.
- **Improved error envelopes** — `code` + `message` + `fix` for restricted_resource, unauthorized, validation_error, conflict_error, etc.
- **Vitest smoke harness** (`npm test`) — covers the markdown parser, slim shapers, schema emitter (`$defs` hoisting), and dispatcher (validation paths, batch partial success, atomic rollback, idempotency dedupe).

### Changed

- Bumped to `zod@^4.4.3` (the 2.0.0 line targets Zod 4 only — Zod 3 is no longer supported).
- Default batch concurrency is 3 (matches Notion's rate-limit budget); max is 10.
- Notion errors now carry the path of the offending payload field where the SDK supplies one.

### Removed

- The 21 individual tool files under `src/tools/*.ts` have been deleted. The operation logic now lives in `src/operations/`, registered into a central dispatcher.
- The `handleNotionError` `CallToolResult` shim is gone — the dispatcher uses `toErrorEnvelope` directly.

## [1.4.0] — earlier

- Migrated to `zod@^4.4`. Restricted `z.url()` to http/https schemes.

## [1.3.0] — earlier

- Hardened Docker image, GHCR publish workflow, Docker Hub catalog submission.

## [1.2.x] — earlier

- README rewrite for PAT-first onboarding; final-review fixes on the OAuth auth gateway.
