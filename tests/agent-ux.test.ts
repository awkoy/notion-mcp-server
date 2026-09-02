import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Handler-level behaviour of the agent-facing improvements: plain property
// values typed from the data source schema, schema-aware `where`, sort
// shorthand, the `object` marker on search results, and partial block updates.

const notionStub = {
  databases: { retrieve: vi.fn() },
  dataSources: { retrieve: vi.fn(), query: vi.fn(), update: vi.fn() },
  pages: { retrieve: vi.fn(), create: vi.fn(), update: vi.fn() },
  blocks: { update: vi.fn() },
  search: vi.fn(),
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";
import { clearSchemaCache } from "../src/services/schema-cache.js";
import { coerceProperties, coerceValue } from "../src/schema/property-shorthand.js";
import { DATABASE_PROPERTY_SCHEMA } from "../src/schema/database.js";

const TASKS = {
  object: "data_source",
  id: "ds-tasks",
  title: [{ plain_text: "Tasks" }],
  description: [],
  url: "u",
  parent: { type: "database_id", database_id: "db-tasks" },
  properties: {
    Task: { type: "title", title: {} },
    Status: { type: "status", status: { options: [{ name: "Not Started" }, { name: "In Progress" }, { name: "Done" }], groups: [] } },
    Priority: { type: "select", select: { options: [{ name: "Low" }, { name: "High" }] } },
    Tags: { type: "multi_select", multi_select: { options: [] } },
    "Due Date": { type: "date", date: {} },
    Done: { type: "checkbox", checkbox: {} },
    Notes: { type: "rich_text", rich_text: {} },
    Score: { type: "number", number: { format: "number" } },
    Owner: { type: "people", people: {} },
    Project: { type: "relation", relation: { data_source_id: "ds-projects" } },
    Link: { type: "url", url: {} },
    Attachments: { type: "files", files: {} },
    Total: { type: "formula", formula: { expression: "1" } },
  },
};

const ROW = { object: "page", id: "p-1", url: "https://notion.so/p-1", parent: { type: "data_source_id", data_source_id: "ds-tasks" }, properties: {} };

type Ok = { ok: true; data: unknown; warnings?: string[] };
type Err = { ok: false; error: { code: string; message: string; fix?: string } };

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  clearSchemaCache();
  for (const group of Object.values(notionStub)) {
    if (typeof group === "function") group.mockReset();
    else for (const fn of Object.values(group)) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
});

