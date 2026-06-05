# Operation Access Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators restrict which Notion operations are executable via `NOTION_ALLOWED_OPERATIONS` / `NOTION_BLOCKED_OPERATIONS`, using group presets and individual op names.

**Architecture:** Each `OperationDef` declares `access`/`domain`/`destructive` metadata. A pure resolver in `src/operations/access.ts` turns the two env vars + that metadata into an "enabled" set, memoized in a singleton (mirroring `dispatch/rate-limit.ts`). `dispatch()` and `notion_describe` consult it; advertised menus (`notion://operations`, error `fix` lists) only show enabled ops.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Vitest, MCP SDK.

---

## File Structure

- **Modify** `src/operations/types.ts` — add `OperationAccess`, `OperationDomain`, and the three new `OperationDef` fields.
- **Modify** `src/operations/{pages,blocks,databases,data-sources,comments,users,files}.ts` — annotate all 37 `register({...})` calls.
- **Create** `src/operations/access.ts` — pure resolver + memoized singleton + error builder.
- **Modify** `src/dispatch/index.ts` — gate dispatch; route disabled ops to `operation_not_allowed`; advertise enabled ops in unknown-op `fix`.
- **Modify** `src/tools/index.ts` — gate `notion_describe`; filter `renderOperationsIndex`; advertise enabled ops; log access summary at startup.
- **Create** `tests/operation-access.test.ts` — resolver + integration tests.
- **Modify** `tests/dispatch.test.ts`, `tests/rate-limit.test.ts` — add required metadata to fake `OperationDef`s so they compile.
- **Modify** `README.md` — env-var rows + "Restricting operations" section.

---

### Task 1: Operation metadata fields

**Files:**
- Modify: `src/operations/types.ts`

- [ ] **Step 1: Add the metadata types and fields**

In `src/operations/types.ts`, add above `OperationDef`:

```ts
export type OperationAccess = "read" | "write";

export type OperationDomain =
  | "pages"
  | "blocks"
  | "databases"
  | "data_sources"
  | "comments"
  | "users"
  | "files";
```

Then add three fields to the `OperationDef` type (after `batchable`):

```ts
export type OperationDef<TParams = unknown, TResult = unknown> = {
  name: OperationName;
  description: string;
  schema: ZodType<TParams>;
  handler: (params: TParams) => Promise<OperationResult<TResult>>;
  batchable: boolean;
  /** Whether the operation mutates Notion state. `read` ops are side-effect free. */
  access: OperationAccess;
  /** The Notion resource family this operation belongs to. */
  domain: OperationDomain;
  /** Removes or hides content (trash/archive/delete). Defaults to false. */
  destructive?: boolean;
  example: unknown;
  exampleBatch?: unknown;
  rollback?: RollbackFn;
};
```

- [ ] **Step 2: Verify it fails to compile (the 37 ops + fake test defs now lack required fields)**

Run: `npx tsc --noEmit`
Expected: many errors of the form `Property 'access' is missing in type ...` across the operation files and `tests/dispatch.test.ts` / `tests/rate-limit.test.ts`. This confirms the fields are required.

- [ ] **Step 3: Commit the type change (compile errors expected until Task 2)**

```bash
git add src/operations/types.ts
git commit -m "feat(operations): add access/domain/destructive metadata to OperationDef"
```

---

### Task 2: Annotate all 37 operations

**Files:**
- Modify: `src/operations/pages.ts`, `blocks.ts`, `databases.ts`, `data-sources.ts`, `comments.ts`, `users.ts`, `files.ts`

Add `access`, `domain`, and (where noted) `destructive: true` to each `register({...})` call, placed right after the `batchable:` line. Mapping:

**pages.ts**
| op | access | domain | destructive |
|---|---|---|---|
| create_page | write | pages | |
| set_page_title | write | pages | |
| set_page_property | write | pages | |
| set_page_properties | write | pages | |
| archive_page | write | pages | ✅ |
| trash_page | write | pages | ✅ |
| restore_page | write | pages | |
| search_pages | read | pages | |
| get_page | read | pages | |
| get_page_markdown | read | pages | |
| move_page | write | pages | |
| update_page_markdown | write | pages | |

