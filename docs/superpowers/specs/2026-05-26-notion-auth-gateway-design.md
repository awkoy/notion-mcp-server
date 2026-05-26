# Notion Auth Gateway Design

**Status:** Draft for review
**Date:** 2026-05-26
**Target version:** notion-mcp-server v1.2.0

## Goal

Modernize the notion-mcp-server authentication path: make **Personal Access Tokens (PATs)** the recommended way to connect, while keeping the existing internal-integration-token (`NOTION_TOKEN` env var) working unchanged. Introduce a thin `AuthProvider` abstraction so adding OAuth (v3) doesn't require touching the 18 tool handlers.

## Context & Why

### Current state

The server reads `NOTION_TOKEN` from env at module-import time in `src/services/notion.ts` and constructs a singleton `@notionhq/client` Client. 18 tool files under `src/tools/` import this singleton directly. Two schema files (`src/schema/page.ts`, `src/schema/database.ts`) call `getRootPageId()` (which reads `NOTION_PAGE_ID`) at schema-build time, and `getRootPageId()` `process.exit(1)`s if the env var is missing.

This works for the "internal integration token" auth model but has two real pain points:

1. **Per-page sharing**: integration tokens only see pages explicitly shared with the integration. Users have to go to each page in Notion's UI and click "Connect → notion-mcp-server" individually. This doesn't scale.
2. **Hostile failure modes**: missing `NOTION_PAGE_ID` kills the entire process even though most operations don't use it.

### Why PAT instead of OAuth

Users of the official Notion MCP server (`mcp.notion.com`) complain about re-authenticating every few hours. This is OAuth access-token expiry (typically ~1h) compounded by refresh-token persistence bugs on their server.

PATs **never expire** under our control, **act as the user** (so they see all pages the user can see — no per-page sharing), and require **zero code on our side** to maintain. The headline UX is "paste a token once, never see auth again."

### Why an `AuthProvider` interface (vs just swapping the env var)

We expect to add OAuth as a v3 feature for users who'd rather click "Connect" in a browser than create a PAT. Designing the abstraction now means v3 doesn't have to re-touch the 18 tool files — it only adds a new `AuthProvider` implementation. The chokepoint becomes `getClient()`.

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
                                    │  ├─ getToken()        │
                                    │  ├─ invalidate?()     │
                                    │  └─ describe()        │
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
  /** Returns a currently-valid auth token. Async so a future OAuth provider can refresh transparently. */
  getToken(): Promise<string>;

  /** Optional. Called by getClient() when an API call returns 401 so an OAuth provider can force a refresh. No-op for env-var provider. */
  invalidate?(): Promise<void>;

  /** Short label for logs, e.g. "env (NOTION_TOKEN)" or "oauth (workspace=X)". */
  describe(): string;
}

export class EnvAuthProvider implements AuthProvider {
  async getToken(): Promise<string> {
    const t = process.env.NOTION_TOKEN;
    if (!t) {
      throw new AuthError(
        "NOTION_TOKEN env var is not set. See README for setup — recommended path is a Personal Access Token from Notion settings."
      );
    }
    return t;
  }

  describe(): string {
    return "env (NOTION_TOKEN)";
  }
}

// Singleton — instantiated based on env at boot. v3 will dispatch on NOTION_AUTH_MODE.
export const authProvider: AuthProvider = new EnvAuthProvider();
```

The interface deliberately returns `string` (not a richer auth object) because the Notion SDK only consumes `auth: string`. The `invalidate()` hook is optional so simple providers don't need to implement it.

### Modified: `src/services/notion.ts`

Replace the singleton `notion` Client with `getClient()`:

```ts
import { Client } from "@notionhq/client";
import { authProvider } from "./auth.js";

let cachedClient: Client | null = null;
let cachedToken: string | null = null;

export async function getClient(): Promise<Client> {
  const token = await authProvider.getToken();
  if (token !== cachedToken) {
    cachedClient = new Client({ auth: token });
    cachedToken = token;
  }
  return cachedClient;
}