describe("coerceValue", () => {
  const schema = {
    Task: { type: "title" },
    Status: { type: "status", options: ["Not Started", "Done"] },
    Priority: { type: "select", options: ["Low", "High"] },
    Tags: { type: "multi_select" },
    Due: { type: "date" },
    Done: { type: "checkbox" },
    Notes: { type: "rich_text" },
    Score: { type: "number" },
    Owner: { type: "people" },
    Project: { type: "relation" },
    Link: { type: "url" },
    Files: { type: "files" },
    Total: { type: "formula" },
  };
  const value = (name: keyof typeof schema, v: unknown) => {
    const r = coerceValue(name, v, schema[name]);
    return r.ok ? r.value : r.error;
  };

  it("types scalars from the property type", () => {
    expect(value("Task", "Write")).toEqual({ title: [{ type: "text", text: { content: "Write" } }] });
    expect(value("Notes", "hi")).toEqual({ rich_text: [{ type: "text", text: { content: "hi" } }] });
    expect(value("Status", "Done")).toEqual({ status: { name: "Done" } });
    expect(value("Priority", "High")).toEqual({ select: { name: "High" } });
    expect(value("Tags", "a")).toEqual({ multi_select: [{ name: "a" }] });
    expect(value("Tags", ["a", "b"])).toEqual({ multi_select: [{ name: "a" }, { name: "b" }] });
    expect(value("Due", "2026-01-01")).toEqual({ date: { start: "2026-01-01" } });
    expect(value("Due", { start: "2026-01-01", end: "2026-01-02" })).toEqual({ date: { start: "2026-01-01", end: "2026-01-02" } });
    expect(value("Done", true)).toEqual({ checkbox: true });
    expect(value("Score", 4)).toEqual({ number: 4 });
    expect(value("Score", "4.5")).toEqual({ number: 4.5 });
    expect(value("Link", "https://x.y")).toEqual({ url: "https://x.y" });
  });

  it("normalizes ids for people and relation values", () => {
    expect(value("Owner", "1bbc3766c0ca80a48e13e5f56a8b19e4")).toEqual({
      people: [{ object: "user", id: "1bbc3766-c0ca-80a4-8e13-e5f56a8b19e4" }],
    });
    expect(value("Project", ["https://www.notion.so/Plan-1bbc3766c0ca80a48e13e5f56a8b19e4"])).toEqual({
      relation: [{ id: "1bbc3766-c0ca-80a4-8e13-e5f56a8b19e4" }],
    });
  });

  it("turns URLs and { name, url } into external files", () => {
    expect(value("Files", "https://cdn.x/chart.png")).toEqual({
      files: [{ type: "external", name: "chart.png", external: { url: "https://cdn.x/chart.png" } }],
    });
    expect(value("Files", [{ name: "Spec", url: "https://cdn.x/spec.pdf" }])).toEqual({
      files: [{ type: "external", name: "Spec", external: { url: "https://cdn.x/spec.pdf" } }],
    });
  });

  it("clears with null", () => {
    expect(value("Status", null)).toEqual({ status: null });
    expect(value("Tags", null)).toEqual({ multi_select: [] });
    expect(value("Notes", null)).toEqual({ rich_text: [] });
    expect(value("Done", null)).toEqual({ checkbox: false });
    expect(value("Score", null)).toEqual({ number: null });
  });

  it("passes typed values through untouched", () => {
    expect(value("Status", { status: { name: "Done" } })).toEqual({ status: { name: "Done" } });
    expect(value("Notes", { rich_text: [] })).toEqual({ rich_text: [] });
  });

  it("rejects an unknown status option with the valid ones", () => {
    expect(value("Status", "Finished")).toMatchObject({
      code: "unknown_option",
      fix: "Use one of: Not Started, Done.",
    });
  });

  it("explains a type mismatch and a read-only property", () => {
    expect(value("Score", "lots")).toMatchObject({ code: "property_type_mismatch", message: 'Property "Score" is a number property; got a string.' });
    expect(value("Done", "yes")).toMatchObject({ code: "property_type_mismatch" });
    expect(value("Total", 3)).toMatchObject({ code: "property_read_only" });
  });
});

describe("coerceProperties", () => {
  const schema = { Task: { type: "title" }, Status: { type: "status", options: ["Done"] } };

  it("maps `title` to the title property whatever it is called", () => {
    const r = coerceProperties({ title: "Write", Status: "Done" }, schema);
    expect(r).toEqual({
      ok: true,
      properties: { Task: { title: [{ type: "text", text: { content: "Write" } }] }, Status: { status: { name: "Done" } } },
      warnings: [],
    });
  });

  it("corrects a name that differs only in case, with a warning", () => {
    const r = coerceProperties({ status: "Done" }, schema);
    expect(r).toEqual({
      ok: true,
      properties: { Status: { status: { name: "Done" } } },
      warnings: ['Property "status" was read as "Status" (names are case-sensitive).'],
    });
  });

  it("rejects an unknown property, listing the valid names", () => {
    expect(coerceProperties({ Priority: "High" }, schema)).toMatchObject({
      ok: false,
      error: { code: "unknown_property", fix: "Use one of: Task, Status." },
    });
  });

  it("without a schema accepts only title and typed values", () => {
    expect(coerceProperties({ title: "T", Notes: { rich_text: [] } }, undefined)).toMatchObject({ ok: true });
    expect(coerceProperties({ Notes: "plain" }, undefined)).toMatchObject({
      ok: false,
      error: { code: "not_a_database_page" },
    });
  });
});

