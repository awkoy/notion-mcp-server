import { createHmac, timingSafeEqual } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type http from "node:http";

// SanityCloud's existing NotionAwkoy HTTP listener accepts signed events.
// No page reads or agent/workflow execution take place in the public handler.
export type NotionWebhookBinding = {
  route: string;
  subscriptionId: string;
  integrationId: string;
  workspaceId: string;
  accountId: string;
  /** Exact Notion webhook envelope API version approved for this subscription. */
  apiVersion: string;
  verificationToken?: string;
  bootstrapFile?: string;
};
export type NotionWebhookConfig = {
  ledgerPath: string;
  bindings: NotionWebhookBinding[];
};
export type NotionEventReceipt = {
  id: string;
  type: "page.created" | "page.properties_updated" | "page.permissions_updated";
  timestamp: string;
  page_id: string;
  subscription_id: string;
  integration_id: string;
  workspace_id: string;
  account_id: string;
  state: "pending_refetch";
};
type Result = { status: number; message: string };
const TYPES = new Set(["page.created", "page.properties_updated", "page.permissions_updated"]);
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RECEIPTS = 50_000;

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** No event receiver is enabled unless the managed runner supplies its config. */
export function parseWebhookConfiguration(env: NodeJS.ProcessEnv): NotionWebhookConfig | undefined {
  const source = env.NOTION_WEBHOOK_CONFIG_JSON;
  if (!source) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error("Invalid Notion webhook configuration"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid Notion webhook configuration");
  const config = parsed as Partial<NotionWebhookConfig>;
  if (!nonempty(config.ledgerPath) || !isAbsolute(config.ledgerPath) ||
      !Array.isArray(config.bindings) || config.bindings.length === 0)
    throw new Error("Invalid Notion webhook ledger or bindings");
  const routes = new Set<string>();
  const subscriptions = new Set<string>();
  for (const binding of config.bindings) {
    if (!binding || !/^[A-Za-z0-9_-]{24,96}$/.test(binding.route) ||
        !nonempty(binding.subscriptionId) || !nonempty(binding.integrationId) ||
        !nonempty(binding.workspaceId) || !nonempty(binding.accountId) ||
        !/^20\d{2}-\d{2}-\d{2}$/.test(binding.apiVersion) ||
        (!nonempty(binding.verificationToken) &&
          (!nonempty(binding.bootstrapFile) || !isAbsolute(binding.bootstrapFile))) ||
        routes.has(binding.route) || subscriptions.has(binding.subscriptionId))
      throw new Error("Invalid, duplicate, or unbound Notion webhook subscription");
    routes.add(binding.route);
    subscriptions.add(binding.subscriptionId);
  }
  return config as NotionWebhookConfig;
}

/** HMAC verification is performed against the exact received bytes. */
export function verifyWebhookBytes(raw: Buffer, signature: string | undefined, token: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = "sha256=" + createHmac("sha256", token).update(raw).digest("hex");
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Reject oversized requests without ever parsing or logging their contents. */
export async function readWebhookBytes(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error("webhook_body_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export class NotionWebhookInbox {
  private readonly bindings: Map<string, NotionWebhookBinding>;
  private readonly seen = new Set<string>();
  private pending: Promise<unknown> = Promise.resolve();
  private uncertain = false;
  private constructor(private readonly handle: FileHandle, bindings: NotionWebhookBinding[]) {
    this.bindings = new Map(bindings.map((binding) => [binding.route, binding]));
  }

  static async open(config: NotionWebhookConfig): Promise<NotionWebhookInbox> {
    if (!isAbsolute(config.ledgerPath)) throw new Error("Notion webhook ledger must be absolute");
    const handle = await open(config.ledgerPath, "a+", 0o600);
    try {
      const existing = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(existing) > 32 * 1024 * 1024 ||
          (existing !== "" && !existing.endsWith("\n")))
        throw new Error("Notion webhook ledger requires operator reconciliation");
      const inbox = new NotionWebhookInbox(handle, config.bindings);
      for (const line of existing.split("\n")) {
        if (!line) continue;
        let record: unknown;
        try { record = JSON.parse(line); } catch {
          throw new Error("Notion webhook ledger requires operator reconciliation");
        }
        const r = record as Partial<NotionEventReceipt>;
        if (!nonempty(r.id) || !nonempty(r.subscription_id))
          throw new Error("Notion webhook ledger requires operator reconciliation");
        inbox.seen.add(r.subscription_id + ":" + r.id);
      }
      if (inbox.seen.size > MAX_RECEIPTS)
        throw new Error("Notion webhook ledger capacity reached");
      return inbox;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async accept(route: string, raw: Buffer, signature?: string): Promise<Result> {
    const binding = this.bindings.get(route);
    if (!binding) return { status: 404, message: "Unknown subscription route" };
    if (!signature) return this.captureBootstrap(binding, raw);
    if (!binding.verificationToken ||
        !verifyWebhookBytes(raw, signature, binding.verificationToken))
      return { status: 403, message: "Invalid webhook signature" };

    let event: unknown;
    try { event = JSON.parse(raw.toString("utf8")); }
    catch { return { status: 400, message: "Invalid event JSON" }; }
    if (!event || typeof event !== "object" || Array.isArray(event))
      return { status: 400, message: "Invalid event envelope" };
    const obj = event as Record<string, unknown>;
    const entity = obj.entity as Record<string, unknown> | undefined;
    if (!nonempty(obj.subscription_id) || obj.subscription_id !== binding.subscriptionId ||
        obj.integration_id !== binding.integrationId || obj.workspace_id !== binding.workspaceId)
      return { status: 403, message: "Event subscription scope mismatch" };
    if (obj.api_version !== binding.apiVersion)
      return { status: 422, message: "Webhook API version mismatch" };
    if (!nonempty(obj.id) || !nonempty(obj.timestamp) ||
        !nonempty(obj.type) || entity?.type !== "page" || !nonempty(entity.id))
      return { status: 400, message: "Invalid page event" };
    if (!TYPES.has(obj.type)) return { status: 422, message: "Event type not subscribed" };

    const receipt: NotionEventReceipt = {
      id: obj.id, type: obj.type as NotionEventReceipt["type"],
      timestamp: obj.timestamp, page_id: entity.id,
      subscription_id: binding.subscriptionId,
      integration_id: binding.integrationId, workspace_id: binding.workspaceId,
      account_id: binding.accountId, state: "pending_refetch",
    };
    // Every event must be fetched later under the same bound account.
    // Permission changes NEVER imply a specific public_url state from metadata.
    return this.persist(receipt);
  }

  private async captureBootstrap(binding: NotionWebhookBinding, raw: Buffer): Promise<Result> {
    if (binding.verificationToken || !binding.bootstrapFile)
      return { status: 403, message: "Signature required" };
    let body: unknown;
    try { body = JSON.parse(raw.toString("utf8")); } catch {
      return { status: 400, message: "Invalid verification JSON" };
    }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !nonempty((body as { verification_token?: unknown }).verification_token))
      return { status: 400, message: "Invalid verification payload" };
    // One-time capture goes only to the managed runner's protected file.
    // Never return the token in a response or write it to the event ledger.
    try {
      const file = await open(binding.bootstrapFile, "wx", 0o600);
      try {
        await file.writeFile((body as { verification_token: string }).verification_token, "utf8");
        await file.sync();
      } finally { await file.close(); }
      return { status: 202, message: "Verification token captured for local operator" };
    } catch {
      return { status: 409, message: "Verification already captured or unavailable" };
    }
  }

  private persist(receipt: NotionEventReceipt): Promise<Result> {
    const task = this.pending.then(async (): Promise<Result> => {
      if (this.uncertain) return { status: 503, message: "Webhook ledger needs reconciliation" };
      const key = receipt.subscription_id + ":" + receipt.id;
      if (this.seen.has(key)) return { status: 200, message: "Duplicate already accepted" };
      if (this.seen.size >= MAX_RECEIPTS) return { status: 503, message: "Webhook ledger capacity reached" };
      try {
        await this.handle.appendFile(JSON.stringify(receipt) + "\n", "utf8");
        await this.handle.sync(); // acknowledge only after durable local receipt
        this.seen.add(key);
        return { status: 202, message: "Event persisted for scoped reconciliation" };
      } catch {
        this.uncertain = true; // unknown write outcome: no blind replay
        return { status: 503, message: "Webhook ledger write outcome unknown" };
      }
    });
    this.pending = task.then(() => undefined, () => { this.uncertain = true; });
    return task;
  }

  async close(): Promise<void> {
    await this.pending;
    await this.handle.close();
  }
}
