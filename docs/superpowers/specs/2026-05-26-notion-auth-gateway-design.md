# Notion Auth Gateway Design

**Status:** Draft for review
**Date:** 2026-05-26
**Target version:** notion-mcp-server v1.2.0

## Goal

Modernize the notion-mcp-server authentication path: make **Personal Access Tokens (PATs)** the recommended way to connect, while keeping the existing internal-integration-token (`NOTION_TOKEN` env var) working unchanged. Introduce a thin `AuthProvider` abstraction so adding OAuth (v3) doesn't require touching the 18 tool handlers.

## Context & Why

### Current state

The server reads `NOTION_TOKEN` from env at module-import time in `src/services/notion.ts` and constructs a singleton `@notionhq/client` Client. The SDK does NOT throw on construction with `auth: undefined`, so today the server boots silently when `NOTION_TOKEN` is missing and fails per-call with an opaque Notion API error.

`src/services/notion.ts` also exports `getApiToken()` which exits the process if `NOTION_TOKEN` is missing — but it is dead code (zero call sites; `grep -rn getApiToken src/` returns the definition only). The only active env-var guard is `getRootPageId()`, which `process.exit(1)`s when `NOTION_PAGE_ID` is missing AND a schema build needs it.

18 tool files under `src/tools/` import the `notion` singleton directly. Two schema files (`src/schema/page.ts`, `src/schema/database.ts`) call `getRootPageId()` at module-load time and bake its return value into Zod `.default(...)` clauses for the `parent` field.

This auth model has two real pain points:

1. **Per-page sharing**: integration tokens only see pages explicitly shared with the integration. Users have to go to each page in Notion's UI and click "Connect → notion-mcp-server" individually. This doesn't scale.
2. **Hostile failure modes**: missing `NOTION_PAGE_ID` kills the entire process at boot the moment a schema file is imported, even though most operations don't use it.

### Why PAT instead of OAuth

Users of the official Notion MCP server (`mcp.notion.com`) complain about re-authenticating every few hours. This is OAuth access-token expiry (typically ~1h) compounded by refresh-token persistence bugs on their server.

PATs **never expire** under our control, **act as the user** (so they see all pages the user can see — no per-page sharing), and require **zero code on our side** to maintain. The headline UX is "paste a token once, never see auth again."

### Why an `AuthProvider` interface (vs just swapping the env var)

We expect to add OAuth as a v3 feature for users who'd rather click "Connect" in a browser than create a PAT. Designing the abstraction now means v3 can swap in a new `AuthProvider` implementation without touching the 18 tool files **on the happy path**.

**Honest qualification:** OAuth's transparent-refresh behavior requires catching 401 responses and retrying with a refreshed token. There are two ways to implement that in v3:
- **`getClient()`-level retry** is not possible — `getClient()` returns before any API call, so it cannot intercept a 401.
- **`withClient(fn)` wrapper** at every call site catches 401, refreshes, retries — but introducing it requires a second pass over the 18 tool files.

So the truthful claim is: **v3 OAuth-without-retry costs zero tool-file changes; v3 OAuth-with-401-retry costs one mechanical refactor pass over the 18 files.** The chokepoint at `getClient()` is real for the auth-resolution path; it isn't a free pass for retry logic.

## Architecture

```
┌─────────────────────────┐         ┌──────────────────────┐
│  tool handler           │         │  src/services/        │
│  (18 files)             │ ──────► │     notion.ts         │
│                         │         │                       │
│  const c = await        │         │  getClient(): async   │
│    getClient();         │         │  ├─ asks provider     │
│  c.pages.create({...})  │         │  ├─ caches by token   │
└─────────────────────────┘         │  └─ returns Client    │
                                    └──────────┬───────────┘
                                               │
                                               ▼
                                    ┌──────────────────────┐
                                    │  src/services/        │
                                    │     auth.ts           │
                                    │                       │
                                    │  AuthProvider iface:  │
                                    │  └─ getToken()        │
                                    │                       │
                                    │  EnvAuthProvider impl │
                                    │  (v2 only impl)       │
                                    └──────────────────────┘
                                               │
                                               ▼
                                    ┌──────────────────────┐
                                    │  process.env          │
                                    │  .NOTION_TOKEN        │
                                    │  (PAT or integration) │
                                    └──────────────────────┘
```

