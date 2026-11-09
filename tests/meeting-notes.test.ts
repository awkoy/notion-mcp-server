import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// The real SDK client under dispatch, with node-fetch stubbed, so these check
// the HTTP request that actually leaves the server.

const { fetchStub } = vi.hoisted(() => ({ fetchStub: vi.fn() }));
vi.mock("node-fetch", () => ({ default: fetchStub }));

import { initOperations, getOperation } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

const { Response: NodeFetchResponse } =
  await vi.importActual<typeof import("node-fetch")>("node-fetch");

type Sent = { url: string; method: string; headers: Record<string, string>; body: any };

const USER = "11111111-1111-4111-8111-111111111111";
const TITLE_CONTAINS = {
  property: "title",
  filter: { operator: "string_contains", value: { type: "exact", value: "standup" } },
};

const FULL_NOTE = {
  object: "block",
  id: "note-1",
  type: "meeting_notes",
  meeting_notes: {
    is_full_page: false,
    title: [{ plain_text: "Weekly " }, { plain_text: "sync" }],
    status: "notes_ready",
    children: {
      summary_block_id: "summary-1",
      notes_block_id: "notes-1",
      transcript_block_id: "transcript-1",
    },
    calendar_event: {
      start_time: "2026-05-11T10:00:00.000Z",
      end_time: "2026-05-11T10:30:00.000Z",
      event_id: "calendar-event-id",
      attendees: [USER],
    },
    recording: { start_time: "2026-05-11T10:01:00.000Z", end_time: "2026-05-11T10:29:00.000Z" },
  },
  created_time: "2026-05-11T10:00:00.000Z",
  last_edited_time: "2026-05-11T11:00:00.000Z",
  created_by: { object: "user", id: USER },
  last_edited_by: { object: "user", id: USER },
  has_children: true,
  in_trash: false,
  archived: false,
};

// A note with only the field Notion's schema requires inside `meeting_notes`.
const BARE_NOTE = {
  object: "block",
  id: "note-2",
  type: "meeting_notes",
  meeting_notes: { is_full_page: true },
  created_time: "2026-05-12T10:00:00.000Z",
  last_edited_time: "2026-05-12T10:00:00.000Z",
  created_by: { object: "user", id: USER },
  last_edited_by: { object: "user", id: USER },
  has_children: false,
  in_trash: false,
  archived: false,
};

