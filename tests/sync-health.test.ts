import { describe, expect, it } from "vitest";
import { slimSyncMetadata, slimDataSource } from "../src/utils/slim.js";

describe("sync metadata slim reads", () => {
  it("does not label missing metadata as an unsynced source", () => {
    expect(slimSyncMetadata(undefined)).toBeUndefined();
    expect(slimSyncMetadata(null)).toBeUndefined();
  });

  it("preserves null health as unavailable, not a failure", () => {
    expect(slimSyncMetadata({
      external_database_sync: { sync_id: "sync-1", provider: "github" },
      resource: "issues", health: null,
    })).toMatchObject({
      external_database_sync: { sync_id: "sync-1", provider: "github" },
      resource: "issues", health: null,
    });
  });

  it("retains the health state and the actual successful sync checkpoint", () => {
    const out = slimSyncMetadata({
      external_database_sync: { sync_id: "sync-1", provider: "jira" },
      health: { ok: true, paused: false, stage: "steady",
        checks: {
          sync_version_updated_at: "2026-11-01T00:00:00Z",
          last_execution_succeeded_at: "2026-11-02T00:00:00Z",
          delta_synced_through_at: "2026-11-03T00:00:00Z",
        } },
    });
    expect(out).toMatchObject({
      health: { ok: true, paused: false, stage: "steady",
        checks: { delta_synced_through_at: "2026-11-03T00:00:00Z" } },
    });
  });

  it("keeps explicit health errors without raw provider error messages", () => {
    const out = slimSyncMetadata({
      health: { ok: false, stage: "backfilling", paused: true,
        error: { code: "auth_expired", severity: "action_required", raw: "secret" } },
    });
    expect(out).toMatchObject({
      health: { ok: false, paused: true,
        error: { code: "auth_expired", severity: "action_required" } },
    });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("preserves legacy timestamps without inventing current health", () => {
    expect(slimSyncMetadata({
      external_collection_type: "Jira",
      sync_state: { syncing: false, last_synced_at: "2026-10-29T12:34:56Z" },
    })).toEqual({
      external_collection_type: "Jira",
      sync_state: { syncing: false, last_synced_at: "2026-10-29T12:34:56Z" },
    });
  });
  it("includes known sync metadata in compact data-source reads", () => {
    const source = {
      object: "data_source", id: "ds-1", url: "https://notion.so/x",
      title: [], description: [], parent: { type: "database_id", database_id: "db" },
      properties: { Name: { type: "title" } },
      sync_metadata: { health: null, synced_collection_key: "issues" },
    } as unknown as Parameters<typeof slimDataSource>[0];
    expect(slimDataSource(source)).toMatchObject({
      id: "ds-1", sync_metadata: { health: null, synced_collection_key: "issues" },
    });
  });
});
