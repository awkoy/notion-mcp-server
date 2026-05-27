import { describe, it, expect } from "vitest";
import {
  slimPage,
  slimBlock,
  slimDatabase,
  slimDataSource,
  slimUser,
  slimComment,
  slimList,
} from "../src/utils/slim.js";

// Tests use minimal stub objects that only include the fields the slim
// helpers read. Casting through unknown lets the fixtures stay focused.
const fx = <T>(value: unknown): T => value as T;

describe("slimPage", () => {
  it("extracts id, url, parent, archived, icon type, and title from properties", () => {
    const page = fx<Parameters<typeof slimPage>[0]>({
      object: "page",
      id: "p1",
      url: "https://notion.so/p1",
      parent: { type: "page_id", page_id: "parent" },
      archived: false,
      in_trash: false,
      icon: { type: "emoji", emoji: "📦" },
      created_time: "t1",
      last_edited_time: "t2",
      properties: {
        Name: {
          type: "title",
          title: [{ plain_text: "Hello world" }],
        },
        Status: { type: "select", select: { name: "Open" } },
      },
    });
    expect(slimPage(page)).toEqual({
      id: "p1",
      url: "https://notion.so/p1",
      title: "Hello world",
      parent: { type: "page_id", page_id: "parent" },
      icon: "emoji",
    });
  });

  it("emits in_trash:true only when the page is trashed", () => {
    const trashed = fx<Parameters<typeof slimPage>[0]>({
      object: "page",
      id: "p2",
      url: "https://notion.so/p2",
      parent: { type: "page_id", page_id: "parent" },
      in_trash: true,
      icon: null,
      created_time: "t1",
      last_edited_time: "t2",
      properties: { Name: { type: "title", title: [{ plain_text: "Gone" }] } },
    });
    expect(slimPage(trashed)).toEqual({
      id: "p2",
      url: "https://notion.so/p2",
      title: "Gone",
      parent: { type: "page_id", page_id: "parent" },
      in_trash: true,
    });
  });

  it("returns raw input when verbose is true", () => {
    const page = fx<Parameters<typeof slimPage>[0]>({ object: "page", id: "p1", random: "stuff" });
    expect(slimPage(page, true)).toBe(page);
  });

  it("flattens properties to scalars when includeProperties is true", () => {
    const page = fx<Parameters<typeof slimPage>[0]>({
      object: "page",
      id: "p3",
      url: "u",
      parent: { type: "data_source_id", data_source_id: "ds-1" },
      in_trash: false,
      icon: null,
      properties: {
        Name: { type: "title", title: [{ plain_text: "Task 1" }] },
        Status: { type: "status", status: { name: "Done" } },
        Priority: { type: "number", number: 3 },
        Tags: {
          type: "multi_select",
          multi_select: [{ name: "alpha" }, { name: "beta" }],
        },
        Done: { type: "checkbox", checkbox: true },
        Due: { type: "date", date: { start: "2026-05-27", end: null } },
        Empty: { type: "select", select: null },
        Notes: { type: "rich_text", rich_text: [{ plain_text: "see " }, { plain_text: "this" }] },
      },
    });
    const result = slimPage(page, false, true) as Record<string, unknown>;
    expect(result.title).toBe("Task 1");
    expect(result.properties).toEqual({
      Status: "Done",
      Priority: 3,
      Tags: ["alpha", "beta"],
      Done: true,
      Due: "2026-05-27",
      Notes: "see this",
    });
  });

  it("flattens rollup array elements (does not return their count)", () => {
    const page = fx<Parameters<typeof slimPage>[0]>({
      object: "page",
      id: "p-rollup",
      url: "u",
      parent: { type: "page_id", page_id: "parent" },
      in_trash: false,
      icon: null,
      properties: {
        Name: { type: "title", title: [{ plain_text: "Row" }] },
        Linked: {
          type: "rollup",
          rollup: {
            type: "array",
            array: [
              { type: "number", number: 1 },
              { type: "number", number: 2 },
              { type: "select", select: { name: "Open" } },
            ],
          },
        },
      },
    });
    const result = slimPage(page, false, true) as Record<string, unknown>;
    expect(result.properties).toEqual({ Linked: [1, 2, "Open"] });
  });

  it("omits unique_id when number is null (no PREFIX-null leak)", () => {
    const page = fx<Parameters<typeof slimPage>[0]>({
      object: "page",
      id: "p-uid",
      url: "u",
      parent: { type: "page_id", page_id: "parent" },
      in_trash: false,
      icon: null,
      properties: {
        Name: { type: "title", title: [{ plain_text: "Row" }] },
        TaskId: {
          type: "unique_id",
          unique_id: { prefix: "T", number: null },
        },
      },
    });
    const result = slimPage(page, false, true) as Record<string, unknown>;
    expect(result).not.toHaveProperty("properties");
  });

  it("formats unique_id as PREFIX-N when both prefix and number are present", () => {
    const page = fx<Parameters<typeof slimPage>[0]>({
      object: "page",
      id: "p-uid-2",
      url: "u",
      parent: { type: "page_id", page_id: "parent" },
      in_trash: false,
      icon: null,
      properties: {
        Name: { type: "title", title: [{ plain_text: "Row" }] },
        TaskId: {
          type: "unique_id",
          unique_id: { prefix: "T", number: 42 },
        },
      },
    });
    const result = slimPage(page, false, true) as Record<string, unknown>;
    expect(result.properties).toEqual({ TaskId: "T-42" });
  });

  it("omits the properties field entirely when all values are empty", () => {
    const page = fx<Parameters<typeof slimPage>[0]>({
      object: "page",
      id: "p4",
      url: "u",
      parent: { type: "page_id", page_id: "parent" },
      in_trash: false,
      icon: null,
      properties: {
        Name: { type: "title", title: [{ plain_text: "Solo title" }] },
      },
    });
    const result = slimPage(page, false, true) as Record<string, unknown>;
    expect(result).not.toHaveProperty("properties");
  });
});