## Components

### New file: `src/services/auth.ts`

```ts
export class AuthError extends Error {}

export interface AuthProvider {
  /** Returns a currently-valid auth token. Async so a future OAuth provider can refresh transparently before returning. */
  getToken(): Promise<string>;
}

export class EnvAuthProvider implements AuthProvider {
  async getToken(): Promise<string> {
    const t = process.env.NOTION_TOKEN;
    if (!t) {
      throw new AuthError(
        "Notion auth token is not configured. Set the NOTION_TOKEN environment variable in your MCP client config. To get a token, open Notion → Settings → My Settings → Connections → Develop or manage integrations → New integration (this generates an Internal Integration Secret), OR Settings → My Settings → Personal Access Tokens → Generate (recommended)."
      );
    }
    return t;
  }
}

// Singleton — single-user assumption. v3 multi-user OAuth would require per-request
// provider dispatch (different pattern; explicitly out of scope for v2).
export const authProvider: AuthProvider = new EnvAuthProvider();
```

**Interface design notes (per design review):**

- The interface is intentionally minimal: only `getToken()`. No `invalidate()` hook — zero v2 callers, and v3 retry-on-401 will be added alongside the retry wrapper itself.
- No `describe()` method — the one stderr log site can use a hardcoded string for the env-var provider; v3 can introduce richer telemetry then.
- The interface returns `string` (not a richer auth object) because the Notion SDK only consumes `auth: string`.

### Modified: `src/services/notion.ts`

Replace the singleton `notion` Client with `getClient()`:

```ts
import { Client } from "@notionhq/client";
import { authProvider } from "./auth.js";

let cachedClient: Client | null = null;
let cachedToken: string | null = null;

export async function getClient(): Promise<Client> {
  const token = await authProvider.getToken();
  if (token !== cachedToken || cachedClient === null) {
    const fresh = new Client({ auth: token });
    cachedClient = fresh;
    cachedToken = token;
    return fresh;
  }
  return cachedClient;
}

export function getRootPageId(): string | undefined {
  return process.env.NOTION_PAGE_ID;
}
```

**Cache semantics (per design review):** `getClient()` calls `authProvider.getToken()` on **every invocation**. In v2 this is a trivial sync env read wrapped in a Promise. In v3 OAuth, it's the freshness check that triggers a refresh if needed. The token-keyed cache only avoids reconstructing the `Client` object when the token hasn't actually changed — it's the seam OAuth needs, not v2 functionality. The `cachedClient === null` guard makes TypeScript's null-narrowing trivial.

Changes from current:
- Singleton `notion` removed (was a hardcoded Client built at import time with possibly-undefined `auth`)
- `getRootPageId()` returns `string | undefined` instead of `string`, and **no longer `process.exit`s**
- Dead `getApiToken()` deleted (currently exported but never called — sole `process.exit` guard for `NOTION_TOKEN` becomes the per-call `AuthError` thrown by `EnvAuthProvider.getToken()`)

### Modified: 18 tool files in `src/tools/`

Mechanical refactor. Each file changes:

```ts
// Before
import { notion } from "../services/notion.js";

export async function handleX(params) {
  const result = await notion.pages.create({...});
  ...
}
```

```ts
// After
import { getClient } from "../services/notion.js";

export async function handleX(params) {
  const notion = await getClient();
  const result = await notion.pages.create({...});
  ...
}
```

The local `const notion = await getClient()` at the top of each handler keeps every call site looking idiomatic. No tool needs to know about `AuthProvider`.

### Modified: `src/schema/page.ts`, `src/schema/database.ts`

These files stay **synchronous** — `getRootPageId()` is a sync env read, unchanged.

The critical fix (per design review): the schemas currently bake the env-var value into Zod via `.default({ type: "page_id", page_id: getRootPageId() })` at module-load time. If `getRootPageId()` returns `undefined`, that becomes `.default({ type: "page_id", page_id: undefined })` — Zod accepts it silently, the field passes through to the Notion API as `page_id: undefined`, and the user sees an opaque API error instead of the clear validation message we want.

The correct change:

1. **Remove the `.default(...)` clauses entirely** in `src/schema/page.ts:52` and `src/schema/database.ts:342`.
2. **Mark the `parent` field `.optional()`** in both schemas.
3. **Resolve the parent in the handler, not the schema.** In each affected handler (`createPage.ts`, `createDatabase.ts`), add at the top:

   ```ts
   const parent = params.parent ?? (process.env.NOTION_PAGE_ID
     ? { type: "page_id" as const, page_id: process.env.NOTION_PAGE_ID }
     : undefined);

   if (!parent) {
     throw new AuthError(
       "No parent page configured. Either pass `parent` in this request, or set the NOTION_PAGE_ID environment variable to a default Notion page ID. To find a page ID: open the page in Notion → Share → Copy link → the ID is the last 32 chars of the URL."
     );
   }
   ```

   The thrown `AuthError` is caught by `handleNotionError`, which already produces the spec-compliant `{ isError: true, content: [{ type: "text", text: ... }] }` shape. (Implementer note: `handleNotionError` may need a new branch for `AuthError` — verify and add if missing.)

**LLM-visible side effect (per design review):** removing the schema-level default means `tools/list` will now show `parent` as an optional field rather than one with a baked-in default. LLMs that previously omitted `parent` and relied on the env-var default being injected will now need to either pass `parent` explicitly or trust the runtime fallback. The runtime behavior is identical when `NOTION_PAGE_ID` is set — only the JSON Schema visible to the LLM changes.

### Modified: `src/server/index.ts`

Add startup validation. After `server.connect(transport)`, fire-and-forget a `users.me({})` call:

```ts
getClient()
  .then((c) => c.users.me({}))
  .then((me) => {
    const who = "name" in me && me.name ? me.name : me.id;
    console.error(`Notion auth OK — connected as ${who} (NOTION_TOKEN)`);
  })
  .catch((err) => {
    console.error(
      `Notion auth check failed (server still running): ${err.message}`
    );
  });
```

**Audience (per design review):** this is **debug telemetry**, not end-user UX feedback. Claude Code hides MCP stderr in normal operation and only surfaces it on error or in `--debug` mode. The value of the log is:
- Visible on error (where the user looks for "why isn't this working?")
- Useful for diagnosing token issues during development
- Self-documenting for anyone tail-ing logs

The server does not crash on auth failure — `tools/list` still works even if the token is bad, so the MCP client can surface a per-call error on first tool invocation. No `NOTION_DISABLE_STARTUP_CHECK` toggle (YAGNI — the check is itself optional polish; an escape hatch for it is premature).

### Modified: `README.md`

Rewritten to lead with PAT setup. **Factual corrections from design review:** Notion's PAT and Internal Integration Secret live at different UI paths — the original spec conflated them. Both produce tokens with the `ntn_` prefix (post-Sep 2024); legacy integration secrets may still appear as `secret_`.

New README structure:

**Top-of-file safety callout:**
> **Already running notion-mcp-server v1.1.x?** If your `NOTION_TOKEN` is set and tools work today, **nothing changes for you in v1.2.0**. The setup paths below are recommendations for new installs and users hitting per-page sharing pain.

**Section 1 — Quick start with Personal Access Token (recommended):**
- Open Notion → **Settings → My Settings → Personal Access Tokens** → **Generate**
- Copy the `ntn_...` token
- For Claude Code: `claude mcp add notion -s user -e NOTION_TOKEN=ntn_xxx -- node /path/to/build/index.js`
- (Equivalent config blocks for Cursor and Claude Desktop)
- **Why this is better:** the PAT acts as you, so it sees every page in your workspace automatically — no per-page sharing dance.

**Section 2 — Alternative: Internal Integration (legacy):**
- Open Notion → **Settings → Connections → Develop or manage integrations** → **New integration**
- Copy the Internal Integration Secret (`ntn_...` for new integrations; `secret_...` on older ones)
- Same `claude mcp add` command — the env var is the same
- **Important:** you must additionally open each page/database in Notion's UI and click "Connect → <your integration name>" to grant access. This is the pain point PATs eliminate.

**Section 3 — Optional: `NOTION_PAGE_ID`:**
- Default parent page for `create_page` / `create_database` when the caller doesn't pass one
- Now optional — operations that need a parent and don't get one return a clear validation error instead of crashing
- Find a page ID: open the page in Notion → Share → Copy link → the last 32 chars of the URL

**Section 4 — Troubleshooting:**
- "Per-page sharing errors" → switch to a PAT (Section 1)
- "Auth failed at startup" → check token wasn't revoked in Notion settings

