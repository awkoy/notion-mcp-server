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

  // Every block subtype keeps its text under a different key; `text` should
  // name the block whatever that key happens to be.
  const blockText = (type: string, inner: unknown) =>
    (
      slimBlock(
        fx<Parameters<typeof slimBlock>[0]>({ object: "block", id: `${type}1`, type, [type]: inner })
      ) as { text?: string }
    ).text;

  it("surfaces the title of child_page and child_database blocks", () => {
    expect(blockText("child_page", { title: "Roadmap" })).toBe("Roadmap");
    expect(blockText("child_database", { title: "Tasks" })).toBe("Tasks");
  });

  it("surfaces an equation's LaTeX expression", () => {
    expect(blockText("equation", { expression: "E = mc^2" })).toBe("E = mc^2");
  });

  it("falls back to the caption on media and link blocks", () => {
    const file = { url: "https://e.com/x" };
    expect(blockText("bookmark", { url: "https://e.com", caption: [{ plain_text: "the spec" }] })).toBe("the spec");
    expect(blockText("embed", { url: "https://e.com", caption: [{ plain_text: "a demo" }] })).toBe("a demo");
    expect(blockText("image", { type: "external", external: file, caption: [{ plain_text: "the diagram" }] })).toBe("the diagram");
    expect(blockText("video", { type: "external", external: file, caption: [{ plain_text: "the walkthrough" }] })).toBe("the walkthrough");
    expect(blockText("pdf", { type: "external", external: file, caption: [{ plain_text: "the contract" }] })).toBe("the contract");
    expect(blockText("audio", { type: "external", external: file, caption: [{ plain_text: "the interview" }] })).toBe("the interview");
  });

  it("keeps an image's caption alongside its url", () => {
    const image = fx<Parameters<typeof slimBlock>[0]>({
      object: "block",
      id: "i2",
      type: "image",
      image: {
        type: "external",
        external: { url: "https://e.com/x.png" },
        caption: [{ plain_text: "the diagram" }],
      },
    });
    // slimBlock gives image its own branch; the caption must survive the spread.
    expect(slimBlock(image)).toMatchObject({
      type: "image",
      image: "https://e.com/x.png",
      text: "the diagram",
    });
  });

  it("names an uncaptioned file by its filename", () => {
    const inner = { type: "file", file: { url: "https://e.com/q.pdf" }, name: "Q3-report.pdf" };
    expect(blockText("file", { ...inner, caption: [] })).toBe("Q3-report.pdf");
    // An authored caption still outranks the filename.
    expect(blockText("file", { ...inner, caption: [{ plain_text: "the quarterly" }] })).toBe("the quarterly");
  });

  it("falls back to the url when a link block has no caption", () => {
    expect(blockText("bookmark", { url: "https://spec.example", caption: [] })).toBe("https://spec.example");
    expect(blockText("embed", { url: "https://e.com/demo" })).toBe("https://e.com/demo");
    // link_preview has no caption key at all.
    expect(blockText("link_preview", { url: "https://github.com/x/y/pull/1" })).toBe("https://github.com/x/y/pull/1");
  });

  it("describes a table_row by its cells", () => {
    expect(blockText("table_row", { cells: [[{ plain_text: "Alice" }], [{ plain_text: "42" }]] })).toBe("Alice | 42");
    expect(blockText("table_row", { cells: [[], []] })).toBeUndefined();
  });

  it("prefers a code block's source over its caption, but falls through when empty", () => {
    const captioned = { caption: [{ plain_text: "prints one" }], language: "python" };
    expect(blockText("code", { ...captioned, rich_text: [{ plain_text: "print(1)" }] })).toBe("print(1)");
    // An empty source must not win with "" and swallow the caption.
    expect(blockText("code", { ...captioned, rich_text: [] })).toBe("prints one");
  });

  it("tolerates malformed rich text instead of throwing", () => {
    // slimBlock is mapped across a whole page, so one odd block must not
    // abort the entire response.
    expect(blockText("image", { type: "external", external: { url: "https://e.com/x.png" }, caption: [null] })).toBeUndefined();
    expect(blockText("paragraph", { rich_text: [null, { plain_text: "kept" }] })).toBe("kept");
  });

  it("leaves text undefined for blocks that carry none", () => {
    expect(blockText("divider", {})).toBeUndefined();
    expect(blockText("child_page", { title: "" })).toBeUndefined();
    expect(blockText("equation", { expression: "" })).toBeUndefined();
    expect(blockText("paragraph", { rich_text: [] })).toBeUndefined();
    // A subtype whose payload key is missing entirely must not throw.
    const bare = fx<Parameters<typeof slimBlock>[0]>({ object: "block", id: "u1", type: "unsupported" });
    expect((slimBlock(bare) as { text?: string }).text).toBeUndefined();
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

describe("slimBlock — table rows", () => {
  it("returns a table_row's cells as plain strings", () => {
    const row = fx<Parameters<typeof slimBlock>[0]>({
      object: "block",
      id: "r1",
      type: "table_row",
      has_children: false,
      in_trash: false,
      table_row: {
        cells: [
          [{ type: "text", plain_text: "Ap", text: { content: "Ap" } }, { type: "text", plain_text: "ple", text: { content: "ple" } }],
          [],
          [{ type: "text", plain_text: "3", text: { content: "3" } }],
        ],
      },
    });
    expect(slimBlock(row)).toMatchObject({ id: "r1", type: "table_row", cells: ["Apple", "", "3"] });
  });

  it("reports a table's width", () => {
    const table = fx<Parameters<typeof slimBlock>[0]>({
      object: "block",
      id: "t1",
      type: "table",
      has_children: true,
      in_trash: false,
      table: { table_width: 3, has_column_header: true, has_row_header: false },
    });
    expect(slimBlock(table)).toMatchObject({ id: "t1", type: "table", table_width: 3, has_children: true });
  });
});

describe("slimDataSource — option names", () => {
  it("lists the options of select, multi_select and status properties and the target of a relation", () => {
    const ds = fx<Parameters<typeof slimDataSource>[0]>({
      object: "data_source",
      id: "ds1",
      url: "u",
      title: [{ plain_text: "Tasks" }],
      description: [],
      parent: { type: "database_id", database_id: "db1" },
      properties: {
        Name: { type: "title", title: {} },
        Status: {
          type: "status",
          status: { options: [{ name: "Not Started" }, { name: "In Progress" }, { name: "Done" }], groups: [] },
        },
        Tags: { type: "multi_select", multi_select: { options: [{ name: "a" }, { name: "b" }] } },
        Kind: { type: "select", select: { options: [] } },
        Project: { type: "relation", relation: { data_source_id: "ds-projects", type: "single_property" } },
      },
    });
    expect(slimDataSource(ds)).toMatchObject({
      properties: {
        Name: "title",
        Status: "status: Not Started | In Progress | Done",
        Tags: "multi_select: a | b",
        Kind: "select",
        Project: "relation → ds-projects",
      },
    });
  });

  it("caps a long option list", () => {
    const options = Array.from({ length: 40 }, (_, i) => ({ name: `o${i}` }));
    const ds = fx<Parameters<typeof slimDataSource>[0]>({
      object: "data_source",
      id: "ds1",
      url: "u",
      title: [],
      description: [],
      parent: { type: "database_id", database_id: "db1" },
      properties: { Many: { type: "select", select: { options } } },
    });
    const text = (slimDataSource(ds) as { properties: Record<string, string> }).properties.Many;
    expect(text.startsWith("select: o0 | o1 |")).toBe(true);
    expect(text.endsWith("| o29 | +10 more")).toBe(true);
  });
});
