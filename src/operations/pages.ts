import { z } from "zod";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { toErrorEnvelope } from "../utils/error.js";
import { slimPage, slimList } from "../utils/slim.js";
import { parseMarkdownToBlocks } from "../markdown/parse.js";
import { PARENT_SCHEMA } from "../schema/page.js";
import { ICON_SCHEMA } from "../schema/icon.js";
import { FILE_SCHEMA } from "../schema/file.js";
import { RICH_TEXT_ITEM_REQUEST_SCHEMA } from "../schema/rich-text.js";
import {
  CHECKBOX_PROPERTY_VALUE_SCHEMA,
  DATE_PROPERTY_VALUE_SCHEMA,
  EMAIL_PROPERTY_VALUE_SCHEMA,
  FILES_PROPERTY_VALUE_SCHEMA,
  MULTI_SELECT_PROPERTY_VALUE_SCHEMA,
  NUMBER_PROPERTY_VALUE_SCHEMA,
  PEOPLE_PROPERTY_VALUE_SCHEMA,
  PHONE_NUMBER_PROPERTY_VALUE_SCHEMA,
  RELATION_PROPERTY_VALUE_SCHEMA,
  RICH_TEXT_PROPERTY_VALUE_SCHEMA,
  SELECT_PROPERTY_VALUE_SCHEMA,
  STATUS_PROPERTY_VALUE_SCHEMA,
  TITLE_PROPERTY_VALUE_SCHEMA,
  URL_PROPERTY_VALUE_SCHEMA,
  VERIFICATION_PROPERTY_VALUE_SCHEMA,
} from "../schema/page-properties.js";

const VERBOSE = z.boolean().optional();

const PROPERTY_VALUE_SCHEMA = z.union([
  TITLE_PROPERTY_VALUE_SCHEMA,
  RICH_TEXT_PROPERTY_VALUE_SCHEMA,
  NUMBER_PROPERTY_VALUE_SCHEMA,
  SELECT_PROPERTY_VALUE_SCHEMA,
  MULTI_SELECT_PROPERTY_VALUE_SCHEMA,
  STATUS_PROPERTY_VALUE_SCHEMA,
  DATE_PROPERTY_VALUE_SCHEMA,
  PEOPLE_PROPERTY_VALUE_SCHEMA,
  FILES_PROPERTY_VALUE_SCHEMA,
  CHECKBOX_PROPERTY_VALUE_SCHEMA,
  URL_PROPERTY_VALUE_SCHEMA,
  EMAIL_PROPERTY_VALUE_SCHEMA,
  PHONE_NUMBER_PROPERTY_VALUE_SCHEMA,
  RELATION_PROPERTY_VALUE_SCHEMA,
  VERIFICATION_PROPERTY_VALUE_SCHEMA,
]);

function resolveParent(
  parent: z.infer<typeof PARENT_SCHEMA> | undefined
): z.infer<typeof PARENT_SCHEMA> | undefined {
  if (parent) return parent;
  const envId = process.env.NOTION_PAGE_ID;
  if (envId) return { type: "page_id", page_id: envId };
  return undefined;
}

// ──────────────────────────────────────────────────────────────────────────
// create_page
// ──────────────────────────────────────────────────────────────────────────

const CreatePageParams = z
  .object({
    parent: PARENT_SCHEMA.optional(),
    title: z.string().optional().describe("Shortcut for setting the title property."),
    properties: z.record(z.string(), PROPERTY_VALUE_SCHEMA).optional(),
    markdown: z.string().optional().describe("Page body as markdown. Parsed server-side."),
    children: z.array(z.unknown()).optional().describe("Structured Notion blocks. Mutually exclusive with markdown."),
    icon: ICON_SCHEMA.nullable().optional(),
    cover: FILE_SCHEMA.nullable().optional(),
    verbose: VERBOSE,
  })
  .refine((v) => !(v.markdown && v.children), {
    message: "Pass either `markdown` or `children`, not both.",
  });