**blocks.ts**
| op | access | domain | destructive |
|---|---|---|---|
| append_blocks | write | blocks | |
| get_block | read | blocks | |
| get_block_children | read | blocks | |
| update_block | write | blocks | |
| delete_block | write | blocks | ✅ |
| batch_mixed_blocks | write | blocks | ✅ |

**databases.ts**
| op | access | domain | destructive |
|---|---|---|---|
| create_database | write | databases | |
| query_database | read | databases | |
| update_database | write | databases | |

**data-sources.ts**
| op | access | domain | destructive |
|---|---|---|---|
| list_data_sources | read | data_sources | |
| get_data_source | read | data_sources | |
| update_data_source | write | data_sources | |

**comments.ts**
| op | access | domain | destructive |
|---|---|---|---|
| list_comments | read | comments | |
| add_page_comment | write | comments | |
| add_discussion_comment | write | comments | |
| get_comment | read | comments | |
| update_comment | write | comments | |
| delete_comment | write | comments | ✅ |

**users.ts**
| op | access | domain | destructive |
|---|---|---|---|
| list_users | read | users | |
| get_user | read | users | |
| get_bot_user | read | users | |
| get_self | read | users | |

**files.ts**
| op | access | domain | destructive |
|---|---|---|---|
| upload_file | write | files | |
| list_file_uploads | read | files | |
| get_file_upload | read | files | |

Example (pages.ts `archive_page`):

```ts
register({
  name: "archive_page",
  description: "Move a page to trash. Reversible via restore_page. Alias: trash_page.",
  batchable: true,
  access: "write",
  domain: "pages",
  destructive: true,
  schema: PageIdParams,
  ...
```

- [ ] **Step 1: Annotate every register() call per the tables above**

- [ ] **Step 2: Verify the operation files compile**

Run: `npx tsc --noEmit`
Expected: the only remaining errors are in `tests/dispatch.test.ts` and `tests/rate-limit.test.ts` (fixed in Task 6). No errors under `src/`.

- [ ] **Step 3: Commit**

```bash
git add src/operations/*.ts
git commit -m "feat(operations): categorize all 37 operations with access/domain/destructive"
```

---

### Task 3: Pure resolver + singleton (`src/operations/access.ts`)

**Files:**
- Create: `src/operations/access.ts`
- Test: `tests/operation-access.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Create `tests/operation-access.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveEnabled, type OpMeta } from "../src/operations/access.js";

const OPS: OpMeta[] = [
  { name: "get_page", access: "read", domain: "pages" },
  { name: "search_pages", access: "read", domain: "pages" },
  { name: "create_page", access: "write", domain: "pages" },
  { name: "trash_page", access: "write", domain: "pages", destructive: true },
  { name: "delete_block", access: "write", domain: "blocks", destructive: true },
  { name: "list_comments", access: "read", domain: "comments" },
  { name: "add_page_comment", access: "write", domain: "comments" },
  { name: "list_users", access: "read", domain: "users" },
  { name: "upload_file", access: "write", domain: "files" },
];

const names = (s: Set<string>) => [...s].sort();