describe("slimBlock", () => {
  it("extracts text from rich_text and includes type-specific fields", () => {
    const todo = fx<Parameters<typeof slimBlock>[0]>({
      object: "block",
      id: "b1",
      type: "to_do",
      has_children: false,
      to_do: {
        rich_text: [{ plain_text: "buy milk" }],
        checked: true,
      },
    });
    expect(slimBlock(todo)).toMatchObject({
      id: "b1",
      type: "to_do",
      text: "buy milk",
      checked: true,
    });
  });

  it("surfaces code language and image url", () => {
    const code = fx<Parameters<typeof slimBlock>[0]>({
      object: "block",
      id: "c1",
      type: "code",
      code: { rich_text: [{ plain_text: "x=1" }], language: "python" },
    });
    expect(slimBlock(code)).toMatchObject({ type: "code", language: "python", text: "x=1" });

    const image = fx<Parameters<typeof slimBlock>[0]>({
      object: "block",
      id: "i1",
      type: "image",
      image: { type: "external", external: { url: "https://e.com/x.png" } },
    });
    expect(slimBlock(image)).toMatchObject({ type: "image", image: "https://e.com/x.png" });
  });
});

describe("slimDatabase", () => {
  it("extracts title and surfaces data_sources, is_locked, in_trash", () => {
    const db = fx<Parameters<typeof slimDatabase>[0]>({
      object: "database",
      id: "d1",
      url: "u",
      title: [{ plain_text: "Tasks" }],
      description: [],
      parent: { type: "page_id" },
      in_trash: false,
      is_inline: false,
      is_locked: true,
      data_sources: [
        { id: "ds-1", name: "Source A" },
        { id: "ds-2", name: "Source B" },
      ],
      icon: { type: "emoji", emoji: "📋" },
      created_time: "t1",
      last_edited_time: "t2",
    });
    expect(slimDatabase(db)).toEqual({
      id: "d1",
      url: "u",
      title: "Tasks",
      parent: { type: "page_id" },
      is_locked: true,
      data_sources: [
        { id: "ds-1", name: "Source A" },
        { id: "ds-2", name: "Source B" },
      ],
      icon: "emoji",
    });
  });

  it("omits is_inline, is_locked, in_trash, and description defaults", () => {
    const db = fx<Parameters<typeof slimDatabase>[0]>({
      object: "database",
      id: "d2",
      url: "u",
      title: [{ plain_text: "Empty" }],
      description: [],
      parent: { type: "page_id" },
      in_trash: false,
      is_inline: false,
      is_locked: false,
      data_sources: [],
      icon: null,
      created_time: "t1",
      last_edited_time: "t2",
    });
    expect(slimDatabase(db)).toEqual({
      id: "d2",
      url: "u",
      title: "Empty",
      parent: { type: "page_id" },
      data_sources: [],
    });
  });
});

