import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginIdempotentRequest,
  completeIdempotentRequest,
  markDownstreamAttempt,
} from "../src/dispatch/idempotency.js";

const cleanup: string[] = [];

async function useFreshLedger(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "notion-idempotency-"));
  cleanup.push(directory);
  const path = join(directory, "ledger.json");
  process.env.NOTION_IDEMPOTENCY_STATE_PATH = path;
  return path;
}

afterEach(async () => {
  delete process.env.NOTION_IDEMPOTENCY_STATE_PATH;
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable idempotency", () => {
  it("deduplicates identical replay, rejects conflicts, and persists no content", async () => {
    const path = await useFreshLedger();
    const key = "customer-visible-retry-key";
    const payload = {
      items: [{ page_id: "11111111-1111-4111-8111-111111111111", title: "Private title" }],
      idempotency_key: key,
    };

    const admitted = await beginIdempotentRequest("set_page_title", payload, key);
    expect(admitted.action).toBe("accepted");
    if (admitted.action !== "accepted") throw new Error("request was not accepted");

    await markDownstreamAttempt(admitted.context);
    const accepted = await completeIdempotentRequest(admitted.context, {
      ok: true,
      summary: { total: 1, succeeded: 1, failed: 0 },
      results: [
        {
          index: 0,
          ok: true,
          data: {
            page_id: "11111111-1111-4111-8111-111111111111",
            title: "Private title",
            token: "ntn_must_not_persist",
          },
        },
      ],
    });
    expect(accepted.decision).toBe("accepted");
    expect(accepted.downstream_write_count).toBe(1);

    const replay = await beginIdempotentRequest("set_page_title", payload, key);
    expect(replay.action).toBe("deduplicated");
    if (replay.action !== "deduplicated") throw new Error("request was not deduplicated");
    expect(replay.receipt.submitted_attempt_count).toBe(2);
    expect(JSON.stringify(replay.stored_result)).toContain("11111111-1111-4111-8111-111111111111");

    const conflict = await beginIdempotentRequest(
      "set_page_title",
      { ...payload, items: [{ ...payload.items[0], title: "Different title" }] },
      key
    );
    expect(conflict.action).toBe("rejected");
    if (conflict.action !== "rejected") throw new Error("conflict was not rejected");
    expect(conflict.error.code).toBe("idempotency_conflict");

    const durable = await readFile(path, "utf8");
    expect(durable).not.toContain(key);
    expect(durable).not.toContain("Private title");
    expect(durable).not.toContain("Different title");
    expect(durable).not.toContain("ntn_must_not_persist");
  });

  it("blocks replay while a prior attempt is pending", async () => {
    await useFreshLedger();
    const payload = { items: [{ value: 1 }], idempotency_key: "pending-key" };
    const first = await beginIdempotentRequest("set_page_title", payload, "pending-key");
    expect(first.action).toBe("accepted");

    const replay = await beginIdempotentRequest("set_page_title", payload, "pending-key");
    expect(replay.action).toBe("indeterminate");
    if (replay.action !== "indeterminate") throw new Error("pending replay was not blocked");
    expect(replay.error.code).toBe("idempotency_indeterminate");
  });

  it("recovers a valid temporary ledger when the canonical file is corrupt", async () => {
    const path = await useFreshLedger();
    const payload = { items: [{ value: 1 }], idempotency_key: "recovery-key" };
    const first = await beginIdempotentRequest("set_page_title", payload, "recovery-key");
    expect(first.action).toBe("accepted");

    await copyFile(path, `${path}.tmp`);
    await writeFile(path, "{broken", "utf8");
    const replay = await beginIdempotentRequest("set_page_title", payload, "recovery-key");
    expect(replay.action).toBe("indeterminate");
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  it("recovers a dead-process lock", async () => {
    const path = await useFreshLedger();
    await writeFile(`${path}.lock`, "99999999", "utf8");

    const admitted = await beginIdempotentRequest(
      "set_page_title",
      { items: [{ value: 1 }], idempotency_key: "lock-key" },
      "lock-key"
    );
    expect(admitted.action).toBe("accepted");
  });

  it("continues processing after a rejected ledger mutation", async () => {
    const path = await useFreshLedger();
    await writeFile(path, "{broken", "utf8");
    await expect(
      beginIdempotentRequest(
        "set_page_title",
        { items: [{ value: 1 }], idempotency_key: "broken-key" },
        "broken-key"
      )
    ).rejects.toMatchObject({ code: "idempotency_ledger_corrupt" });

    await rm(path, { force: true });
    const admitted = await beginIdempotentRequest(
      "set_page_title",
      { items: [{ value: 1 }], idempotency_key: "recovered-key" },
      "recovered-key"
    );
    expect(admitted.action).toBe("accepted");
  });
});