export function getRootPageId(): string | undefined {
  return process.env.NOTION_PAGE_ID;
}
```

Changes from current:
- Singleton `notion` removed (was a hardcoded Client built at import time with possibly-undefined `auth`)
- `getRootPageId()` returns `string | undefined` instead of `string`, and **no longer `process.exit`s**
- Dead `getApiToken()` deleted (currently exported but never called)

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

Today these files call `getRootPageId()` synchronously at schema-build time, with a return type of `string`. After the change:

- Both files import `getRootPageId()` which now returns `string | undefined`
- The default-parent field in the Zod schema becomes optional
- A runtime check in the corresponding tool handler emits a clear error if neither the env-var fallback nor an explicit `parent_page_id` is provided:
  > "No parent page specified. Either pass `parent_page_id` in the request, or set the `NOTION_PAGE_ID` env var as a default."

The error returns as a spec-compliant `{ isError: true, content: [{ type: "text", text: ... }] }` (already handled by `handleNotionError`).

### Modified: `src/server/index.ts`

Add optional startup validation. After `server.connect(transport)`, fire-and-forget a `users.me({})` call:

```ts
if (process.env.NOTION_DISABLE_STARTUP_CHECK !== "1") {
  getClient()
    .then((c) => c.users.me({}))
    .then((me) => {
      const who = "name" in me ? me.name : me.id;
      console.error(`Connected as ${who} via ${authProvider.describe()}`);
    })
    .catch((err) => {
      console.error(
        `Auth check failed (server still running): ${err.message}`
      );
    });
}
```

Rationale: gives users immediate feedback in the stderr stream. Doesn't crash the server — `tools/list` still works even if the token is bad, so the MCP client can surface a clearer error on first tool call.

### Modified: `README.md`

Rewritten to lead with PAT setup. New structure:

1. **Quick start with Personal Access Token (recommended)**
   - Open Notion → Settings → Connections → "Develop or manage integrations" → **Create new integration** (or, where available, the dedicated PAT creator)
   - Copy the secret token (`ntn_...` or `secret_...`)
   - For Claude Code: `claude mcp add notion -s user -e NOTION_TOKEN=ntn_xxx -- node /path/to/build/index.js`
   - (Equivalent config blocks for Cursor and Claude Desktop)
2. **Legacy: internal integration token**
   - Same token shape, but you must additionally share each page/database with the integration via Notion's UI
   - Still fully supported, zero config differences from PAT path
3. **Optional: `NOTION_PAGE_ID`**
   - Default parent for `create_page` / `create_database` when not specified per-call
   - Now optional — operations that need it return a clear error if it's unset

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
- No tool handler changes required

## Error handling

| Scenario | Behavior |
|---|---|
| `NOTION_TOKEN` env var missing at boot | Server starts. `tools/list` works. First tool call returns `{ isError: true, content: [{ type: "text", text: "NOTION_TOKEN env var is not set..." }] }`. Stderr log on startup: "Auth check failed: ..." |
| `NOTION_TOKEN` set but rejected by Notion (401) | Each tool call returns `{ isError: true, content: [...] }` with Notion's message, augmented with a hint: "Token rejected by Notion. If using a PAT, verify it hasn't been revoked. If using an integration, verify the integration is shared with the requested resource." |
| `NOTION_PAGE_ID` missing AND `create_page` / `create_database` called without explicit parent | Spec-compliant validation error returned via `isError:true`: "No parent page specified. Pass `parent_page_id` or set the NOTION_PAGE_ID env var." |
| Network error mid-call | Existing `handleNotionError` path — `isError:true` with message |
| 401 mid-call (future OAuth) | `authProvider.invalidate?.()` called, retry once with fresh token (deferred to v3) |

## Backward compatibility

Preserved as-is:

- `NOTION_TOKEN` env var name, format, semantics — accepts both PAT and integration tokens (SDK does not distinguish)
- `NOTION_PAGE_ID` env var (still respected when set; just no longer required)
- stdio transport (unchanged)
- All 5 MCP tool names (`notion_pages`, `notion_blocks`, `notion_database`, `notion_comments`, `notion_users`) and their action enums
- Tool input/output schemas, except the default-parent field becomes optional

Behavior changes (technically backward-incompatible, but only for invalid configurations):

- Server no longer `process.exit(1)`s if `NOTION_TOKEN` is missing. Returns `isError:true` per-call instead. Affects: users who relied on process-exit as a signal (likely nobody)
- Server no longer `process.exit(1)`s if `NOTION_PAGE_ID` is missing when an op needs it. Returns validation error instead. Affects: users who never set `NOTION_PAGE_ID` but used `create_page`/`create_database` (would crash before, now gets a clear error)

Internal API removal (no external impact expected):

- The exported singleton `notion` from `src/services/notion.ts` is removed. Replaced with async `getClient()`. The previous export was only consumed by `src/tools/**` files within the same package.
- `getApiToken()` removed — was exported but never called.

## Testing

Manual smoke test only — adding a unit-test framework is out of scope (separate project; was also deferred from the MCP 2025-11-25 migration).

Verification approach (run after each task in the implementation plan):

1. **Without `NOTION_TOKEN`**: server starts, stderr shows "Auth check failed", `tools/list` returns 5 tools, calling `notion_users.get_bot_user` returns `isError:true` with the "not set" message. No crash.
2. **With a dummy `NOTION_TOKEN`**: server starts, startup `users.me()` warns to stderr ("unauthorized"). Tool call returns `isError:true` with Notion's "unauthorized" message.
3. **With a real PAT** (provided manually by the user during verification): startup log shows "Connected as <name> via env (NOTION_TOKEN)". Tool calls succeed.
4. **Backward-compat with real internal-integration token**: same as #3 — both token formats route through the same code path.

The smoke-test script from the migration (`/tmp/mcp-smoke-test.mjs`) is reusable with minor tweaks.

## Out of scope

Explicitly NOT in this work:

- **OAuth implementation** — v3, separate spec. The `AuthProvider` interface accommodates it; nothing else is built.
- **Token storage / refresh logic** — only needed for OAuth.
- **Setup CLI subcommand** (Approach B from brainstorming) — deferred to v2.1 if it proves valuable.
- **Test framework** (Vitest/Jest) — separate project.
- **Retry-on-401 wrapper** — only useful for OAuth refresh; defer to v3.
- **Multi-tenant / hosted deployment** — single-user local install only.
- **Replacing the Notion SDK** with a custom client.

## Open questions (intentionally left for the plan author / implementer)

1. **Provider selection mechanism.** Should `EnvAuthProvider` be selectable via env var like `NOTION_AUTH_MODE=env|oauth`, or hardcoded as the only v2 provider? **Recommendation:** hardcoded for v2; `NOTION_AUTH_MODE` lands in v3 when there's a second implementation. YAGNI.

2. **Startup validation default.** Opt-in (`NOTION_ENABLE_STARTUP_CHECK=1`) or opt-out (`NOTION_DISABLE_STARTUP_CHECK=1`)? **Recommendation:** opt-out via the disable flag, because the positive signal "Connected as X" is high value and the failure mode (extra stderr log) is cheap.

3. **README structure.** Combine PAT and legacy integration into one "setup" section since the commands are identical, or keep them visually separate to emphasize the recommendation? **Recommendation:** visually separate. The PAT vs integration distinction is *operational* (page sharing requirement), not technical, and that distinction matters to the user.

## Version

This change ships as v1.2.0 (minor version: new feature path, no breaking changes for any *valid* existing configuration).