register({
  name: "create_page",
  description: "Create a new Notion page. Body can be markdown (recommended) or structured blocks.",
  batchable: true,
  schema: CreatePageParams,
  example: {
    parent: { type: "page_id", page_id: "<parent-page-id>" },
    title: "My new page",
    markdown: "## Hello\n\nThis is the body as **markdown**.",
  },
  exampleBatch: {
    items: [
      { title: "Page 1", markdown: "First page body." },
      { title: "Page 2", markdown: "Second page body." },
    ],
    concurrency: 3,
  },
  rollback: async (data) => {
    if (typeof data !== "object" || data === null) return;
    const id = (data as { id?: string }).id;
    if (!id) return;
    const notion = await getClient();
    await notion.pages.update({ page_id: id, in_trash: true });
  },
  handler: async (params) => {
    try {
      const parent = resolveParent(params.parent);
      if (!parent) {
        return {
          ok: false,
          error: {
            code: "missing_parent",
            message: "No parent specified and NOTION_PAGE_ID is not set.",
            fix: "Pass `parent: {type:'page_id', page_id:'...'}` or set NOTION_PAGE_ID in the environment.",
          },
        };
      }
      const properties: Record<string, unknown> = { ...(params.properties ?? {}) };
      if (params.title && !properties.title) {
        properties.title = {
          title: [{ type: "text", text: { content: params.title } }],
        };
      }
      const children = params.markdown
        ? parseMarkdownToBlocks(params.markdown)
        : params.children;

      const notion = await getClient();
      const response = await notion.pages.create({
        parent: parent as never,
        properties: properties as never,
        ...(children && children.length ? { children: children as never } : {}),
        ...(params.icon !== undefined ? { icon: params.icon as never } : {}),
        ...(params.cover !== undefined ? { cover: params.cover as never } : {}),
      });
      return { ok: true, data: slimPage(response, params.verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// set_page_title
// ──────────────────────────────────────────────────────────────────────────

const SetPageTitleParams = z.object({
  page_id: z.string(),
  title: z.string(),
  verbose: VERBOSE,
});

register({
  name: "set_page_title",
  description: "Rename a page. Updates the page's title property.",
  batchable: true,
  schema: SetPageTitleParams,
  example: { page_id: "<page-id>", title: "New title" },
  exampleBatch: {
    items: [
      { page_id: "<page-id-1>", title: "Renamed 1" },
      { page_id: "<page-id-2>", title: "Renamed 2" },
    ],
  },
  handler: async ({ page_id, title, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.pages.update({
        page_id,
        properties: {
          title: {
            title: [{ type: "text", text: { content: title } }],
          },
        } as never,
      });
      return { ok: true, data: slimPage(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// set_page_property
// ──────────────────────────────────────────────────────────────────────────

const SetPagePropertyParams = z.object({
  page_id: z.string(),
  name: z.string().describe("Property name (case-sensitive). Use `title` for the title property."),
  value: PROPERTY_VALUE_SCHEMA.describe(
    "Property value object matching the property type, e.g. {checkbox: true}, {select: {name: 'Open'}}."
  ),
  verbose: VERBOSE,
});

register({
  name: "set_page_property",
  description: "Set one property on one page. For batch updates use items[].",
  batchable: true,
  schema: SetPagePropertyParams,
  example: {
    page_id: "<page-id>",
    name: "Status",
    value: { status: { name: "In progress" } },
  },
  exampleBatch: {
    items: [
      { page_id: "<page-id>", name: "Checked", value: { checkbox: true } },
      { page_id: "<page-id>", name: "Score", value: { number: 42 } },
    ],
  },
  handler: async ({ page_id, name, value, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.pages.update({
        page_id,
        properties: { [name]: value } as never,
      });
      return { ok: true, data: slimPage(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// set_page_properties (plural)
// ──────────────────────────────────────────────────────────────────────────

const SetPagePropertiesParams = z.object({
  page_id: z.string(),
  properties: z
    .record(z.string(), PROPERTY_VALUE_SCHEMA)
    .describe(
      "Map of property name → value, written in one API call. Use this when updating multiple properties on the same page."
    ),
  verbose: VERBOSE,
});

register({
  name: "set_page_properties",
  description: "Set multiple properties on one page in a single API call. Use set_page_property for one-off updates.",
  batchable: true,
  schema: SetPagePropertiesParams,
  example: {
    page_id: "<page-id>",
    properties: {
      Status: { status: { name: "In progress" } },
      Score: { number: 42 },
      Done: { checkbox: false },
    },
  },
  exampleBatch: {
    items: [
      {
        page_id: "<page-id-1>",
        properties: { Status: { status: { name: "Done" } } },
      },
      {
        page_id: "<page-id-2>",
        properties: { Status: { status: { name: "Done" } } },
      },
    ],
  },
  handler: async ({ page_id, properties, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.pages.update({
        page_id,
        properties: properties as never,
      });
      return { ok: true, data: slimPage(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// archive_page / restore_page
// ──────────────────────────────────────────────────────────────────────────

const PageIdParams = z.object({ page_id: z.string(), verbose: VERBOSE });

register({
  name: "archive_page",
  description: "Move a page to trash. Reversible via restore_page.",
  batchable: true,
  schema: PageIdParams,
  example: { page_id: "<page-id>" },
  exampleBatch: { items: [{ page_id: "<page-id-1>" }, { page_id: "<page-id-2>" }] },
  handler: async ({ page_id, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.pages.update({ page_id, in_trash: true });
      return { ok: true, data: slimPage(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

register({
  name: "restore_page",
  description: "Restore a page previously moved to trash.",
  batchable: true,
  schema: PageIdParams,
  example: { page_id: "<page-id>" },
  handler: async ({ page_id, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.pages.update({ page_id, in_trash: false });
      return { ok: true, data: slimPage(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// search_pages
// ──────────────────────────────────────────────────────────────────────────

const SearchPagesParams = z.object({
  query: z.string().optional().describe("Title substring. Notion search is title-only — it does not search page body content."),
  sort_direction: z.enum(["ascending", "descending"]).optional(),
  page_size: z.number().min(1).max(100).optional(),
  start_cursor: z.string().optional(),
  verbose: VERBOSE,
});

register({
  name: "search_pages",
  description: "Search pages and databases by title. Title-only; does NOT search page body content.",
  batchable: false,
  schema: SearchPagesParams,
  example: { query: "smoke test", page_size: 10 },
  handler: async ({ query, sort_direction, page_size, start_cursor, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.search({
        query: query ?? "",
        ...(sort_direction
          ? { sort: { direction: sort_direction, timestamp: "last_edited_time" as const } }
          : {}),
        page_size: page_size ?? 10,
        start_cursor,
      });
      return {
        ok: true,
        data: slimList(response, slimPage, verbose ?? false),
      };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

// ──────────────────────────────────────────────────────────────────────────
// get_page
// ──────────────────────────────────────────────────────────────────────────

const GetPageParams = z.object({ page_id: z.string(), verbose: VERBOSE });

register({
  name: "get_page",
  description: "Retrieve a page's metadata and properties (no body blocks — use get_block_children for those).",
  batchable: true,
  schema: GetPageParams,
  example: { page_id: "<page-id>" },
  handler: async ({ page_id, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.pages.retrieve({ page_id });
      return { ok: true, data: slimPage(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

const MovePageParams = z.object({
  page_id: z.string(),
  new_parent: PARENT_SCHEMA.describe("New parent (page_id, database_id, data_source_id, block_id, or workspace)."),
  verbose: VERBOSE,
});

register({
  name: "move_page",
  description: "Move a page to a new parent without recreating it. Preserves the page's blocks, properties, and comments.",
  batchable: true,
  schema: MovePageParams,
  example: {
    page_id: "<page-id>",
    new_parent: { type: "page_id", page_id: "<new-parent-id>" },
  },
  exampleBatch: {
    items: [
      { page_id: "<p1>", new_parent: { type: "page_id", page_id: "<dest>" } },
      { page_id: "<p2>", new_parent: { type: "page_id", page_id: "<dest>" } },
    ],
  },
  handler: async ({ page_id, new_parent, verbose }) => {
    try {
      const notion = await getClient();
      const response = await notion.pages.move({
        page_id,
        new_parent: new_parent as never,
      } as never);
      return { ok: true, data: slimPage(response, verbose ?? false) };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

const GetPageMarkdownParams = z.object({
  page_id: z.string(),
});

register({
  name: "get_page_markdown",
  description: "Return a page's body as Notion-rendered markdown. Server-side conversion; round-trips with update_page_markdown.",
  batchable: true,
  schema: GetPageMarkdownParams,
  example: { page_id: "<page-id>" },
  handler: async ({ page_id }) => {
    try {
      const notion = await getClient();
      const response = await notion.pages.retrieveMarkdown({ page_id });
      return {
        ok: true,
        data: { page_id, markdown: (response as { markdown?: string }).markdown ?? "" },
      };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

const UpdatePageMarkdownParams = z.object({
  page_id: z.string(),
  markdown: z.string().describe("New page content as Notion-flavored markdown. Replaces existing body unless insert_content is set."),
  insert_content: z
    .object({
      position: z.enum(["start", "end"]).describe("Insert at start or end instead of replacing."),
    })
    .optional(),
});

register({
  name: "update_page_markdown",
  description: "Replace (or insert into) a page's body using Notion's server-side markdown renderer. Skip the local remark pipeline.",
  batchable: true,
  schema: UpdatePageMarkdownParams,
  example: {
    page_id: "<page-id>",
    markdown: "## Updated heading\n\nNew body.",
  },
  handler: async ({ page_id, markdown, insert_content }) => {
    try {
      const notion = await getClient();
      const response = await notion.pages.updateMarkdown({
        page_id,
        markdown,
        ...(insert_content ? { insert_content } : {}),
      } as never);
      return { ok: true, data: { page_id: (response as { id?: string }).id ?? page_id } };
    } catch (error) {
      return { ok: false, error: toErrorEnvelope(error) };
    }
  },
});

void RICH_TEXT_ITEM_REQUEST_SCHEMA;
