import type { FileHandle } from "node:fs/promises";
import { openPrivateLedger, readBoundedLedgerText } from "./notion-webhook-ingest.js";
import { isAbsolute } from "node:path";
import type {
  NotionEventReceipt, NotionWebhookBinding, NotionWebhookConfig,
} from "./notion-webhook-ingest.js";

/** Current page state, retrieved only through the managed account context. */
export type ScopedPage = {
  id: string;
  public_url?: string | null;
  last_edited_time?: string;
  in_trash?: boolean;
};
export type ScopedPageReader = (
  binding: NotionWebhookBinding, pageId: string
) => Promise<ScopedPage>;
export type PageReconciliation = {
  id: string;
  subscription_id: string;
  account_id: string;
  workspace_id: string;
  integration_id: string;
  page_id: string;
  event_type: NotionEventReceipt["type"];
  observed_at: string;
  state: "refetched" | "inaccessible";
  public_url_present?: boolean;
  page_last_edited_time?: string;
  page_in_trash?: boolean;
};
type Cycle = { processed: number; duplicates: number; blocked: number };

const MAX_LEDGER_BYTES = 32 * 1024 * 1024;

function readLines(data: string): unknown[] {
  if (Buffer.byteLength(data) > MAX_LEDGER_BYTES ||
      (data.length > 0 && !data.endsWith("\n"))) {
    throw new Error("Webhook reconciliation ledger requires operator review");
  }
  return data.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) as unknown; }
    catch { throw new Error("Webhook reconciliation ledger requires operator review"); }
  });
}
function keyFor(subscriptionId: string, eventId: string): string {
  return subscriptionId + ":" + eventId;
}
function isString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

/** Read-only event consumer: never assumes webhook metadata is current state. */
export class NotionWebhookReconciler {
  private readonly bySubscription: Map<string, NotionWebhookBinding>;
  private readonly completed = new Set<string>();
  private active: Promise<unknown> = Promise.resolve();
  private failedWrite = false;

  private constructor(
    private readonly config: NotionWebhookConfig,
    private readonly resultPath: string,
    private readonly file: FileHandle
  ) {
    this.bySubscription = new Map(
      config.bindings.map((item) => [item.subscriptionId, item])
    );
  }

  static async open(
    config: NotionWebhookConfig, resultPath: string
  ): Promise<NotionWebhookReconciler> {
    if (!isAbsolute(resultPath) || resultPath === config.ledgerPath)
      throw new Error("Webhook reconciliation path must be a separate absolute file");
    const file = await openPrivateLedger(resultPath);
    try {
      const consumer = new NotionWebhookReconciler(config, resultPath, file);
      const lines = readLines(await readBoundedLedgerText(file));
      for (const raw of lines) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("Webhook reconciliation ledger requires operator review");
        const entry = raw as Partial<PageReconciliation>;
        const binding = consumer.bySubscription.get(entry.subscription_id ?? "");
        if (!binding || !isString(entry.id) ||
            entry.account_id !== binding.accountId ||
            entry.workspace_id !== binding.workspaceId ||
            entry.integration_id !== binding.integrationId ||
            !isString(entry.page_id) ||
            !["refetched", "inaccessible"].includes(entry.state ?? "")) {
          throw new Error("Webhook reconciliation ledger requires operator review");
        }
        consumer.completed.add(keyFor(binding.subscriptionId, entry.id));
      }
      return consumer;
    } catch (err) {
      await file.close();
      throw err;
    }
  }

  async reconcile(
    reader: ScopedPageReader,
    maxEvents = 100
  ): Promise<Cycle> {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000)
      throw new Error("Invalid webhook reconciliation budget");
    const task = this.active.then(async () => {
      if (this.failedWrite) throw new Error("Webhook reconcile write is uncertain");
      const incomingFile = await openPrivateLedger(this.config.ledgerPath, "read");
      let incoming: unknown[];
      try { incoming = readLines(await readBoundedLedgerText(incomingFile)); }
      finally { await incomingFile.close(); }
      let processed = 0, duplicates = 0, blocked = 0;
      for (const raw of incoming) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("Webhook source ledger requires operator review");
        const event = raw as Partial<NotionEventReceipt>;
        const binding = this.bySubscription.get(event.subscription_id ?? "");
        if (!binding || !isString(event.id) || !isString(event.page_id) ||
            event.workspace_id !== binding.workspaceId ||
            event.integration_id !== binding.integrationId ||
            event.account_id !== binding.accountId ||
            event.state !== "pending_refetch") {
          throw new Error("Webhook source ledger scope mismatch");
        }
        const key = keyFor(binding.subscriptionId, event.id);
        if (this.completed.has(key)) { duplicates++; continue; }
        if (processed >= maxEvents) break;

        let page: ScopedPage | undefined;
        let state: PageReconciliation["state"] = "refetched";
        try {
          page = await reader(binding, event.page_id);
          if (!page || page.id !== event.page_id)
            throw new Error("Page readback identity mismatch");
        } catch (err) {
          const code = (err as { status?: unknown }).status;
          if (code !== 403 && code !== 404) {
            blocked++;
            break; // preserve event for operator-controlled later replay
          }
          state = "inaccessible"; // not proof the page is nonpublic
        }
        const record: PageReconciliation = {
          id: event.id,
          subscription_id: binding.subscriptionId,
          account_id: binding.accountId,
          workspace_id: binding.workspaceId,
          integration_id: binding.integrationId,
          page_id: event.page_id,
          event_type: event.type!,
          observed_at: new Date().toISOString(),
          state,
          ...(page && {
            public_url_present: typeof page.public_url === "string" &&
              page.public_url.length > 0,
            ...(page.last_edited_time
              ? { page_last_edited_time: page.last_edited_time } : {}),
            ...(page.in_trash !== undefined
              ? { page_in_trash: page.in_trash } : {}),
          }),
        };
        try {
          await this.file.appendFile(JSON.stringify(record) + "\n", "utf8");
          await this.file.sync();
        } catch {
          this.failedWrite = true;
          throw new Error("Webhook reconcile append outcome uncertain");
        }
        this.completed.add(key);
        processed++;
      }
      return { processed, duplicates, blocked };
    });
    this.active = task.then(() => undefined, () => undefined);
    return task;
  }

  async close(): Promise<void> {
    await this.active;
    await this.file.close();
  }
}