function reply(body: unknown, status = 200): Sent[] {
  const sent: Sent[] = [];
  fetchStub.mockImplementation(async (url: unknown, init: any) => {
    sent.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return new NodeFetchResponse(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return sent;
}

const query = (payload: unknown) =>
  dispatch("query_meeting_notes", payload) as Promise<{
    ok: boolean;
    data: any;
    warnings?: string[];
    error?: { code: string; message: string };
  }>;

describe("query_meeting_notes", () => {
  const originalToken = process.env.NOTION_TOKEN;

  beforeAll(async () => {
    process.env.NOTION_TOKEN = "ntn_meeting_notes_test";
    await initOperations();
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.NOTION_TOKEN;
    else process.env.NOTION_TOKEN = originalToken;
  });

  beforeEach(() => {
    fetchStub.mockReset();
  });

  it("is a non-batchable read in the blocks domain", () => {
    expect(getOperation("query_meeting_notes")).toMatchObject({
      access: "read",
      domain: "blocks",
      batchable: false,
    });
  });

  describe("outgoing request", () => {
    it("POSTs an empty body to the meeting notes endpoint when no options are given", async () => {
      const sent = reply({ results: [], has_more: false });
      const res = await query({});
      expect(res.ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].method.toUpperCase()).toBe("POST");
      expect(new URL(sent[0].url).pathname).toBe("/v1/blocks/meeting_notes/query");
      expect(sent[0].headers["Notion-Version"]).toBe("2026-03-11");
      expect(sent[0].body).toEqual({});
    });

    it("sends a combinator, sort and limit unchanged", async () => {
      const sent = reply({ results: [], has_more: false });
      const filter = {
        operator: "or",
        filters: [
          TITLE_CONTAINS,
          {
            operator: "and",
            filters: [
              { property: "attendees", filter: { operator: "is_not_empty" } },
              {
                property: "created_by",
                filter: { operator: "person_contains", value: [{ type: "relative", value: "me" }] },
              },
            ],
          },
        ],
      };
      const sort = [
        { property: "last_edited_time", direction: "descending" },
        { property: "title", direction: "ascending" },
      ];
      await query({ filter, sort, limit: 10 });
      expect(sent[0].body).toEqual({ filter, sort, limit: 10 });
    });

    it("wraps a single property filter in a one-clause `and`, which is all the API accepts at the root", async () => {
      const sent = reply({ results: [], has_more: false });
      await query({ filter: TITLE_CONTAINS });
      expect(sent[0].body).toEqual({ filter: { operator: "and", filters: [TITLE_CONTAINS] } });
    });

    it("keeps operator-specific fields such as use_end", async () => {
      const sent = reply({ results: [], has_more: false });
      const clause = {
        property: "created_time",
        filter: {
          operator: "date_is_before",
          value: { type: "exact", value: { type: "date", start_date: "2026-05-01" } },
          use_end: true,
        },
      };
      await query({ filter: { operator: "and", filters: [clause] } });
      expect(sent[0].body.filter.filters[0]).toEqual(clause);
    });

    it("accepts the attendees alias Notion documents for filters", async () => {
      const sent = reply({ results: [], has_more: false });
      const clause = {
        property: "notion://meeting_notes/attendees",
        filter: { operator: "person_contains", value: [{ type: "relative", value: "me" }] },
      };
      await query({ filter: clause });
      expect(sent[0].body.filter.filters).toEqual([clause]);
    });
  });

  describe("validation before any request", () => {
    it.each([
      ["limit above 50", { limit: 51 }],
      ["limit below 1", { limit: 0 }],
      ["fractional limit", { limit: 1.5 }],
      ["unknown filter property", { filter: { property: "status", filter: { operator: "is_empty" } } }],
      ["unknown operator", { filter: { property: "title", filter: { operator: "equals" } } }],
      ["unknown sort property", { sort: [{ property: "status", direction: "ascending" }] }],
      ["the attendees alias in a sort", { sort: [{ property: "notion://meeting_notes/attendees", direction: "ascending" }] }],
      ["bad sort direction", { sort: [{ property: "title", direction: "up" }] }],
    ])("rejects %s", async (_label, payload) => {
      const sent = reply({ results: [], has_more: false });
      const res = await query(payload);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("validation_error");
      expect(sent).toHaveLength(0);
    });
  });

  describe("pagination", () => {
    it("has no cursor: start_cursor and paginate are ignored with a warning and never sent", async () => {
      const sent = reply({ results: [], has_more: false });
      const res = await query({ limit: 5, start_cursor: "abc", paginate: true });
      expect(res.ok).toBe(true);
      expect(sent).toHaveLength(1);
      expect(sent[0].body).toEqual({ limit: 5 });
      expect(res.warnings?.join(" ")).toMatch(/start_cursor/);
      expect(res.warnings?.join(" ")).toMatch(/paginate/);
    });

    it("warns when more notes match and reports no next_cursor", async () => {
      const sent = reply({ results: [FULL_NOTE], has_more: true });
      const res = await query({ limit: 1 });
      expect(sent).toHaveLength(1);
      expect(res.data.has_more).toBe(true);
      expect(res.data).not.toHaveProperty("next_cursor");
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings?.[0]).toMatch(/no cursor/);
    });

    it("adds no warning when everything came back", async () => {
      reply({ results: [FULL_NOTE], has_more: false });
      const res = await query({});
      expect(res.data.has_more).toBe(false);
      expect(res.warnings).toBeUndefined();
    });
  });

  describe("response shape", () => {
    it("slims a note to its identity, times and content block ids", async () => {
      reply({ results: [FULL_NOTE], has_more: false });
      const res = await query({});
      expect(res.data).toEqual({
        results: [
          {
            id: "note-1",
            title: "Weekly sync",
            status: "notes_ready",
            created_time: "2026-05-11T10:00:00.000Z",
            last_edited_time: "2026-05-11T11:00:00.000Z",
            created_by: USER,
            calendar_event: {
              start_time: "2026-05-11T10:00:00.000Z",
              end_time: "2026-05-11T10:30:00.000Z",
              attendees: [USER],
            },
            recording: { start_time: "2026-05-11T10:01:00.000Z", end_time: "2026-05-11T10:29:00.000Z" },
            summary_block_id: "summary-1",
            notes_block_id: "notes-1",
            transcript_block_id: "transcript-1",
          },
        ],
        has_more: false,
      });
    });

    it("omits what a note does not have", async () => {
      reply({ results: [BARE_NOTE], has_more: false });
      const res = await query({});
      expect(res.data.results[0]).toEqual({
        id: "note-2",
        created_time: "2026-05-12T10:00:00.000Z",
        last_edited_time: "2026-05-12T10:00:00.000Z",
        created_by: USER,
      });
    });

    it("flags a trashed note", async () => {
      reply({ results: [{ ...BARE_NOTE, in_trash: true }], has_more: false });
      const res = await query({});
      expect(res.data.results[0].in_trash).toBe(true);
    });

    it("returns Notion's shape with verbose:true", async () => {
      const raw = { results: [FULL_NOTE, BARE_NOTE], has_more: false };
      const sent = reply(raw);
      const res = await query({ verbose: true });
      expect(res.data).toEqual(raw);
      expect(sent[0].body).toEqual({});
    });
  });

  it("passes on Notion's error when the plan has no AI meeting notes", async () => {
    const message =
      "This endpoint requires a plan with AI meeting notes enabled. Please upgrade your plan to use this feature: https://www.notion.com/pricing";
    const sent = reply({ object: "error", status: 400, code: "validation_error", message }, 400);
    const res = await query({});
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("validation_error");
    expect(res.error?.message).toContain(message);
    expect(sent).toHaveLength(1);
  });
});