## Data flow

**Boot:**

1. Node imports `src/index.ts` → loads all modules
2. `src/services/auth.ts` instantiates `EnvAuthProvider` (does NOT read env at this point — read happens lazily in `getToken()`)
3. `src/services/notion.ts` exports `getClient()` (does NOT construct a Client yet — also lazy)
4. `src/server/index.ts` boots stdio transport, fires startup `users.me()` ping (async, non-blocking)
5. Server is responsive to MCP requests immediately

**Tool call:**

1. MCP client sends `tools/call` over stdio
2. SDK routes to the appropriate handler
3. Handler calls `await getClient()`:
   - First call: `authProvider.getToken()` reads `process.env.NOTION_TOKEN` (or throws `AuthError`)
   - `new Client({ auth: token })` constructed, cached
   - Returns Client
   - Subsequent calls: returns cached Client (token hasn't changed)
4. Handler makes API call via Client
5. Response wrapped by `handleNotionError` (which produces `isError:true` shape on failure)
6. Returned to MCP client

**v3 OAuth (informative — NOT built in v2):**

- New `OAuthProvider` instantiated at boot, holds refresh token from on-disk store
- `getToken()` checks expiry, calls refresh endpoint if needed, returns fresh access token
- When `getClient()` sees the token has changed (post-refresh), constructs a new Client
- **Happy path:** no tool handler changes required
- **401-retry path:** introduces a `withClient` wrapper or SDK-level interceptor that catches 401, calls a refresh, retries once. Implementing the wrapper variant requires a mechanical refactor pass over the 18 tool files (call sites change from `await getClient()` to `withClient(c => ...)`). This is the only realistic shape for transparent refresh and is acknowledged as v3 work.

## Error handling

All errors are self-contained: the message includes the recovery action, because LLMs reading these responses don't have access to our README.

| Scenario | Behavior |
|---|---|
| `NOTION_TOKEN` env var missing | Server starts. `tools/list` works. First tool call returns `{ isError: true, content: [{ type: "text", text: "Notion auth token is not configured. Set the NOTION_TOKEN environment variable... To get a token, open Notion → Settings → My Settings → Personal Access Tokens → Generate (recommended), or Settings → Connections → Develop or manage integrations → New integration." }] }`. Stderr on startup: "Notion auth check failed (server still running): ..." |
| `NOTION_TOKEN` set but rejected by Notion (401) | Each tool call returns `{ isError: true, content: [...] }` with Notion's message, augmented with: "Notion rejected the token. If using a PAT, verify it hasn't been revoked in Notion → Settings → My Settings → Personal Access Tokens. If using an Internal Integration, also verify the integration is shared with the target page or database." |
| `NOTION_PAGE_ID` missing AND `create_page` / `create_database` called without explicit `parent` | `{ isError: true, content: [...] }` with: "No parent page configured. Either pass `parent` in this request, or set the NOTION_PAGE_ID environment variable to a default Notion page ID. To find a page ID: open the page in Notion → Share → Copy link → the ID is the last 32 chars of the URL." |
| Network error mid-call | Existing `handleNotionError` path — `isError:true` with message |
| 401 mid-call (future OAuth) | Deferred to v3 alongside the retry-on-401 wrapper. v2 just surfaces the 401 as a tool error. |

## Backward compatibility

Preserved as-is:

- `NOTION_TOKEN` env var name, format, semantics — accepts both PAT and integration tokens (SDK does not distinguish)
- `NOTION_PAGE_ID` env var (still respected when set; just no longer required)
- stdio transport (unchanged)
- All 5 MCP tool names (`notion_pages`, `notion_blocks`, `notion_database`, `notion_comments`, `notion_users`) and their action enums
- Tool input/output schemas, except the default-parent field becomes optional

Behavior changes (technically backward-incompatible, but only for invalid configurations or LLM prompt shape):

- **`NOTION_TOKEN` missing.** Today: the SDK silently constructs a Client with `auth: undefined` and tool calls fail with an opaque Notion API error. (Dead `getApiToken()` would have called `process.exit(1)` but nothing calls it.) After: `EnvAuthProvider.getToken()` throws a clear `AuthError` per-call with recovery steps; server boots cleanly. **Strict improvement.**
- **`NOTION_PAGE_ID` missing + op needs default parent.** Today: `process.exit(1)` at module-import time (the schema file calling `getRootPageId()` kills the boot). After: server boots, `create_page` / `create_database` calls without an explicit `parent` return a clear validation error. **Strict improvement.**
- **LLM-visible schema change for `parent` field.** Today: when `NOTION_PAGE_ID` is set, `tools/list` shows `parent` with a baked-in default. After: `parent` is shown as optional with no default (the env-var fallback resolves at runtime in the handler, not in the schema). LLMs that previously omitted `parent` and relied on the schema-level default work identically at runtime, but the JSON Schema descriptor they see is different. **Possible prompt-shape regression for sophisticated LLM consumers.**

Internal API removal (no external impact expected):

- The exported singleton `notion` from `src/services/notion.ts` is removed. Replaced with async `getClient()`. The previous export was only consumed by `src/tools/**` files within the same package — `package.json` exposes only the bin entry, no library `exports` field, so no external consumers exist.
- `getApiToken()` removed — was exported but never called.

## Testing

Manual smoke test only — adding a unit-test framework is out of scope (separate project; was also deferred from the MCP 2025-11-25 migration).

Verification approach (run after each task in the implementation plan):

1. **Without `NOTION_TOKEN`**: server starts, stderr shows "Auth check failed", `tools/list` returns 5 tools, calling `notion_users.get_bot_user` returns `isError:true` with the "not set" message. No crash.
2. **With a dummy `NOTION_TOKEN`**: server starts, startup `users.me()` warns to stderr ("unauthorized"). Tool call returns `isError:true` with Notion's "unauthorized" message.
3. **With a real PAT** (provided manually by the user during verification): startup log shows "Notion auth OK — connected as <name> (NOTION_TOKEN)". Tool calls succeed.
4. **Backward-compat with real internal-integration token**: same as #3 — both token formats route through the same code path.

The smoke-test script from the migration (`/tmp/mcp-smoke-test.mjs`) is reusable with minor tweaks.

## Out of scope

Explicitly NOT in this work:

- **OAuth implementation** — v3, separate spec. The `AuthProvider` interface accommodates it; nothing else is built.
- **Token storage / refresh logic** — only needed for OAuth.
- **`invalidate()` and `describe()` interface members** — speculatively in the original draft, removed per design review. v3 adds them alongside the OAuth implementation that actually uses them.
- **`NOTION_AUTH_MODE` provider-selection env var** — needed when there's a second provider implementation. YAGNI in v2.
- **`NOTION_DISABLE_STARTUP_CHECK` toggle** — escape hatch for an already-optional feature. YAGNI; add only if a real user complains.
- **Setup CLI subcommand** (Approach B from brainstorming) — deferred to v2.1 if it proves valuable.
- **Test framework** (Vitest/Jest) — separate project.
- **Retry-on-401 wrapper** — only useful for OAuth refresh; defer to v3. **Note:** introducing this in v3 WILL require a mechanical refactor pass over the 18 tool files (see "Why an `AuthProvider` interface" qualification).
- **Multi-tenant / hosted deployment** — single-user local install only. The singleton `authProvider` pattern is incompatible with per-request OAuth provider dispatch; v3 multi-user would need a different pattern.
- **Replacing the Notion SDK** with a custom client.

## Open questions (intentionally left for the plan author / implementer)

1. **`AuthError` handling in `handleNotionError`.** The current `handleNotionError` (`src/utils/error.ts`) has three branches: `APIResponseError`, generic `Error`, unknown. `AuthError extends Error` so it'll fall through the generic branch — which works (returns `isError:true` with the message), but loses the chance to add specific hints. **Decision needed at implementation time:** add a dedicated `AuthError` branch in `handleNotionError` that prefixes the message with "Notion auth failed:" for clarity, or accept the generic-branch behavior. Recommendation: add the branch — three lines of code, materially better LLM-facing error.

2. **Startup ping unhandled-rejection safety.** The fire-and-forget `getClient().then(...).catch(...)` chain catches both auth failures and the `then()` chain rejecting. Verify the `.catch` is the last link so no unhandled promise rejection can leak. Trivial to get right; flagging so the implementer doesn't omit it.

## Version

This change ships as v1.2.0 (minor version: new feature path, no breaking changes for any *valid* existing configuration).
