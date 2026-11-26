import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  NotionWebhookInbox, parseWebhookConfiguration, verifyWebhookBytes,
  type NotionWebhookConfig,
} from "../src/server/notion-webhook-ingest.js";
import { parseHttpConfig } from "../src/config/http.js";

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => ({ users: { me: async () => ({ id: "test-bot" }) } }),
}));
import { initOperations } from "../src/operations/index.js";
import { startHttp } from "../src/server/http.js";

const route = "test_webhook_route_opaque_1234567890";
const subscriptionId = "22222222-2222-4222-8222-222222222222";
const integrationId = "33333333-3333-4333-8333-333333333333";
const workspaceId = "44444444-4444-4444-8444-444444444444";
const token = "synthetic-hmac-verification-token";
const accountId = "test-account-profile-1";
const apiVersion = "2026-03-11";
let dir: string;
let config: NotionWebhookConfig;

function event(id: string, type = "page.created", changes: Record<string, unknown> = {}) {
  return JSON.stringify({
    id, type, timestamp: "2026-11-26T12:00:00.000Z",
    subscription_id: subscriptionId, integration_id: integrationId,
    workspace_id: workspaceId, api_version: apiVersion, attempt_number: 1,
    entity: { type: "page", id: "55555555-5555-4555-8555-555555555555" },
    ...changes,
  });
}
function signature(raw: string, key = token) {
  return "sha256=" + createHmac("sha256", key).update(Buffer.from(raw)).digest("hex");
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sc-notion-webhook-"));
  config = {
    ledgerPath: join(dir, "receipts.jsonl"),
    bindings: [{
      route, subscriptionId, integrationId, workspaceId, accountId, apiVersion,
      verificationToken: token,
    }],
  };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("signed Notion webhook ingestion", () => {
  it("is disabled without an explicit binding and rejects duplicate subscriptions", () => {
    expect(parseWebhookConfiguration({})).toBeUndefined();
    expect(parseWebhookConfiguration({
      NOTION_WEBHOOK_CONFIG_JSON: JSON.stringify(config),
    })).toEqual(config);
    expect(() => parseWebhookConfiguration({
      NOTION_WEBHOOK_CONFIG_JSON: JSON.stringify({
        ...config, bindings: [...config.bindings, config.bindings[0]],
      }),
    })).toThrow(/duplicate/);
  });

  it("rejects tampered raw bytes, wrong key and unknown route before parsing", async () => {
    const inbox = await NotionWebhookInbox.open(config);
    try {
      const raw = event("valid-1");
      expect(verifyWebhookBytes(Buffer.from(raw), signature(raw), token)).toBe(true);
      expect(verifyWebhookBytes(Buffer.from(raw + " "), signature(raw), token)).toBe(false);
      expect(await inbox.accept(route, Buffer.from(raw + " "), signature(raw)))
        .toMatchObject({ status: 403 });
      expect(await inbox.accept(route, Buffer.from(raw), signature(raw, "wrong")))
        .toMatchObject({ status: 403 });
      expect(await inbox.accept("missing-binding-route-123456789012", Buffer.from(raw), signature(raw)))
        .toMatchObject({ status: 404 });
      expect(await readFile(config.ledgerPath, "utf8")).toBe("");
    } finally { await inbox.close(); }
  });

  it("rejects mismatched workspace, integration and subscription", async () => {
    const inbox = await NotionWebhookInbox.open(config);
    try {
      for (const changes of [
        { workspace_id: "wrong" }, { integration_id: "wrong" },
        { subscription_id: "wrong" },
      ]) {
        const raw = event("bad-scope", "page.created", changes);
        expect(await inbox.accept(route, Buffer.from(raw), signature(raw)))
          .toMatchObject({ status: 403 });
      }
      const wrongVersion = event("bad-version", "page.created", {
        api_version: "2022-06-28",
      });
      expect(await inbox.accept(route, Buffer.from(wrongVersion), signature(wrongVersion)))
        .toMatchObject({ status: 422 });
      const raw = event("bad-type", "comment.created");
      expect(await inbox.accept(route, Buffer.from(raw), signature(raw)))
        .toMatchObject({ status: 422 });
      expect(await readFile(config.ledgerPath, "utf8")).toBe("");
    } finally { await inbox.close(); }
  });

  it("durably deduplicates signed receipt IDs across a process restart", async () => {
    const raw = event("durable-1");
    const inbox = await NotionWebhookInbox.open(config);
    expect(await inbox.accept(route, Buffer.from(raw), signature(raw)))
      .toMatchObject({ status: 202 });
    expect(await inbox.accept(route, Buffer.from(raw), signature(raw)))
      .toMatchObject({ status: 200 });
    await inbox.close();
    const next = await NotionWebhookInbox.open(config);
    try {
      expect(await next.accept(route, Buffer.from(raw), signature(raw)))
        .toMatchObject({ status: 200 });
      const lines = (await readFile(config.ledgerPath, "utf8")).trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        id: "durable-1", account_id: accountId, subscription_id: subscriptionId,
        state: "pending_refetch",
      });
      expect(lines[0]).not.toContain(token);
    } finally { await next.close(); }
  });

  it("holds permission changes pending same-account refetch and tolerates out-of-order deliveries", async () => {
    const inbox = await NotionWebhookInbox.open(config);
    try {
      const later = event("later", "page.permissions_updated", {
        timestamp: "2026-11-26T12:01:00.000Z",
      });
      const earlier = event("earlier", "page.properties_updated", {
        timestamp: "2026-11-26T12:00:00.000Z",
      });
      expect(await inbox.accept(route, Buffer.from(later), signature(later)))
        .toMatchObject({ status: 202 });
      expect(await inbox.accept(route, Buffer.from(earlier), signature(earlier)))
        .toMatchObject({ status: 202 });
      const entries = (await readFile(config.ledgerPath, "utf8")).trim()
        .split("\n").map((line) => JSON.parse(line));
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        type: "page.permissions_updated", state: "pending_refetch", account_id: accountId,
      });
      expect(entries[0]).not.toHaveProperty("public_url");
    } finally { await inbox.close(); }
  });

  it("refuses to start with a partial or corrupt durable ledger", async () => {
    await writeFile(config.ledgerPath, '{"id":"broken"', "utf8");
    await expect(NotionWebhookInbox.open(config)).rejects.toThrow(/reconciliation/);
  });

  it("captures the one-time subscription challenge privately without responding with the token", async () => {
    const bootstrapFile = join(dir, "verification-token.private");
    const bootstrap: NotionWebhookConfig = {
      ...config, bindings: [{ ...config.bindings[0], verificationToken: undefined, bootstrapFile }],
    };
    const inbox = await NotionWebhookInbox.open(bootstrap);
    try {
      const raw = Buffer.from(JSON.stringify({ verification_token: "synthetic-challenge-value" }));
      const first = await inbox.accept(route, raw);
      expect(first).toMatchObject({ status: 202 });
      expect(JSON.stringify(first)).not.toContain("synthetic-challenge-value");
      expect(await readFile(bootstrapFile, "utf8")).toBe("synthetic-challenge-value");
      expect(await inbox.accept(route, raw)).toMatchObject({ status: 409 });
    } finally { await inbox.close(); }
  });

  it("uses the existing HTTP listener, without opening the MCP route to unsigned webhooks", async () => {
    await initOperations();
    const settings = parseHttpConfig({
      MCP_TRANSPORT: "http", HOST: "127.0.0.1", PORT: "0",
      NOTION_WEBHOOK_CONFIG_JSON: JSON.stringify(config),
    });
    const server = await startHttp(settings);
    const url = "http://127.0.0.1:" + server.port + "/webhooks/notion/" + route;
    try {
      const raw = event("http-signed-1", "page.permissions_updated");
      const denied = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, body: raw,
      });
      expect(denied.status).toBe(403);
      const accepted = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notion-signature": signature(raw) },
        body: raw,
      });
      expect(accepted.status).toBe(202);
      const duplicate = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notion-signature": signature(raw) },
        body: raw,
      });
      expect(duplicate.status).toBe(200);
      expect((await fetch("http://127.0.0.1:" + server.port + "/health")).status).toBe(200);
    } finally { await server.close(); }
  });
});
