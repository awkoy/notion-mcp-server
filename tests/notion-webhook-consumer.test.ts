import { createHmac } from "node:crypto";
import { chmod, link, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotionWebhookInbox, type NotionWebhookConfig } from "../src/server/notion-webhook-ingest.js";
import { NotionWebhookReconciler } from "../src/server/notion-webhook-consumer.js";

let dir: string;
let config: NotionWebhookConfig;
let resultPath: string;
const token = "synthetic-only-not-real";
const subscription = "22222222-2222-4222-8222-222222222222";
const route = "opaque_approved_route_123456789000";

function payload(id: string, type = "page.permissions_updated") {
  return JSON.stringify({
    id, timestamp: "2026-11-26T14:30:00.000Z",
    subscription_id: subscription,
    integration_id: "33333333-3333-4333-8333-333333333333",
    workspace_id: "44444444-4444-4444-8444-444444444444",
    api_version: "2026-03-11", type,
    entity: { type: "page", id: "55555555-5555-4555-8555-555555555555" },
  });
}
function signature(raw: string): string {
  return "sha256=" + createHmac("sha256", token).update(raw).digest("hex");
}
async function appendSigned(id: string, type?: string) {
  const inbox = await NotionWebhookInbox.open(config);
  try {
    const body = payload(id, type);
    const outcome = await inbox.accept(route, Buffer.from(body), signature(body));
    expect(outcome.status).toBe(202);
  } finally { await inbox.close(); }
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "notion-scoped-reconcile-"));
  resultPath = join(dir, "readbacks.jsonl");
  config = {
    ledgerPath: join(dir, "incoming.jsonl"),
    bindings: [{
      route, subscriptionId: subscription,
      integrationId: "33333333-3333-4333-8333-333333333333",
      workspaceId: "44444444-4444-4444-8444-444444444444",
      accountId: "sanity-managed-account", apiVersion: "2026-03-11",
      verificationToken: token,
    }],
  };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("account-bound Notion webhook reconciliation", () => {
  it("fetches latest page under exact event binding then writes minimal receipt", async () => {
    await appendSigned("event-one");
    const worker = await NotionWebhookReconciler.open(config, resultPath);
    const fetcher = vi.fn(async (binding, pageId) => {
      expect(binding.accountId).toBe("sanity-managed-account");
      expect(binding.workspaceId).toBe(config.bindings[0].workspaceId);
      return {
        id: pageId, public_url: "https://notion.site/approved-test",
        last_edited_time: "2026-11-26T14:29:00Z",
        properties: { confidential: "must-not-land-in-receipt" },
      };
    });
    try {
      const result = await worker.reconcile(fetcher);
      expect(result).toEqual({ processed: 1, duplicates: 0, blocked: 0 });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const saved = JSON.parse((await readFile(resultPath, "utf8")).trim());
      expect(saved).toMatchObject({
        id: "event-one", state: "refetched",
        account_id: "sanity-managed-account", public_url_present: true,
        page_last_edited_time: "2026-11-26T14:29:00Z",
      });
      expect(saved).not.toHaveProperty("properties");
      expect(JSON.stringify(saved)).not.toContain("approved-test");
      expect(JSON.stringify(saved)).not.toContain("confidential");
    } finally { await worker.close(); }
  });

  it("is durable and skips a delivered event after reopening", async () => {
    await appendSigned("event-two", "page.created");
    const first = await NotionWebhookReconciler.open(config, resultPath);
    await first.reconcile(async (_, id) => ({ id, public_url: null }));
    await first.close();
    const second = await NotionWebhookReconciler.open(config, resultPath);
    const reader = vi.fn();
    try {
      const result = await second.reconcile(reader);
      expect(result).toEqual({ processed: 0, duplicates: 1, blocked: 0 });
      expect(reader).not.toHaveBeenCalled();
    } finally { await second.close(); }
  });

  it("reports inaccessible without claiming a page is nonpublic", async () => {
    await appendSigned("event-three");
    const worker = await NotionWebhookReconciler.open(config, resultPath);
    try {
      const result = await worker.reconcile(async () => {
        throw Object.assign(new Error("read denied"), { status: 403 });
      });
      expect(result.processed).toBe(1);
      const saved = JSON.parse((await readFile(resultPath, "utf8")).trim());
      expect(saved.state).toBe("inaccessible");
      expect(saved).not.toHaveProperty("public_url_present");
    } finally { await worker.close(); }
  });

  it("leaves unexpected failures unresolved without blindly repeating", async () => {
    await appendSigned("event-four");
    const worker = await NotionWebhookReconciler.open(config, resultPath);
    try {
      const result = await worker.reconcile(async () => {
        throw Object.assign(new Error("network failure"), { status: 503 });
      });
      expect(result).toEqual({ processed: 0, duplicates: 0, blocked: 1 });
      expect((await readFile(resultPath, "utf8"))).toBe("");
    } finally { await worker.close(); }
  });

  it("rejects a mismatched page response before appending any receipt", async () => {
    await appendSigned("event-five");
    const worker = await NotionWebhookReconciler.open(config, resultPath);
    try {
      expect(await worker.reconcile(async () => ({ id: "unrelated-page" })))
        .toEqual({ processed: 0, duplicates: 0, blocked: 1 });
      expect((await readFile(resultPath, "utf8"))).toBe("");
    } finally { await worker.close(); }
  });

  it("rejects a source ledger hardlink before reading fabricated events", async () => {
    const forged = join(dir, "untrusted-foreign-ledger");
    const event = {
      id: "fabricated", type: "page.created",
      timestamp: "2026-11-26T14:30:00Z",
      page_id: "55555555-5555-4555-8555-555555555555",
      subscription_id: subscription,
      integration_id: config.bindings[0].integrationId,
      workspace_id: config.bindings[0].workspaceId,
      account_id: config.bindings[0].accountId,
      state: "pending_refetch",
    };
    await writeFile(forged, JSON.stringify(event) + "\n");
    await chmod(forged, 0o600);
    await link(forged, config.ledgerPath);
    const worker = await NotionWebhookReconciler.open(config, resultPath);
    const reader = vi.fn(async (_binding, pageId) => ({ id: pageId }));
    try {
      await expect(worker.reconcile(reader)).rejects.toThrow(/ledger|link|metadata|operator review/i);
      expect(reader).not.toHaveBeenCalled();
    } finally { await worker.close(); }
  });

  it("rejects a source ledger symlink before reading fabricated events", async () => {
    const target = join(dir, "untrusted-source");
    const event = {
      id: "fabricated", type: "page.created",
      timestamp: "2026-11-26T14:30:00Z",
      page_id: "55555555-5555-4555-8555-555555555555",
      subscription_id: subscription,
      integration_id: config.bindings[0].integrationId,
      workspace_id: config.bindings[0].workspaceId,
      account_id: config.bindings[0].accountId,
      state: "pending_refetch",
    };
    await writeFile(target, JSON.stringify(event) + "\n");
    await chmod(target, 0o600);
    try { await symlink(target, config.ledgerPath, "file"); }
    catch (error) {
      if (["EPERM", "ENOTSUP", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
        return; // Some Windows accounts cannot create symbolic links
      throw error;
    }
    const worker = await NotionWebhookReconciler.open(config, resultPath);
    const reader = vi.fn(async (_binding, pageId) => ({ id: pageId }));
    try {
      await expect(worker.reconcile(reader)).rejects.toThrow(/ledger|link|metadata|operator review/i);
      expect(reader).not.toHaveBeenCalled();
    } finally { await worker.close(); }
  });

  it("refuses an over-capacity incoming ledger before processing events", async () => {
    const incoming = await open(config.ledgerPath, "w");
    try { await incoming.truncate(32 * 1024 * 1024 + 1); }
    finally { await incoming.close(); }
    await chmod(config.ledgerPath, 0o600);
    const worker = await NotionWebhookReconciler.open(config, resultPath);
    const fetcher = vi.fn();
    try {
      await expect(worker.reconcile(fetcher)).rejects.toThrow(/operator review/);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await worker.close(); }
  });

  it("fails closed when the result ledger is partially written", async () => {
    await appendSigned("event-six");
    const first = await NotionWebhookReconciler.open(config, resultPath);
    await first.close();
    const f = await import("node:fs/promises");
    await f.writeFile(resultPath, '{"id":"incomplete"', "utf8");
    await expect(NotionWebhookReconciler.open(config, resultPath))
      .rejects.toThrow(/operator review/);
  });
});