describe("set_page_property / set_page_properties with plain values", () => {
  it("fetches the row's data source schema once and sends typed values", async () => {
    notionStub.pages.retrieve.mockResolvedValue(ROW);
    notionStub.dataSources.retrieve.mockResolvedValue(TASKS);
    notionStub.pages.update.mockResolvedValue(ROW);

    const res = (await dispatch("set_page_property", { page_id: "p-1", name: "Status", value: "Done" })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.pages.update).toHaveBeenCalledWith({ page_id: "p-1", properties: { Status: { status: { name: "Done" } } } });

    const res2 = (await dispatch("set_page_properties", {
      page_id: "p-1",
      properties: { Priority: "High", "Due Date": "2026-10-01", Tags: ["a", "b"], Done: true, Notes: null, title: "Renamed" },
    })) as Ok;
    expect(res2.ok).toBe(true);
    expect(notionStub.pages.update).toHaveBeenLastCalledWith({
      page_id: "p-1",
      properties: {
        Priority: { select: { name: "High" } },
        "Due Date": { date: { start: "2026-10-01" } },
        Tags: { multi_select: [{ name: "a" }, { name: "b" }] },
        Done: { checkbox: true },
        Notes: { rich_text: [] },
        Task: { title: [{ type: "text", text: { content: "Renamed" } }] },
      },
    });
    // Second call hit the cache: one schema fetch for both calls.
    expect(notionStub.dataSources.retrieve).toHaveBeenCalledTimes(1);
    expect(notionStub.pages.retrieve).toHaveBeenCalledTimes(2);
  });

  it("costs no extra request when the value is already typed", async () => {
    notionStub.pages.update.mockResolvedValue(ROW);
    const res = (await dispatch("set_page_property", { page_id: "p-1", name: "Status", value: { status: { name: "Done" } } })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.pages.retrieve).not.toHaveBeenCalled();
    expect(notionStub.dataSources.retrieve).not.toHaveBeenCalled();
  });

  it("keeps the title shorthand working on a page that is not a row", async () => {
    notionStub.pages.update.mockResolvedValue(ROW);
    const res = (await dispatch("set_page_property", { page_id: "p-1", name: "title", value: "Hello" })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.pages.retrieve).not.toHaveBeenCalled();
    expect(notionStub.pages.update).toHaveBeenCalledWith({
      page_id: "p-1",
      properties: { title: { title: [{ type: "text", text: { content: "Hello" } }] } },
    });
  });

  it("reports an unknown property before calling Notion", async () => {
    notionStub.pages.retrieve.mockResolvedValue(ROW);
    notionStub.dataSources.retrieve.mockResolvedValue(TASKS);
    const res = (await dispatch("set_page_property", { page_id: "p-1", name: "Prio", value: "High" })) as Err;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("unknown_property");
    expect(res.error.fix).toContain("Task, Status, Priority");
    expect(notionStub.pages.update).not.toHaveBeenCalled();
  });

  it("explains a plain value on a page that is not a database row", async () => {
    notionStub.pages.retrieve.mockResolvedValue({ ...ROW, parent: { type: "page_id", page_id: "root" } });
    const res = (await dispatch("set_page_property", { page_id: "p-1", name: "Notes", value: "x" })) as Err;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("not_a_database_page");
  });

  it("surfaces a case correction as a warning on the successful result", async () => {
    notionStub.pages.retrieve.mockResolvedValue(ROW);
    notionStub.dataSources.retrieve.mockResolvedValue(TASKS);
    notionStub.pages.update.mockResolvedValue(ROW);
    const res = (await dispatch("set_page_property", { page_id: "p-1", name: "status", value: "Done" })) as Ok;
    expect(res.ok).toBe(true);
    expect(res.warnings).toEqual(['Property "status" was read as "Status" (names are case-sensitive).']);
    expect(notionStub.pages.update).toHaveBeenCalledWith({ page_id: "p-1", properties: { Status: { status: { name: "Done" } } } });
  });
});

