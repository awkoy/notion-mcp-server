import { listOperations } from "./registry.js";
import type {
  OperationAccess,
  OperationDef,
  OperationDomain,
  OperationError,
  OperationName,
} from "./types.js";

export const ALLOWED_ENV_VAR = "NOTION_ALLOWED_OPERATIONS";
export const BLOCKED_ENV_VAR = "NOTION_BLOCKED_OPERATIONS";
export const READ_ONLY_ENV_VAR = "NOTION_READ_ONLY";

/** Interpret common truthy strings ("true", "1", "yes", "on") as enabling read-only mode. */
export function parseReadOnly(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["true", "1", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Minimal shape the resolver needs — decoupled from the full OperationDef for testability. */
export type OpMeta = {
  name: string;
  access: OperationAccess;
  domain: OperationDomain;
  destructive?: boolean;
};

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Every domain is a valid group token. Typed so a new OperationDomain is a compile error here until added. */
const DOMAIN_GROUPS: readonly OperationDomain[] = [
  "pages",
  "blocks",
  "databases",
  "data_sources",
  "comments",
  "users",
  "files",
  "views",
];

/** Expand a single token to op names, or null if it matches no group and no op. */
function expandToken(token: string, ops: OpMeta[]): string[] | null {
  switch (token) {
    case "read":
      return ops.filter((o) => o.access === "read").map((o) => o.name);
    case "write":
      return ops.filter((o) => o.access === "write").map((o) => o.name);
    case "destructive":
      return ops.filter((o) => o.destructive === true).map((o) => o.name);
    default:
      if ((DOMAIN_GROUPS as readonly string[]).includes(token)) {
        return ops.filter((o) => o.domain === token).map((o) => o.name);
      }
      return ops.some((o) => o.name === token) ? [token] : null;
  }
}

export type ResolveResult = {
  enabled: Set<string>;
  warnings: string[];
  failedClosed: boolean;
};

/** Pure resolver: (ops, allow, block, readOnly) -> enabled set. No env / registry access. */
export function resolveEnabled(
  ops: OpMeta[],
  allowEnv: string | undefined,
  blockEnv: string | undefined,
  readOnly = false
): ResolveResult {
  const warnings: string[] = [];

  const expand = (tokens: string[], label: string): Set<string> => {
    const set = new Set<string>();
    for (const token of tokens) {
      const names = expandToken(token, ops);
      if (names === null) {
        warnings.push(`Unknown ${label} token: "${token}" (ignored)`);
        continue;
      }
      names.forEach((n) => set.add(n));
    }
    return set;
  };

  const allowSpecified = allowEnv !== undefined && allowEnv.trim() !== "";
  const allowSet = allowSpecified
    ? expand(parseList(allowEnv), ALLOWED_ENV_VAR)
    : new Set(ops.map((o) => o.name));
  const blockSet = expand(parseList(blockEnv), BLOCKED_ENV_VAR);
  // Read-only mode is sugar for "block every write op" — it layers onto the
  // blocklist so it composes with any allow/block configuration already set.
  if (readOnly) {
    for (const o of ops) if (o.access === "write") blockSet.add(o.name);
  }

  const enabled = new Set<string>([...allowSet].filter((n) => !blockSet.has(n)));
  // An allowlist that resolves to nothing executable — every token invalid, or
  // every allowed op also blocked — is a misconfiguration. Surface it loudly
  // rather than silently running the server with zero operations enabled.
  const failedClosed = allowSpecified && enabled.size === 0;

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
    process.env[BLOCKED_ENV_VAR],
    parseReadOnly(process.env[READ_ONLY_ENV_VAR])
  );
  for (const w of result.warnings) {
    console.error(`[operation-access] ${w}`);
  }
  if (result.failedClosed) {
    console.error(
      `[operation-access] ${ALLOWED_ENV_VAR} resolved to zero enabled operations — ALL operations are disabled. Check for unknown tokens, or an allowlist fully cancelled by ${BLOCKED_ENV_VAR}.`
    );
  }
  return result;
}

function get(): ResolveResult {
  if (cache) return cache;
  const result = compute();
  // Don't memoize a result derived from an unpopulated registry (e.g. if called
  // before initOperations() ran) — recompute once operations are registered.
  if (listOperations().length > 0) cache = result;
  return result;
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

export function enabledOperations(): OperationDef[] {
  const { enabled } = get();
  return listOperations().filter((o) => enabled.has(o.name));
}

export function accessSummary(): {
  enabled: number;
  total: number;
  allow: string;
  block: string;
  readOnly: boolean;
} {
  return {
    enabled: get().enabled.size,
    total: listOperations().length,
    allow: process.env[ALLOWED_ENV_VAR]?.trim() || "(all)",
    block: process.env[BLOCKED_ENV_VAR]?.trim() || "(none)",
    readOnly: parseReadOnly(process.env[READ_ONLY_ENV_VAR]),
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
