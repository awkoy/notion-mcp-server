# Operation access control (allowlist / blocklist)

**Issue:** #7 — Configure allowlisted operations
**Date:** 2026-06-05
**Status:** Approved for implementation

## Problem

The server exposes ~37 Notion operations through a single `notion_execute` tool. There
is currently no way to restrict which operations an agent can invoke. The most common
request (issue #7) is a **read-only** deployment, but operators also want to allow
everything *except* destructive operations. Notion integration tokens offer coarse
read/write capabilities upstream, but that is inconvenient and does not let an operator
disable, say, only deletions.

## Goal

Let operators restrict the set of executable operations via environment variables, using
both **high-level group presets** (e.g. `read`) and **low-level individual operation
names** (e.g. `get_page`). Fully backward-compatible: unset ⇒ all operations enabled.

## Non-goals

- Per-page / per-resource ACLs (Notion's own sharing model handles that).
- Runtime reconfiguration / hot reload. Config is read once at startup.
- Gating the meta tools `notion_execute` / `notion_describe` themselves — only the
  dispatched operations are gated.

## Configuration

Two optional environment variables, each a comma-separated list of **tokens**:

| Env var | Unset behavior | Meaning |
|---|---|---|
| `NOTION_ALLOWED_OPERATIONS` | all ops enabled | only these ops are enabled |
| `NOTION_BLOCKED_OPERATIONS` | nothing blocked | these ops are disabled |

A **token** is either a group-preset name or an exact operation name. Tokens are
trimmed and lowercased before matching.

**Resolution:** `enabled = (allowlist ?? ALL) \ blocklist`. The blocklist is applied
last, so **block wins on conflict** (an op in both lists is disabled).

### Group presets

Derived from operation metadata (see below), not hand-maintained lists:

| Group | Definition |
|---|---|
| `read` | every non-mutating op (`access === "read"`) |
| `write` | every mutating op (`access === "write"`) |
| `destructive` | ops that remove/hide content (`destructive === true`) |
| `pages` / `blocks` / `databases` / `data_sources` / `comments` / `users` / `files` | every op with the matching `domain` (read + write) |

**`read` members:** `search_pages`, `get_page`, `get_page_markdown`, `get_block`,
`get_block_children`, `query_database`, `list_data_sources`, `get_data_source`,
`list_comments`, `get_comment`, `list_users`, `get_user`, `get_bot_user`, `get_self`,
`list_file_uploads`, `get_file_upload`.

**`destructive` members:** `archive_page`, `trash_page`, `delete_block`,
`delete_comment`, `batch_mixed_blocks`.

> **Judgment calls (adjustable):**
> - `batch_mixed_blocks` is tagged `destructive` because it can internally delete
>   blocks; otherwise blocking `destructive` would leave a deletion hole.
> - `move_page` and `restore_page` are `write` but **not** `destructive` (they relocate
>   or recover rather than remove data).

## Operation metadata

Extend `OperationDef` (`src/operations/types.ts`):

```ts
export type OperationAccess = "read" | "write";
export type OperationDomain =
  | "pages" | "blocks" | "databases" | "data_sources"
  | "comments" | "users" | "files";

export type OperationDef<TParams = unknown, TResult = unknown> = {
  // ...existing fields...
  access: OperationAccess;       // required
  domain: OperationDomain;       // required
  destructive?: boolean;         // default false
};
```

Making `access` and `domain` **required** forces every new operation to declare its
category at compile time — the policy logic can never silently drift out of date.

All 37 registered operations get annotated accordingly.

## Policy module — `src/operations/access.ts`

Pure resolution logic plus a memoized singleton, mirroring `dispatch/rate-limit.ts`:

```ts
export const ALLOWED_ENV_VAR = "NOTION_ALLOWED_OPERATIONS";
export const BLOCKED_ENV_VAR = "NOTION_BLOCKED_OPERATIONS";

isOperationAllowed(name: string): boolean
enabledOperationNames(): OperationName[]
enabledOperations(): OperationDef[]
accessSummary(): { enabled: number; total: number; allow: string; block: string }
configureOperationAccess(): void   // re-read env; used by tests (cf. configureRateLimiter)
```

- The enabled set is computed lazily on first use (after `initOperations` has populated
  the registry) and memoized; `configureOperationAccess()` recomputes it.
- Token expansion: a group token expands to its members; an op token maps to itself; an
  **unknown token** logs a `console.error` warning and is ignored.
- **Fail-closed guard:** if `NOTION_ALLOWED_OPERATIONS` is set but resolves to zero
  valid tokens (e.g. all typos), enable **nothing** and log a prominent error naming the
  bad tokens. A security control must never silently fall open on a misconfigured
  allowlist.

## Integration points ("hide everywhere")

1. **`dispatch()`** (`src/dispatch/index.ts`): after `getOperation`, if the op exists but
   `!isOperationAllowed(name)`, return
   `{ ok:false, error:{ code:"operation_not_allowed", message, fix } }` — distinct from
   `unknown_operation`.
2. **`notion_describe`** handler (`src/tools/index.ts`): same guard before describing.
3. **Advertised menus** filtered to enabled ops only, so the agent never sees ops it
   cannot run:
   - `unknownOperationError.fix` and `notion_describe`'s unknown-op `fix` →
     `enabledOperationNames()`.
   - `renderOperationsIndex()` (the `notion://operations` resource) → `enabledOperations()`.
4. **Startup log** (alongside auth / rate-limit lines): one stderr line, e.g.
   `Operation access: 16/37 enabled (allow=read; block=none)`.

## Error shape

```json
{ "ok": false, "error": {
  "code": "operation_not_allowed",
  "message": "Operation \"trash_page\" is disabled by server configuration.",
  "fix": "Enabled operations: get_page, search_pages, ..."
}}
```

## Testing — `tests/operation-access.test.ts`

Pure-resolver and integration cases:

- unset ⇒ all 37 enabled
- `allow=read` ⇒ exactly the read set enabled
- `allow=read,append_blocks` ⇒ read set plus `append_blocks`
- `block=destructive` (allow unset) ⇒ all minus destructive members
- `allow=write` + `block=delete_block` ⇒ write set minus `delete_block`
- op in both allow and block ⇒ blocked (block wins)
- invalid token in allow ⇒ warned + ignored; valid tokens still apply
- allow set with **only** invalid tokens ⇒ fail closed (0 enabled)
- case-insensitive + whitespace-tolerant tokens
- dispatch integration: disabled op ⇒ `operation_not_allowed`; enabled op runs normally
- `notion_describe` of a disabled op ⇒ `operation_not_allowed`
- `renderOperationsIndex()` excludes disabled ops

Plus update `tests/registry.test.ts` if metadata assertions are useful.

## Documentation

- Add `NOTION_ALLOWED_OPERATIONS` and `NOTION_BLOCKED_OPERATIONS` rows to the README
  env-var table.
- Add a short "Restricting operations" section leading with the issue's read-only use
  case (now `NOTION_ALLOWED_OPERATIONS=read`), the group list, and the precedence rule.

## Known limitations (per-operation, not per-parameter)

Access control gates whole operations, not individual parameters. Consequences,
surfaced during code review and accepted for this version:

- A few `write` operations can remove content via a parameter rather than being
  dedicated removal ops: `update_database` / `update_data_source` accept `in_trash` /
  `archived`, and `update_page_markdown` (replace mode) can drop a page body. They are
  **not** tagged `destructive`, because doing so would over-block benign metadata/schema
  updates. Blocking `destructive` therefore does not disable them. The airtight lockdown
  is the `read` allowlist, which excludes all writes — and that is the issue's primary
  use case. Documented in the README.
- MCP prompts may name disabled operations in their rendered text. This is not an
  execution bypass (dispatch still rejects the op), only a discoverability wrinkle.
  Gating prompt registration is deferred (it would require per-prompt op metadata).

## Backward compatibility

Both env vars unset ⇒ identical behavior to today. The new `OperationDef` fields are
additive; existing external callers of the dispatch path are unaffected.
