import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  resolveEnabled,
  configureOperationAccess,
  type OpMeta,
} from "../src/operations/access.js";
import { register } from "../src/operations/registry.js";
import type { OperationDef, OperationName } from "../src/operations/types.js";
import { dispatch } from "../src/dispatch/index.js";

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

describe("dispatch access gating", () => {
  // Reuse names from the OperationName union; real ops are not imported here.
  const ALLOWED = "get_user" as OperationName;
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
      handler: async ({ id }: { id: string }) => ({ ok: true, data: { echo: id } }),
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
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "operation_not_allowed" },
    });

    delete process.env.NOTION_BLOCKED_OPERATIONS;
    configureOperationAccess();
  });
});