describe("create_page with plain row properties", () => {
  it("types the properties from the data_source_id parent", async () => {
    notionStub.dataSources.retrieve.mockResolvedValue(TASKS);
    notionStub.pages.create.mockResolvedValue(ROW);
    const res = (await dispatch("create_page", {
      parent: { type: "data_source_id", data_source_id: "ds-tasks" },
      title: "Write the report",
      properties: { Status: "In Progress", "Due Date": "2026-10-01", Score: 3 },
    })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.pages.create).toHaveBeenCalledWith({
      parent: { type: "data_source_id", data_source_id: "ds-tasks" },
      properties: {
        Task: { title: [{ type: "text", text: { content: "Write the report" } }] },
        Status: { status: { name: "In Progress" } },
        "Due Date": { date: { start: "2026-10-01" } },
        Score: { number: 3 },
      },
    });
  });

  it("resolves a single-source database_id parent to its data source", async () => {
    notionStub.databases.retrieve.mockResolvedValue({ object: "database", id: "db-tasks", title: [], data_sources: [{ id: "ds-tasks", name: "Tasks" }] });
    notionStub.dataSources.retrieve.mockResolvedValue(TASKS);
    notionStub.pages.create.mockResolvedValue(ROW);
    const res = (await dispatch("create_page", {
      parent: { type: "database_id", database_id: "db-tasks" },
      properties: { title: "T", Priority: "High" },
    })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.pages.create).toHaveBeenCalledWith({
      parent: { type: "data_source_id", data_source_id: "ds-tasks" },
      properties: { Task: { title: [{ type: "text", text: { content: "T" } }] }, Priority: { select: { name: "High" } } },
    });
  });

  it("asks for a data_source_id when the database has several sources", async () => {
    notionStub.databases.retrieve.mockResolvedValue({
      object: "database",
      id: "db-tasks",
      title: [],
      data_sources: [{ id: "ds-a", name: "A" }, { id: "ds-b", name: "B" }],
    });
    const res = (await dispatch("create_page", {
      parent: { type: "database_id", database_id: "db-tasks" },
      properties: { Priority: "High" },
    })) as Err;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("multi_source_database");
    expect(notionStub.pages.create).not.toHaveBeenCalled();
  });

  it("leaves typed properties and page parents alone", async () => {
    notionStub.pages.create.mockResolvedValue(ROW);
    const res = (await dispatch("create_page", {
      parent: { type: "page_id", page_id: "root" },
      title: "Note",
      markdown: "Body",
    })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.dataSources.retrieve).not.toHaveBeenCalled();
    expect(notionStub.pages.create.mock.calls[0][0]).toMatchObject({ parent: { type: "page_id", page_id: "root" } });
  });
});

describe("query_database", () => {
  const empty = { object: "list", results: [], has_more: false, next_cursor: null };

  it("compiles `where` with the data source's property types", async () => {
    notionStub.dataSources.retrieve.mockResolvedValue(TASKS);
    notionStub.dataSources.query.mockResolvedValue(empty);
    const res = (await dispatch("query_database", { data_source_id: "ds-tasks", where: { Status: "Done", Task: { contains: "report" } } })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.dataSources.query).toHaveBeenCalledWith({
      data_source_id: "ds-tasks",
      filter: {
        and: [
          { property: "Status", status: { equals: "Done" } },
          { property: "Task", title: { contains: "report" } },
        ],
      },
      page_size: 100,
    });
  });

  it("names the valid properties when `where` uses an unknown one", async () => {
    notionStub.dataSources.retrieve.mockResolvedValue(TASKS);
    const res = (await dispatch("query_database", { data_source_id: "ds-tasks", where: { Stat: "Done" } })) as Err;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("where_compile_error");
    expect(res.error.message).toContain("Task, Status, Priority");
    expect(notionStub.dataSources.query).not.toHaveBeenCalled();
  });

  it("falls back to inference when the schema cannot be fetched", async () => {
    notionStub.dataSources.retrieve.mockRejectedValue(new Error("boom"));
    notionStub.dataSources.query.mockResolvedValue(empty);
    const res = (await dispatch("query_database", { data_source_id: "ds-tasks", where: { Status: "Done" } })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.dataSources.query.mock.calls[0][0]).toMatchObject({
      filter: { property: "Status", select: { equals: "Done" } },
    });
  });

  it("does not fetch the schema for a query without `where`", async () => {
    notionStub.dataSources.query.mockResolvedValue(empty);
    await dispatch("query_database", { data_source_id: "ds-tasks", sorts: ["-Due Date", "Priority", "last_edited_time"] });
    expect(notionStub.dataSources.retrieve).not.toHaveBeenCalled();
    expect(notionStub.dataSources.query.mock.calls[0][0]).toMatchObject({
      sorts: [
        { property: "Due Date", direction: "descending" },
        { property: "Priority", direction: "ascending" },
        { timestamp: "last_edited_time", direction: "ascending" },
      ],
    });
  });

  it("passes object sorts through", async () => {
    notionStub.dataSources.query.mockResolvedValue(empty);
    await dispatch("query_database", {
      data_source_id: "ds-tasks",
      sorts: [{ property: "Score", direction: "descending" }, { timestamp: "created_time", direction: "descending" }],
    });
    expect(notionStub.dataSources.query.mock.calls[0][0]).toMatchObject({
      sorts: [
        { property: "Score", direction: "descending" },
        { timestamp: "created_time", direction: "descending" },
      ],
    });
  });
});