describe("resolveEnabled", () => {
  it("enables all ops when allowlist is unset", () => {
    const r = resolveEnabled(OPS, undefined, undefined);
    expect(r.enabled.size).toBe(OPS.length);
    expect(r.failedClosed).toBe(false);
  });

  it("treats an empty/whitespace allowlist as unset", () => {
    expect(resolveEnabled(OPS, "  ", undefined).enabled.size).toBe(OPS.length);
  });

  it("expands the read group", () => {
    const r = resolveEnabled(OPS, "read", undefined);
    expect(names(r.enabled)).toEqual(
      ["get_page", "search_pages", "list_comments", "list_users"].sort()
    );
  });

  it("unions a group token with an individual op token", () => {
    const r = resolveEnabled(OPS, "read,create_page", undefined);
    expect(r.enabled.has("create_page")).toBe(true);
    expect(r.enabled.has("get_page")).toBe(true);
    expect(r.enabled.has("trash_page")).toBe(false);
  });

  it("blocklist-only removes the destructive group from the full set", () => {
    const r = resolveEnabled(OPS, undefined, "destructive");
    expect(r.enabled.has("trash_page")).toBe(false);
    expect(r.enabled.has("delete_block")).toBe(false);
    expect(r.enabled.has("get_page")).toBe(true);
  });

  it("applies blocklist after allowlist (block wins on conflict)", () => {
    const r = resolveEnabled(OPS, "write", "delete_block");
    expect(r.enabled.has("create_page")).toBe(true);
    expect(r.enabled.has("delete_block")).toBe(false);
    expect(r.enabled.has("get_page")).toBe(false);
  });

  it("expands domain groups (comments)", () => {
    const r = resolveEnabled(OPS, "comments", undefined);
    expect(names(r.enabled)).toEqual(["add_page_comment", "list_comments"].sort());
  });

  it("is case- and whitespace-insensitive", () => {
    const r = resolveEnabled(OPS, " READ , Create_Page ", undefined);
    expect(r.enabled.has("get_page")).toBe(true);
    expect(r.enabled.has("create_page")).toBe(true);
  });

  it("warns on and ignores unknown tokens but keeps valid ones", () => {
    const r = resolveEnabled(OPS, "read,bogus_token", undefined);
    expect(r.enabled.has("get_page")).toBe(true);
    expect(r.warnings.some((w) => w.includes("bogus_token"))).toBe(true);
  });

  it("fails closed when the allowlist resolves to zero valid tokens", () => {
    const r = resolveEnabled(OPS, "nope,alsobad", undefined);
    expect(r.enabled.size).toBe(0);
    expect(r.failedClosed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/operation-access.test.ts`
Expected: FAIL — cannot import `resolveEnabled` from `access.js`.

- [ ] **Step 3: Implement `src/operations/access.ts`**

```ts
import { listOperations } from "./registry.js";
import type { OperationAccess, OperationDomain, OperationError, OperationName } from "./types.js";

export const ALLOWED_ENV_VAR = "NOTION_ALLOWED_OPERATIONS";
export const BLOCKED_ENV_VAR = "NOTION_BLOCKED_OPERATIONS";

/** Minimal shape the resolver needs — decoupled from the full OperationDef for testability. */
export type OpMeta = {
  name: string;
  access: OperationAccess;
  domain: OperationDomain;
  destructive?: boolean;
};

const GROUP_TOKENS = new Set([
  "read",
  "write",
  "destructive",
  "comments",
  "users",
  "files",
]);

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Expand a single token to op names, or null if the token matches no group and no op. */
function expandToken(token: string, ops: OpMeta[]): string[] | null {
  switch (token) {
    case "read":
      return ops.filter((o) => o.access === "read").map((o) => o.name);
    case "write":
      return ops.filter((o) => o.access === "write").map((o) => o.name);
    case "destructive":
      return ops.filter((o) => o.destructive === true).map((o) => o.name);
    case "comments":
    case "users":
    case "files":
      return ops.filter((o) => o.domain === token).map((o) => o.name);
    default:
      return ops.some((o) => o.name === token) ? [token] : null;
  }
}

export type ResolveResult = {
  enabled: Set<string>;
  warnings: string[];
  failedClosed: boolean;
};

/** Pure resolver: (ops, allow, block) -> enabled set. No env / registry access. */
export function resolveEnabled(
  ops: OpMeta[],
  allowEnv: string | undefined,
  blockEnv: string | undefined
): ResolveResult {
  const warnings: string[] = [];

  const expand = (tokens: string[], label: string): Set<string> => {
    const set = new Set<string>();
    for (const token of tokens) {
      if (!GROUP_TOKENS.has(token) && !ops.some((o) => o.name === token)) {
        warnings.push(`Unknown ${label} token: "${token}" (ignored)`);
        continue;
      }
      const names = expandToken(token, ops);
      if (names) names.forEach((n) => set.add(n));
    }
    return set;
  };

  const allowSpecified = allowEnv !== undefined && allowEnv.trim() !== "";
  const allowTokens = parseList(allowEnv);
  const blockTokens = parseList(blockEnv);

  const allowSet = allowSpecified
    ? expand(allowTokens, ALLOWED_ENV_VAR)
    : new Set(ops.map((o) => o.name));
  const blockSet = expand(blockTokens, BLOCKED_ENV_VAR);

  const enabled = new Set<string>([...allowSet].filter((n) => !blockSet.has(n)));
  const failedClosed = allowSpecified && allowSet.size === 0;

  return { enabled, warnings, failedClosed };
}

// ── Memoized singleton over the real registry + process.env ────────────────

let cache: ResolveResult | null = null;

function compute(): ResolveResult {
  const ops: OpMeta[] = listOperations().map((o) => ({
    name: o.name,
    access: o.access,
    domain: o.domain,
    destructive: o.destructive,
  }));
  const result = resolveEnabled(
    ops,
    process.env[ALLOWED_ENV_VAR],
    process.env[BLOCKED_ENV_VAR]
  );
  for (const w of result.warnings) {
    console.error(`[operation-access] ${w}`);
  }
  if (result.failedClosed) {
    console.error(
      `[operation-access] ${ALLOWED_ENV_VAR} resolved to zero valid operations — ALL operations are disabled. Check for typos.`
    );
  }
  return result;
}

function get(): ResolveResult {
  if (!cache) cache = compute();
  return cache;
}

export function isOperationAllowed(name: string): boolean {
  return get().enabled.has(name);
}

/** Enabled op names in registry order. */
export function enabledOperationNames(): OperationName[] {
  const { enabled } = get();
  return listOperations()
    .map((o) => o.name)
    .filter((n) => enabled.has(n));
}

export function enabledOperations() {
  const { enabled } = get();
  return listOperations().filter((o) => enabled.has(o.name));
}

export function accessSummary(): { enabled: number; total: number; allow: string; block: string } {
  return {
    enabled: get().enabled.size,
    total: listOperations().length,
    allow: process.env[ALLOWED_ENV_VAR]?.trim() || "(all)",
    block: process.env[BLOCKED_ENV_VAR]?.trim() || "(none)",
  };
}

/** Clear the memoized result so the next call re-reads env. Used by tests. */
export function configureOperationAccess(): void {
  cache = null;
}

export function operationNotAllowedError(name: string): OperationError {
  return {
    code: "operation_not_allowed",
    message: `Operation "${name}" is disabled by server configuration.`,
    fix: `Enabled operations: ${enabledOperationNames().join(", ")}`,
  };
}
```

- [ ] **Step 4: Run resolver tests to verify they pass**

Run: `npx vitest run tests/operation-access.test.ts`
Expected: PASS (10 resolver tests).

- [ ] **Step 5: Commit**

```bash
git add src/operations/access.ts tests/operation-access.test.ts
git commit -m "feat(operations): add operation-access resolver and singleton"
```

---

### Task 4: Gate `dispatch()`

**Files:**
- Modify: `src/dispatch/index.ts`
- Test: `tests/operation-access.test.ts` (append integration cases)

- [ ] **Step 1: Append failing dispatch-integration tests**

Add to `tests/operation-access.test.ts`:

```ts
import { register } from "../src/operations/registry.js";
import type { OperationDef, OperationName } from "../src/operations/types.js";
import { dispatch } from "../src/dispatch/index.js";
import { configureOperationAccess } from "../src/operations/access.js";
import { z } from "zod";

describe("dispatch access gating", () => {
  const ALLOWED = "get_user" as OperationName; // reuse union names; real ops not imported here
  const BLOCKED = "search_pages" as OperationName;

  function fakeDef(name: OperationName): OperationDef {
    return {
      name,
      description: `fake ${name}`,
      batchable: false,
      access: "read",
      domain: "pages",
      schema: z.object({ id: z.string() }),
      example: { id: "x" },
      handler: async ({ id }) => ({ ok: true, data: { echo: id } }),
    } as OperationDef;
  }

  it("runs an allowed op and blocks a disabled op", async () => {
    register(fakeDef(ALLOWED));
    register(fakeDef(BLOCKED));
    process.env.NOTION_BLOCKED_OPERATIONS = "search_pages";
    configureOperationAccess();

    const ok = await dispatch(ALLOWED, { id: "hi" });
    expect("ok" in ok && ok.ok).toBe(true);

    const denied = await dispatch(BLOCKED, { id: "hi" });
    expect(denied).toMatchObject({ ok: false, error: { code: "operation_not_allowed" } });

    delete process.env.NOTION_BLOCKED_OPERATIONS;
    configureOperationAccess();
  });
});
```

- [ ] **Step 2: Run to verify the denied case fails**

Run: `npx vitest run tests/operation-access.test.ts -t "dispatch access gating"`
Expected: FAIL — disabled op currently runs and returns ok.

- [ ] **Step 3: Add the gate to `dispatch()`**

In `src/dispatch/index.ts`, add the import:

```ts
import { isOperationAllowed, operationNotAllowedError, enabledOperationNames } from "../operations/access.js";
```

In `dispatch()`, right after the `if (!def) { ... }` block:

```ts
  if (!isOperationAllowed(operationName)) {
    return { ok: false, error: operationNotAllowedError(operationName) };
  }
```

And change `unknownOperationError`'s `fix` to advertise only enabled ops:

```ts
function unknownOperationError(name: string): OperationError {
  return {
    code: "unknown_operation",
    message: `Unknown operation: "${name}". Use notion_describe with a valid operation name, or check the notion://operations resource for the full list.`,
    fix: `Available operations: ${enabledOperationNames().join(", ")}`,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/operation-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dispatch/index.ts tests/operation-access.test.ts
git commit -m "feat(dispatch): gate operations via access policy"
```

---

### Task 5: Gate `notion_describe`, filter the menu, log at startup

**Files:**
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Import the access helpers**

```ts
import { isOperationAllowed, operationNotAllowedError, enabledOperationNames, enabledOperations, accessSummary } from "../operations/access.js";
```

- [ ] **Step 2: Gate the `notion_describe` handler**

In the `notion_describe` handler, after the `if (!def) { ... }` block (and update its `fix` to use `enabledOperationNames()`), add:

```ts
      if (!isOperationAllowed(operation)) {
        return errorContent({ ok: false, error: operationNotAllowedError(operation) });
      }
```

Change the `unknown_operation` `fix` inside `notion_describe` from `operationNames().join(", ")` to `enabledOperationNames().join(", ")`.

- [ ] **Step 3: Filter `renderOperationsIndex`**

Change `for (const def of listOperations()) {` to `for (const def of enabledOperations()) {`.

- [ ] **Step 4: Log the access summary at the end of `registerAllTools()`**

After the resource registrations and `registerAllPrompts()` (i.e. at the end of `registerAllTools`), add:

```ts
  const s = accessSummary();
  console.error(
    `Operation access: ${s.enabled}/${s.total} enabled (allow=${s.allow}; block=${s.block})`
  );
```

Remove the now-unused `operationNames` / `listOperations` imports only if they are no longer referenced (verify with tsc).

- [ ] **Step 5: Type-check and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean compile under `src/`; remaining failures only in `tests/dispatch.test.ts` / `tests/rate-limit.test.ts` (fixed next).

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts
git commit -m "feat(tools): gate notion_describe and hide disabled ops from the menu"
```

---

### Task 6: Fix fake `OperationDef`s in existing tests

**Files:**
- Modify: `tests/dispatch.test.ts`, `tests/rate-limit.test.ts`

- [ ] **Step 1: Add `access`/`domain` to every fake `OperationDef` literal**

In both files, each object that is typed as `OperationDef<...>` (or registered via `register({...})`) must include `access: "read"` (or `"write"` for the batch/mutating fakes) and `domain: "pages"`. These fakes are never gated because tests run with the env vars unset (all ops enabled).

- [ ] **Step 2: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS — all test files green.

- [ ] **Step 3: Commit**

```bash
git add tests/dispatch.test.ts tests/rate-limit.test.ts
git commit -m "test: add required operation metadata to fake defs"
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add env-var rows**

In the env-var table (the v2.4 "Migration" table around the `NOTION_RATE_LIMIT` row), add:

```markdown
| `NOTION_ALLOWED_OPERATIONS` | ✅ New, optional | Comma-separated allowlist of operations or group presets (`read`, `write`, `destructive`, `comments`, `users`, `files`). Unset ⇒ all operations enabled. |
| `NOTION_BLOCKED_OPERATIONS` | ✅ New, optional | Comma-separated blocklist (same token vocabulary). Applied after the allowlist, so a blocked operation is always disabled. |
```

- [ ] **Step 2: Add a "Restricting operations" section**

```markdown
### Restricting operations

By default every operation is available. To limit what an agent can do, set
`NOTION_ALLOWED_OPERATIONS` (an allowlist) and/or `NOTION_BLOCKED_OPERATIONS`
(a blocklist). Each is a comma-separated list of **tokens**, where a token is
either a **group preset** or an exact **operation name**.

**Group presets:** `read`, `write`, `destructive`, `comments`, `users`, `files`.

Read-only deployment (the most common case):

\`\`\`json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "notion-mcp-server"],
      "env": {
        "NOTION_TOKEN": "ntn_paste_your_token_here",
        "NOTION_ALLOWED_OPERATIONS": "read"
      }
    }
  }
}
\`\`\`

Allow everything except destructive operations:

\`\`\`json
{ "env": { "NOTION_BLOCKED_OPERATIONS": "destructive" } }
\`\`\`

Mix presets and individual ops (read everything, plus append blocks and comments):

\`\`\`json
{ "env": { "NOTION_ALLOWED_OPERATIONS": "read,append_blocks,add_page_comment" } }
\`\`\`

**Rules:** tokens are case-insensitive; unknown tokens are ignored with a
warning; the blocklist wins on conflict; and if the allowlist is set but
contains no valid tokens, **all** operations are disabled (fail-closed).
Disabled operations are hidden from the `notion://operations` menu and from
`notion_describe`, and `notion_execute` rejects them with `operation_not_allowed`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document operation allowlist/blocklist"
```

---

## Self-Review

**Spec coverage:**
- Env vars + resolution + precedence → Tasks 3, 4. ✅
- Group presets derived from metadata → Tasks 1–3. ✅
- `OperationDef` metadata → Tasks 1–2. ✅
- Policy module API → Task 3. ✅
- Integration (dispatch / describe / menu / startup log) → Tasks 4–5. ✅
- Fail-closed-on-empty-allowlist → Task 3 (`failedClosed`). ✅
- Hide-everywhere → Tasks 4 (`fix` list) + 5 (`renderOperationsIndex`, describe). ✅
- Tests → Tasks 3, 4, 6. ✅
- README → Task 7. ✅

**Type consistency:** `resolveEnabled`, `isOperationAllowed`, `enabledOperationNames`, `enabledOperations`, `accessSummary`, `configureOperationAccess`, `operationNotAllowedError`, `OpMeta`, `ResolveResult` are defined in Task 3 and used with matching signatures in Tasks 4–5.

**Placeholder scan:** none — every code/step is concrete.