describe("slimDataSource", () => {
  it("maps property names to their notion types (so query planners don't need verbose)", () => {
    const ds = fx<Parameters<typeof slimDataSource>[0]>({
      object: "data_source",
      id: "ds1",
      url: "u",
      title: [{ plain_text: "Tasks" }],
      description: [],
      parent: { type: "database_id", database_id: "db1" },
      properties: {
        Name: { type: "title" },
        Priority: { type: "number" },
        Status: { type: "status" },
      },
    });
    expect(slimDataSource(ds)).toMatchObject({
      id: "ds1",
      title: "Tasks",
      properties: { Name: "title", Priority: "number", Status: "status" },
    });
  });
});

describe("slimUser", () => {
  it("includes person.email for person users", () => {
    const u = fx<Parameters<typeof slimUser>[0]>({
      id: "u1",
      type: "person",
      name: "Yara",
      person: { email: "y@e.com" },
    });
    expect(slimUser(u)).toMatchObject({ id: "u1", type: "person", email: "y@e.com" });
  });

  it("includes bot.workspace_name for bot users", () => {
    const u = fx<Parameters<typeof slimUser>[0]>({
      id: "b1",
      type: "bot",
      name: "Bot",
      bot: { workspace_name: "My WS" },
    });
    expect(slimUser(u)).toMatchObject({ id: "b1", type: "bot", workspace_name: "My WS" });
  });

  it("omits avatar_url and workspace_name when missing rather than serializing null", () => {
    const u = fx<Parameters<typeof slimUser>[0]>({
      id: "u2",
      type: "person",
      name: "Anon",
      avatar_url: null,
      person: { email: "a@e.com" },
    });
    const out = slimUser(u) as Record<string, unknown>;
    expect(out).not.toHaveProperty("avatar_url");

    const bot = fx<Parameters<typeof slimUser>[0]>({
      id: "b2",
      type: "bot",
      name: "Bot",
      avatar_url: null,
      bot: {},
    });
    const botOut = slimUser(bot) as Record<string, unknown>;
    expect(botOut).not.toHaveProperty("avatar_url");
    expect(botOut).not.toHaveProperty("workspace_name");
  });
});

describe("slimComment", () => {
  it("collapses rich_text to plain text and drops created_time", () => {
    const c = fx<Parameters<typeof slimComment>[0]>({
      id: "c1",
      parent: { type: "page_id", page_id: "p1" },
      discussion_id: "d1",
      rich_text: [{ plain_text: "hi" }, { plain_text: " there" }],
      created_by: { id: "u1" },
      created_time: "t",
    });
    const out = slimComment(c) as Record<string, unknown>;
    expect(out).toMatchObject({ text: "hi there", created_by: "u1" });
    expect(out).not.toHaveProperty("created_time");
  });
});

describe("slimList", () => {
  it("maps results and normalizes pagination fields", () => {
    const out = slimList(
      {
        results: [fx<Parameters<typeof slimPage>[0]>({ object: "page", id: "p1", properties: {} })],
        has_more: true,
        next_cursor: "n",
      },
      slimPage
    );
    expect(out.has_more).toBe(true);
    expect(out.next_cursor).toBe("n");
    expect(out.results).toHaveLength(1);
  });

  it("defaults missing pagination fields", () => {
    const out = slimList<Parameters<typeof slimPage>[0], ReturnType<typeof slimPage>>(
      { results: [] },
      slimPage
    );
    expect(out.has_more).toBe(false);
    expect(out.next_cursor).toBe(null);
  });
});
