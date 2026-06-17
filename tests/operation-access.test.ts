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

  it("expands every domain as a group token (pages, blocks)", () => {
    expect(names(resolveEnabled(OPS, "pages", undefined).enabled)).toEqual(
      ["get_page", "search_pages", "create_page", "trash_page"].sort()
    );
    expect(resolveEnabled(OPS, "pages", undefined).warnings).toHaveLength(0);
    expect([...resolveEnabled(OPS, "blocks", undefined).enabled]).toEqual(["delete_block"]);
  });

  it("blocks a domain group (block=pages removes all page ops)", () => {
    const r = resolveEnabled(OPS, undefined, "pages");
    expect(r.enabled.has("get_page")).toBe(false);
    expect(r.enabled.has("create_page")).toBe(false);
    expect(r.enabled.has("list_users")).toBe(true);
    expect(r.warnings).toHaveLength(0);
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

  it("fails closed when the blocklist cancels out the entire allowlist", () => {
    const r = resolveEnabled(OPS, "get_page", "get_page");
    expect(r.enabled.size).toBe(0);
    expect(r.failedClosed).toBe(true);
  });

  it("read-only mode blocks every write op but keeps reads", () => {
    const r = resolveEnabled(OPS, undefined, undefined, true);
    expect(r.enabled.has("get_page")).toBe(true);
    expect(r.enabled.has("list_users")).toBe(true);
    expect(r.enabled.has("create_page")).toBe(false);
    expect(r.enabled.has("trash_page")).toBe(false);
    expect(r.enabled.has("upload_file")).toBe(false);
  });

  it("read-only mode composes with an allowlist (writes still removed)", () => {
    const r = resolveEnabled(OPS, "pages", undefined, true);
    expect(r.enabled.has("get_page")).toBe(true);
    expect(r.enabled.has("search_pages")).toBe(true);
    expect(r.enabled.has("create_page")).toBe(false);
    expect(r.enabled.has("trash_page")).toBe(false);
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

describe("NOTION_READ_ONLY env wiring", () => {
  const READ = "get_block" as OperationName;
  const WRITE = "update_block" as OperationName;

  function fakeDef(name: OperationName, access: "read" | "write"): OperationDef {
    return {
      name,
      description: `fake ${name}`,
      batchable: false,
      access,
      domain: "blocks",
      schema: z.object({ id: z.string() }),
      example: { id: "x" },
      handler: async ({ id }: { id: string }) => ({ ok: true, data: { echo: id } }),
    } as OperationDef;
  }

  it("blocks write ops and allows read ops when NOTION_READ_ONLY=true", async () => {
    register(fakeDef(READ, "read"));
    register(fakeDef(WRITE, "write"));
    process.env.NOTION_READ_ONLY = "true";
    configureOperationAccess();

    const ok = await dispatch(READ, { id: "hi" });
    expect("ok" in ok && ok.ok).toBe(true);

    const denied = await dispatch(WRITE, { id: "hi" });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "operation_not_allowed" },
    });

    delete process.env.NOTION_READ_ONLY;
    configureOperationAccess();
  });
});