describe("search_pages", () => {
  it("marks each slim result with its object kind", async () => {
    notionStub.search.mockResolvedValue({
      object: "list",
      results: [
        { object: "page", id: "p-1", url: "u1", parent: { type: "workspace", workspace: true }, properties: { title: { type: "title", title: [{ plain_text: "Plan" }] } } },
        { object: "database", id: "db-1", url: "u2", title: [{ plain_text: "Tasks" }], description: [], parent: { type: "page_id", page_id: "p-1" }, data_sources: [{ id: "ds-1", name: "Tasks" }] },
        { ...TASKS },
      ],
      has_more: false,
      next_cursor: null,
    });
    const res = (await dispatch("search_pages", { query: "x" })) as Ok;
    expect(res).toMatchObject({ ok: true });
    const results = (res.data as { results: { object: string; id: string }[] }).results;
    expect(results.map((r) => [r.object, r.id])).toEqual([
      ["page", "p-1"],
      ["database", "db-1"],
      ["data_source", "ds-tasks"],
    ]);
  });
});

describe("update_block partial data", () => {
  it("sends only the fields given", async () => {
    notionStub.blocks.update.mockResolvedValue({ object: "block", id: "b-1", type: "to_do", has_children: false, in_trash: false, to_do: { rich_text: [], checked: true } });
    const res = (await dispatch("update_block", { block_id: "b-1", data: { to_do: { checked: true } } })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.blocks.update).toHaveBeenCalledWith({ block_id: "b-1", to_do: { checked: true } });

    await dispatch("update_block", { block_id: "b-1", data: { type: "code", code: { language: "python" } } });
    expect(notionStub.blocks.update).toHaveBeenLastCalledWith({ block_id: "b-1", code: { language: "python" } });
  });

  it("still rejects data without a body key", async () => {
    const res = (await dispatch("update_block", { block_id: "b-1", data: { checked: true } })) as Err;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("validation_error");
  });

  it("sets a to_do's text and checked state from `- [x]` markdown", async () => {
    notionStub.blocks.update.mockResolvedValue({ object: "block", id: "b-1", type: "to_do", has_children: false, in_trash: false, to_do: { rich_text: [], checked: true } });
    await dispatch("update_block", { block_id: "b-1", markdown: "- [x] Ship it" });
    expect(notionStub.blocks.update).toHaveBeenCalledWith({
      block_id: "b-1",
      to_do: { rich_text: [{ type: "text", text: { content: "Ship it" } }], checked: true },
    });
  });
});

describe("property definitions without `type`", () => {
  it("infers the type from the body key", () => {
    expect(DATABASE_PROPERTY_SCHEMA.parse({ select: { options: [{ name: "A" }] } })).toMatchObject({
      type: "select",
      select: { options: [{ name: "A" }] },
    });
    expect(DATABASE_PROPERTY_SCHEMA.parse({ rich_text: {} })).toEqual({ type: "rich_text", rich_text: {} });
    expect(DATABASE_PROPERTY_SCHEMA.parse({ relation: { data_source_id: "ds-1", single_property: {} } })).toMatchObject({ type: "relation" });
    expect(DATABASE_PROPERTY_SCHEMA.parse('{"checkbox":{}}')).toEqual({ type: "checkbox", checkbox: {} });
  });

  it("keeps an explicit type and still rejects a body-less definition", () => {
    expect(DATABASE_PROPERTY_SCHEMA.parse({ type: "number", number: { format: "percent" } })).toMatchObject({ type: "number" });
    expect(DATABASE_PROPERTY_SCHEMA.safeParse({ options: [{ name: "A" }] }).success).toBe(false);
    expect(DATABASE_PROPERTY_SCHEMA.safeParse({ select: { options: [] }, number: {} }).success).toBe(false);
  });

  it("is accepted by update_data_source", async () => {
    notionStub.dataSources.update.mockResolvedValue({ id: "ds-1" });
    const res = (await dispatch("update_data_source", {
      data_source_id: "ds-1",
      properties: { Status: { select: { options: [{ name: "A" }, { name: "B" }] } }, Old: null },
    })) as Ok;
    expect(res.ok).toBe(true);
    expect(notionStub.dataSources.update.mock.calls[0][0]).toMatchObject({
      properties: { Status: { type: "select", select: { options: [{ name: "A" }, { name: "B" }] } }, Old: null },
    });
  });
});
