# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] — 2026-09-02

### Changed

- **Breaking: `notion_execute` is gone; `notion_read` and `notion_write` replace it, and `operation` is an enum.** One tool ran every operation, so a client could only allow or prompt for all of Notion at once: MCP clients grant permissions by tool name (Claude Code's `mcp__<server>__<tool>` rules, Cursor's per-tool allowlist), and none of them reads the `readOnlyHint` annotation. `notion_read` (annotated read-only and idempotent) now runs the read operations and `notion_write` (annotated destructive) the write operations, with `NOTION_CONFIRM_DESTRUCTIVE` and the access checks unchanged, so reads can be approved once while writes still ask. Each tool's `operation` field is an enum of exactly the operations enabled on this server instead of a free string: the menu ships inside the tool list, a client can validate a call before sending it, a disabled operation cannot be named at all, and when no write operation is enabled (`NOTION_READ_ONLY`, or an allowlist of reads) `notion_write` is not advertised. A name sent to the wrong tool fails validation in one round-trip with a message that says which tool runs it; an unknown name lists the tool's operations. `notion_describe` keeps its free-string input (the two enums are already the menu) and now returns `tool`; the `notion://operations` table gained a Tool column; the four prompts and the per-call debug log line name the tool that ran. Same payloads, same responses, same environment variables — only the tool name changes, and modern clients rediscover tools on reconnect. See MIGRATION.md.
- **MCP TypeScript SDK v2.** The server now builds on the split SDK 2.0 packages — `@modelcontextprotocol/server` `2.0.0` (`McpServer`, resources, prompts, the stdio transport) and `@modelcontextprotocol/node` `2.0.0` (`NodeStreamableHTTPServerTransport` for the HTTP transport) — replacing the monolithic `@modelcontextprotocol/sdk` `1.30.0`; the tests drive it through `@modelcontextprotocol/client` `2.0.0`. Nothing changes for clients: the same protocol versions are negotiated (`2024-11-05` through `2025-11-25`; a `2026-07-28` client is still answered with `2025-11-25`), and `serverInfo`, capabilities, the two tools, three resources, four prompts, every HTTP status on `/mcp` and `/health` (sessions, `401`/`403` bearer auth, `403` Host/Origin rebinding checks, `415`, `406`), and every environment variable are identical — verified by replaying the same handshake against both builds. Two details in `tools/list` differ: `inputSchema.$schema` is now JSON Schema 2020-12 (zod 4's native emitter) instead of draft-07, and `execution: { "taskSupport": "forbidden" }` is no longer emitted (absent means the same thing). Tool and prompt argument schemas are wrapped in `z.object()`, since v2 deprecates raw shapes. The production dependency tree shrinks from 167 to 84 packages — `express`, `express-rate-limit`, `ip-address`, `ajv`, `cors`, `jose`, `pkce-challenge` and friends were SDK 1.x transitives and are gone; `hono` stays as a peer of `@modelcontextprotocol/node`, and `@hono/node-server` moves back from `2.0.12` to `1.19.17` because that package pins `^1.19.9` (upstream modelcontextprotocol/typescript-sdk#2548) — `npm audit --omit=dev` stays clean. Node `>=20` and ESM were already required. The transport's `enableDnsRebindingProtection` / `allowedHosts` / `allowedOrigins` options are kept although v2 marks them deprecated: the replacement `hostHeaderValidation()` / `originValidation()` guards match hostnames only, which would change what `MCP_ALLOWED_HOSTS` / `MCP_ALLOWED_ORIGINS` accept. (PR #82.)
- **`@notionhq/client` `5.23.2 → 5.26.0`.** 5.24 widened the SDK's response type with an optional web-stream `body` (`getReader()`) for its new `sessions.stream()` SSE API, so the `node-fetch`-based proxy adapter in `src/services/notion.ts` no longer satisfied `SupportedFetch` and the build failed. The adapter now returns the SDK's expected shape and exposes the body lazily through `Readable.toWeb`, so `HTTPS_PROXY` keeps working. 5.25.1 also tightened `isFullDatabase` to require `title`, which the test doubles now carry. (PR #76, supersedes #74.)
- **Smithery listing removed.** Smithery dropped stdio hosting in 2025-09 and the listing 404s, so the README badge and `smithery.yaml` are gone. The Docker MCP catalog submission is tracked as docker/mcp-registry#4227. (PR #81.)
- **Manifests must agree.** `tests/manifests.test.ts` fails the build when `package.json`, `server.json` (both version fields) and `gemini-extension.json` disagree on the version, and checks the MCPB manifest's `privacy_policies` URL and sensitive `notion_token` setting. (PR #81.)
- **Dependabot skips Node major bumps for the Docker base image.** Odd Node majors are 6-month non-LTS lines (25 reached EOL in June 2026), so a Dependabot PR moving `24-alpine` to `25-alpine` was a downgrade. Digest refreshes continue; the move to `26-alpine` happens by hand once it enters LTS in October 2026. Closes the loop on #67. (PR #75.)
- **`notion_describe` is a third smaller.** The 48 schemas summed to 183 KB; they now sum to 121 KB. `update_block` and `batch_mixed_blocks` drop from 28 KB to under 2 KB each (the partial-update shape above), the shared rich-text, parent, icon, file, property-value, colour, language, mention, property-definition and enum shapes are hoisted into `$defs` once per schema instead of being repeated inline, and block requests no longer advertise the read-only echo fields (`object`, `id`, `created_time`, `has_children`, …) that Notion ignores on write. Every example still parses against its schema.
- **Errors say what to fix.** A Notion `validation_error` used to answer with the whole operation schema; the `fix` now says to read the message for the field it names (`path` points at it when present) and where to find a working example. `where_compile_error` names the data source's properties.
- **Runtime dependency bumps:** `hono` `4.12.33 → 4.13.5` (#70), `ip-address` `10.2.0 → 10.4.0` (#65; since removed from the tree by the SDK v2 migration), `node:24-alpine` base image digest `156b55f → e67514e` (#77).
- **Dev toolchain bumps:** `typescript` `6.0.3 → 7.0.2` (#43), `@types/node` `26.1.1 → 26.3.0` and `vitest` `4.1.10 → 4.1.11` (#76).
- **CI action bumps:** `docker/setup-buildx-action` `v4.2.0 → v4.3.0` (#73). Pinned by commit SHA.

### Added

- **Plain property values on database rows.** `create_page`, `set_page_property` and `set_page_properties` took only Notion's typed shapes — `{ status: { name: "Done" } }`, `{ date: { start: "2026-10-01" } }`, `{ multi_select: [{ name: "a" }] }` — so a model had to know or look up the property type before it could write a row, and a wrong guess cost a round-trip. A row's properties now take plain values: `{ Status: "Done", "Due Date": "2026-10-01", Tags: ["a", "b"], Done: true, Score: 42, Notes: null, Owner: "<user-id>", Attachments: ["https://…/chart.png"] }`. When a payload contains a plain value the server reads the row's data source schema (one `dataSources.retrieve`, cached for 5 minutes, refreshed by `update_data_source`) and types each value by the property's type; `null` clears; `title` addresses the title property whatever it is called; a name that differs only in case is corrected with a warning; an unknown property is refused with the valid names, an unknown `status` option with the valid options, and a value of the wrong kind or a read-only property (formula, rollup, created_time, …) with a message that says so. Typed values still pass through untouched and cost no extra request, and a plain value on a page that is not a row returns `not_a_database_page`. `create_page` with a `database_id` parent resolves a single-source database to its data source itself (`multi_source_database` otherwise). `get_data_source` and `search_pages` now list a `select` / `multi_select` / `status` property's options inline (`"select: Low | Medium | High"`, first 30) and a relation's target data source, so one read is enough to write a row or a filter. Property *definitions* (`create_database`, `update_data_source`) may omit `type` when the body key names it: `{ Status: { select: { options: [...] } } }`.
- **Schema-aware `where` and a sort shorthand on `query_database`.** `where` used to guess a property's type from the value's shape — a string meant `select`, so `{ Status: "Done" }` on a `status` property or `{ Name: { contains: "x" } }` on a title compiled to a filter Notion rejected. When the data source schema is available the compiler now uses the declared type for plain values, `null` (`is_empty`, or `equals: false` on a checkbox) and operator objects (`__type` still overrides), and an unknown property name fails locally with the data source's property list instead of an opaque Notion error. `sorts` accepts `"Due Date"` / `"-Due Date"` (descending) and `"created_time"` / `"last_edited_time"` next to the object form. The description and example lead with the shorthand, and the `where_compile_error` fix says what to check.
- **Tables in markdown.** A GFM table in `markdown` (on `create_page`, `append_blocks`, `update_block`, `update_page_markdown`) becomes a Notion `table` block with `table_row` children — first row as the column header, short rows padded to the table's width, inline formatting kept in the cells — instead of being dropped. Slim block responses show a `table_row`'s `cells` as plain strings and a `table`'s `table_width`.
- **Unknown fields warn instead of vanishing.** `z.object` strips keys it does not know, so a misspelt or misplaced field (`page_size` on the wrong operation, `bogus: 1`) silently did nothing. Rejecting it would cost a round-trip when everything else was right, so the call runs and the successful result carries `warnings: ["Ignored unknown field \"bogus\". create_page accepts: parent, title, properties, markdown, children, template, icon, cover, verbose."]`; a batch item gets its own `warnings`, and an unknown envelope field (`parallel: true`) a batch-level one. Loose schemas and unions never warn. The server instructions say that a result's `warnings` lists ignored fields.
- **Partial block updates.** `update_block`'s `data` demanded the whole block body with `type`, `object`, `id`, `has_children` and more — 28 KB of `notion_describe` for a checkbox — while Notion itself accepts `{ to_do: { checked: true } }`. `data` is now `{ type?, <type>: { …fields to change } }`: the type is inferred from the single body key, only the fields given are sent, and a payload with no body key is refused with the shape in the message. The same form works for the `update` arm of `batch_mixed_blocks`, and `- [x] text` markdown sets both the text and the checked state.
- **`object` on search results.** A slim page and a slim database look alike, and a database id is not a valid `create_page` parent; every `search_pages` result now carries `object: "page" | "database" | "data_source"`.
- **Live end-to-end smoke test.** `npm run e2e` (`scripts/e2e.mjs`) starts the built server over stdio and drives it against a real workspace with the token in `.env`: the MCP handshake, the three resources and four prompts, `notion_describe` for every operation, a malformed call to check that the error carries the schema and an example, a Notion URL passed as an id, and every read operation; `--write` adds every write operation inside one page created under `NOTION_PAGE_ID` (markdown round-trip, batch mode, a database with data source and views, `null` deleting a property, comments, `upload_file` with `attach_to` followed by `get_file_url` and `get_image` under `NOTION_FILE_URLS=ref`, move/archive/trash/restore, delete and restore of the database and data source) and trashes that page at the end (`--keep` leaves it). The unit tests all run against a mocked Notion client, so until now nothing exercised the real API end to end; the 2.14.0 build passed this run with 76/76 checks and 48/48 operations. Not part of CI.
- **Server logs reach the MCP client.** The server only ever logged with `console.error`, and most clients hide a server's stderr — VS Code, MCP Inspector and Claude Desktop show `notifications/message` entries in their own log views instead — so the startup banner, the operation-access summary, the Notion auth probe and HTTP or auth failures were invisible there. The server now declares the `logging` capability; every line still goes to stderr, word for word as before, and is also forwarded as a `notifications/message` (logger `notion-mcp-server`, `data: { message, … }`). It honours `logging/setLevel`, with `info` as the default when a client never sets one (the SDK's own filter would send everything, `debug` included, until then), and at `debug` adds one line per `notion_execute` call with the operation, batch size, duration and outcome — never the payload or page content. On stdio the process-level lines go to the one connected client; on HTTP, where there is one server per session, only a session's own per-call lines reach it, so no session sees another's traffic. A log call before `connect()` or after the transport closed just writes stderr. (PR #86.)
- **`NOTION_CONFIRM_DESTRUCTIVE`: the user confirms a destructive operation before it runs.** Blocking the `destructive` group is all-or-nothing, and the server instructions could only ask the model to check with the user before trashing something. With `NOTION_CONFIRM_DESTRUCTIVE=true` (or `1`; default off), `notion_execute` asks the human itself, through MCP elicitation, before dispatching any operation the registry marks `destructive: true` — `archive_page`/`trash_page`, `delete_block`, `batch_mixed_blocks`, `delete_database`, `delete_data_source`, `delete_view`, `delete_comment`. The prompt is a yes/no form that names the operation and its target: the page, database, data source or block title when one retrieve (bounded to 5 s, any failure swallowed) can fetch it, otherwise the id, and for a batch how many items. Read operations, non-destructive writes, restores (`delete_database`/`delete_data_source` with `in_trash: false`) and a `batch_mixed_blocks` call with no `delete` entry never prompt, and the access checks still run first, so a blocked operation returns `operation_not_allowed` without asking. Decline, cancel or answer no and the call returns `confirmation_declined` with a `fix` saying not to retry; the server instructions repeat that while the flag is on. A client that has not declared the elicitation capability gets `confirmation_unavailable` rather than a silent run. Documented in the README's env-var table and Restricting operations section and in `llms-install.md`.
- **`--version` and `--help`.** `notion-mcp-server --version` (or `-v`) prints the package version — exactly the version and a newline, so it can be captured — and exits 0 without starting a transport or touching the network; `--help` (or `-h`) prints a usage summary: the two transports, every environment variable on one line each, and links to the README sections. Any other argument prints `Unknown option: X` plus the usage to stderr and exits 2 — the server takes no other flags, so a typo no longer silently starts a stdio server that sits waiting on stdin. A test spawns the built `build/index.js` for each case and checks the help text against the README's variable tables.
- **Docker health check, opt-in.** The image starts in stdio mode, where nothing listens, so a built-in `HEALTHCHECK` against `/health` would have marked every stdio container unhealthy; the `Dockerfile` instead carries the line commented out, and the README's HTTP-transport section shows the `docker run --health-cmd` and Compose `healthcheck:` equivalents for `MCP_TRANSPORT=http` deployments. The README's Docker HTTP example also gains `HOST=0.0.0.0` (and `MCP_AUTH_TOKEN`), without which the published port is unreachable from outside the container.
- **Every id field takes a Notion URL.** A page URL is what the Notion app puts on the clipboard (Share → Copy link), and the API answered one with `invalid_request_url` and no hint about what to send. Every id field — `page_id`, `block_id`, `database_id`, `data_source_id`, `view_id`, `after`, `create_page`'s parent, relation and people property values, user/page/database mention ids, and `NOTION_PAGE_ID` — now normalizes a Notion URL, a `notion://` deep link, a dashed uuid or a bare 32-hex id to the dashed uuid the API wants. A block link's `#fragment` is used for `block_id`/`after` fields and a database link's `?v=` for `view_id` fields, so a view link passed as `database_id` still means the database. Anything else passes through unchanged and fails exactly as before. Implemented with `z.preprocess` rather than `.transform` so the emitted JSON Schema keeps each field's type and description in `notion_describe`. The `notion_execute` description and the README say so. (PR #47.)
- **`attach_to` on `upload_file`.** `upload_file` returned a `file_upload_id` and nothing said what to do with it; placing the file took a second call with raw `children` JSON whose shape appeared in no schema or example. `attach_to: { block_id, caption?, position?, after? }` — the same placement fields as `append_blocks` — appends the block in the same call. The block type follows the content type: `image/*` → `image`, `video/*` → `video`, `audio/*` → `audio`, `application/pdf` → `pdf`, anything else → `file`. The result then carries `block_id` and `block_type` next to `file_upload_id`; if the append fails after the upload, the error names the `file_upload_id` and the exact `append_blocks` call that places it, so the file is never uploaded twice. (PR #48.)
- **`NOTION_FILE_URLS=ref`, `get_file_url` and `get_image`.** A signed Notion file URL runs about 1,650 characters, is re-signed on every read and expires in an hour — roughly 500 tokens per file that cannot be stored, and a page holding an image could not reuse a cached prompt prefix across turns. With `NOTION_FILE_URLS=ref`, slim responses carry `notion-file:block/<id>` or `notion-file:page/<id>/<prop>/<index>` instead; `get_file_url` re-reads the source object for a fresh signed URL, so the server caches nothing. The default stays `full`, and an external URL is never rewritten. `get_image` returns the bytes as MCP image content (every other operation returns text, so a model could not see an image at all). It accepts only a `notion-file:` ref or a block id and fetches only the signed URL Notion returns for it — never a caller-supplied URL — refuses non-`https` URLs, checks `content-length` and reads the body in chunks with a 5 MB cap, and only accepts `image/*` content types. `get_block` on an image block drops from 1,723 to 145 characters with refs on. Both operations are read-only and documented in a new README → Files section. (PR #50.)
- **`delete_database` and `delete_data_source`.** `update_database` and `update_data_source` accepted `in_trash`, so an operation declared `access: "write"` with no destructive flag could trash a database and every page in it, and `NOTION_BLOCKED_OPERATIONS=destructive` did not stop it — the README listed this under Limitations. Both trash paths now live in their own operations, marked `destructive: true`, so the `destructive` group token, `NOTION_READ_ONLY` and the allow/block lists cover them; `in_trash: false` restores, and the deprecated `archived` alias is routed into `in_trash`. `update_database` and `update_data_source` keep `in_trash`/`archived` in their schemas but reject them with a `trash_moved` envelope pointing at the new operation (mirroring `properties_moved`), because `z.object` strips unknown keys and a silently ignored trash call is worse than an error. Both accept a Notion URL as `database_id`/`data_source_id`. (PR #53; URL support in #47.)
- **`file_upload` accepted wherever Notion accepts it.** The shared file schema only had the `external` variant, so a `file_upload_id` from `upload_file` could not reach an image/video/audio/pdf/file block, a page or database cover, or a `files` property. It is now a discriminated union on `type` (`external` | `file_upload`); a `files` property value takes both arms, with `name` optional on an uploaded entry (Notion already knows its filename) and the optional `type` tag Notion echoes back accepted instead of stripped. Verified against api.notion.com. (PR #46.)
- **`null` deletes a property on `update_data_source`.** Notion removes a data source property when its definition is `null` (`PATCH /data_sources/:id { properties: { Old: null } }`), and the schema rejected it. The nullable lives only where the API takes it: `update_data_source.properties` values may be `null` (the emitted JSON Schema carries the variant and a description saying what it does, and the handler forwards it untouched), while `create_database`'s `initial_data_source` still refuses a `null` Notion would reject. `update_database` keeps a nullable value too, so a `{ Name: null }` attempt there reaches the `properties_moved` redirect instead of dying in validation. (Thanks @FrancoMeneses — PR #80.)
- **Real server instructions.** The two-line placeholder `instructions` string became a 1.5 KB getting-started text: search with `search_pages`/`query_database`, read with `get_page_markdown` (or `get_page` with `include_properties: true`), write with `markdown` on `create_page`/`append_blocks`, the `data_source_id` rule, the batch payload shape, the error → `fix` retry loop, when to call `notion_describe`, and which operations are destructive. When `NOTION_READ_ONLY` or an allowlist has disabled operations, a trailing line says how many are enabled and points at the `notion://operations` resource. Claude Code and Cursor show the model only tool names and this text until a tool is needed, and Claude Code truncates it at 2 KB, so a test keeps it under 2,000 bytes with no indented lines. (PR #81.)
- **Gemini CLI extension.** A `gemini-extension.json` at the repo root makes the server installable with `gemini extensions install https://github.com/awkoy/notion-mcp-server` — `NOTION_TOKEN` is a sensitive keychain setting, `NOTION_PAGE_ID` optional. README quick-start entry. (PR #81.)
- **Privacy policy.** A README → Privacy section — the server talks only to `api.notion.com`, over HTTPS, with the token you configure; no telemetry, no analytics, no server of ours in the path; what `get_image` and `upload_file` will and will not fetch and a `privacy_policies` entry in the MCPB manifest pointing at it — the Claude Desktop extension directory rejects submissions without one. (PR #81.)

### Fixed

- **`get_image` and `upload_file`'s `url` source ignored `HTTPS_PROXY`.** The Notion SDK's calls went through node-fetch with an `HttpsProxyAgent` whenever `HTTPS_PROXY` / `HTTP_PROXY` (or their lowercase forms) is set, but the two direct downloads — the signed image URL in `get_image` and the `source: { type: "url" }` fetch in `upload_file` — used the global `fetch`, so behind a corporate proxy both failed while every other operation worked. Both now go through one exported `proxyAwareFetch` helper that the SDK adapter shares, and the proxy agent is built once per proxy URL instead of once per request. `get_image` keeps every guard, now on node-fetch's Node stream: https-only, `image/*` content types, the `content-length` check before a byte of body is read, and the chunked read that stops and destroys the stream past 5 MB. Tests mock `node-fetch` and assert that an agent for the proxy in `HTTPS_PROXY` reaches it, and that none does when the variable is unset.
- **`create_page` property errors were 4× too big.** A record schema keeps its value schema under `additionalProperties` and has no `properties`, and a page property map is one, so slicing an error's schema to `["properties", "Tags"]` stopped at the map and the union summarizer then found nothing to collapse — both returned the whole map. The slice now descends through the record and the summary runs underneath it: a `create_page` property error drops from 5,762 to 1,323 characters, and what it returns is the union of property value shapes instead of every branch in full. (PR #45.)
- **`update_data_source`'s own example did not parse.** `notion_describe` hands `example`/`example_batch` to the model as the canonical call shape, but nothing checked them; the `update_data_source` example used `type: "status"`, which the schema (and the Notion API) rejects for new property definitions. The example now creates a `select` property, and `tests/examples.test.ts` parses every registered operation's `example` and each `exampleBatch` item against its schema so this cannot regress. (PR #79.)
- **Stale operation-count anchor.** The 2.8.0 entry's link to the README operations menu pointed at the 45-operation heading; it is now the 47-operation one.

## [2.13.0] — 2026-08-02

### Added

- **Block children are validated structurally.** Every Notion block is `{ "type": "<name>", "<name>": { ... } }`, and a `children` array that omitted the body key was previously passed straight to the API, which rejected it with a generic error. `append_blocks`, `update_block` and `create_page` now check the shape locally and reply with the specific missing key — `Block has no "paragraph" body. A block is { "type": "paragraph", "paragraph": { ... } }.` The check uses `Object.hasOwn`, so a `type` naming an inherited property (`"toString"`) is still rejected. Runtime validation only; the emitted JSON Schema is unchanged. (Thanks @gauravmm — PR #49.)
- **`NOTION_UPLOAD_ROOT`.** Confines `upload_file`'s `path` source to one directory. Unset (the default) nothing changes — a `path` source can read any file the server process can, which is worth thinking about when a model composes the path. Set it, and relative paths resolve inside it and anything landing outside is refused. Symlinks are resolved with `fs.realpath` on both sides before the check, so a link sitting inside the root cannot point out of it; a link that stays inside still works, and a missing file still fails with a plain `ENOENT`. Documented in the environment-variable table in the README. (Thanks @gauravmm — PR #51; symlink resolution and docs in PR #61.)

### Fixed

- **`$defs` bodies in `notion_describe` had no shape.** The `$defs` hoisting walked each definition body through the same rewriter it used for references, so every body matched itself and was replaced by a `$ref` to itself — `$defs.rich_text_item` was literally `{"$ref": "#/$defs/rich_text_item"}`. Any client resolving those refs looped back to the same node and never saw the shape it was meant to publish. Affected 15 definitions across 7 operations: `create_page`, `create_database`, `update_database`, `update_block`, `set_page_property`, `set_page_properties`, `batch_mixed_blocks`. (Thanks @gauravmm — PR #44.)

### Changed

- **`@hono/node-server` `1.19.14 → 2.0.12`.** A real runtime dependency in HTTP transport mode — the SDK's `StreamableHTTPServerTransport`, which `src/server/http.ts` imports, pulls `getRequestListener` from it. Clears `GHSA-frvp-7c67-39w9` (path traversal in `serve-static` on Windows); `npm audit --omit=dev` now reports zero vulnerabilities. Neither v2 breaking change affects this package: the Node floor moved to `>=20`, which `engines` already declared, and the removed `@hono/node-server/vercel` adapter is imported nowhere. The public API is unchanged. (PR #63.)
- **Every workflow installs from the lockfile.** `ci.yml`, `publish-npm.yml` and `publish-mcpb.yml` now run `npm ci` instead of `npm install`. `npm install` re-resolves the dependency graph and rewrites `package-lock.json` in place, so CI could test — and the release workflows could build and publish — a tree that differed from the reviewed lockfile, and a Dependabot pin could be undone by the resolver before a single test ran. `publish-npm.yml`'s note that `npm ci` rejected the lockfile over missing Linux-only optional native deps is stale: the committed lock carries them. In `ci.yml` the separate `npm install -g npm@latest` step is gone with it (`min-release-age` in `.npmrc` gates resolution, and `npm ci` does not resolve); `publish-npm.yml` keeps it for Trusted Publishing / OIDC provenance. (PRs #61, #62.)
- **Runtime dependency bumps:** `@modelcontextprotocol/sdk` `1.29.0 → 1.30.0` (#58), `@notionhq/client` `5.22.0 → 5.23.2` (#42), `hono` `4.12.25 → 4.12.33` (#59), `body-parser` `2.2.2 → 2.3.0` (#56), `fast-uri` `3.1.2 → 3.1.5` (#57).
- **Dev toolchain bumps:** `vitest` `4.1.9 → 4.1.10`, `vite` `8.0.16 → 8.1.3`, `rolldown` `1.0.3 → 1.1.4`, `postcss` `8.5.15 → 8.5.25` (#40, #60), `@types/node` `26.0.1 → 26.1.1` (#40, #42). The `postcss` bump closes the only high-severity advisory that was open. No runtime impact.
- **CI action bumps:** `actions/setup-node` `v6.4.0 → v7.0.0` (#39), `actions/checkout` `v7.0.0 → v7.0.1` and `docker/login-action` `v4.4.0 → v4.6.0` (#52). All pinned by commit SHA.

## [2.12.0] — 2026-07-10

### Added

- **`path` source for `upload_file`.** Upload a local file by path — the server reads the bytes directly (`fs.readFile`) instead of receiving them as base64 through the tool call. For a local stdio server the base64 path forces the whole file (≈33% larger encoded) through the MCP client and, in agent setups, the model's output; reading from disk skips that entirely. Use `source: { type: "path", path: "/abs/or/~/file.pdf" }`; a leading `~`/`~/` expands to the home directory. `filename` is now optional for a `path` source (derived from the basename) and stays required for `base64`/`url`. Content-type inference gains Markdown (`.md`, `.markdown`) and Microsoft Office formats (`.doc`, `.docx`, `.ppt`, `.pptx`, `.xls`, `.xlsx`). Purely additive — `base64` and `url` sources are unchanged. (Thanks @qch2012 — PR #38.)

## [2.11.0] — 2026-07-03

### Fixed

- **Relation properties now target a data source, not a database.** When defining a `relation` database property, the field is now `data_source_id` (was `database_id`), matching Notion's data-source model under the pinned `Notion-Version: 2026-03-11` — the old field was rejected by the API. If you were passing `database_id` inside a relation config, switch to `data_source_id` (resolve it with `list_data_sources` if needed). (Thanks @insane66613 — PR #28.)

## [2.10.1] — 2026-07-03

Distribution release — no runtime changes to the server itself.

### Added

- **Official MCP registry.** The server is published to [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io) as `io.github.awkoy/notion-mcp-server`: `server.json` manifest, `mcpName` field in package.json, and automatic registry publish (GitHub OIDC) in the npm release workflow. (#29)
- **Claude Desktop one-click extension.** Every release now attaches `notion-mcp-server.mcpb` — download, double-click, paste your Notion token; no config-file editing or Node.js required. (#30)
- **OCI registry label.** Docker images now carry `io.modelcontextprotocol.server.name`, allowing the GHCR image to be added to the MCP registry entry later. (#29)

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

- **Database views.** Six new operations for Notion database views (GitHub #18): `list_views`, `get_view`, `query_view`, `create_view`, `update_view`, `delete_view`. `query_view` runs a view's stored filters/sorts and returns hydrated rows by default (set `hydrate: false` for ordered ids only), surfacing `total_count` and `truncated`; it hides Notion's create-then-paginate query mechanics. `list_views` hydrates Notion's id-only refs to `{id, name, type}` by default. `create_view` / `update_view` reuse the `where` filter shorthand and accept a raw `configuration` for type-specific layout (calendar/board/timeline/chart/map require it; a missing config is rejected locally with a fix rather than a raw API 400). `delete_view` is destructive and honors `NOTION_READ_ONLY` / the allow/block lists. See [README → Operations menu](./README.md#operations-menu-47-ops-plus-one-alias).

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
