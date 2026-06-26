import { z } from "zod";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimPage, slimItem, slimList } from "../utils/slim.js";
import { paginateAll } from "../utils/paginate.js";
import type { OperationResult } from "./types.js";
import { parseMarkdownToBlocks } from "../markdown/parse.js";
import { PARENT_SCHEMA } from "../schema/page.js";
import { ICON_SCHEMA } from "../schema/icon.js";
import { FILE_SCHEMA } from "../schema/file.js";
import { RICH_TEXT_ITEM_REQUEST_SCHEMA } from "../schema/rich-text.js";
import {
  asSdk,
  type CreatePageBody,
  type MovePageBody,
  type UpdatePageBody,
  type UpdatePageMarkdownBody,
} from "../utils/notion-types.js";
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
    template: z
      .object({
        type: z.enum(["default", "none", "template_id"]).describe("`template_id` to apply a specific template, `default` for the data source's default template, `none` for no template."),
        template_id: z.string().optional().describe("Required when type is 'template_id'. Discover IDs via list_data_source_templates."),
        timezone: z.string().optional().describe("IANA tz (e.g. 'Asia/Hong_Kong') controlling @now/@today resolution inside the template."),
      })
      .optional()
      .describe("Create the page from a Notion template. The API forbids `markdown`/`children` alongside a template; only data_source_id parents support templates."),
    icon: ICON_SCHEMA.nullable().optional(),
    cover: FILE_SCHEMA.nullable().optional(),
    verbose: VERBOSE,
  })
  .refine((v) => !(v.markdown && v.children), {
    message: "Pass either `markdown` or `children`, not both.",
  })
  .refine((v) => !(v.template && (v.markdown || v.children)), {
    message: "Pass either a `template` or body content (`markdown`/`children`), not both — the Notion API rejects children alongside a template.",
  })
  .refine((v) => !(v.template?.type === "template_id" && !v.template.template_id), {
    message: "template.template_id is required when template.type is 'template_id'.",
  });

register({
  name: "create_page",
  access: "write",
  domain: "pages",
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
    await notion.pages.update(asSdk<UpdatePageBody>({ page_id: id, in_trash: true }));
  },
  handler: tryHandler(async (params) => {
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
    // A template and explicit body content are mutually exclusive (API rule).
    const children = params.template
      ? undefined
      : params.markdown
        ? parseMarkdownToBlocks(params.markdown)
        : params.children;

    const notion = await getClient();
    const body = {
      parent,
      properties,
      ...(children && children.length ? { children } : {}),
      ...(params.template ? { template: params.template } : {}),
      ...(params.icon !== undefined ? { icon: params.icon } : {}),
      ...(params.cover !== undefined ? { cover: params.cover } : {}),
    };
    const response = await notion.pages.create(asSdk<CreatePageBody>(body));
    return { ok: true, data: slimPage(response, params.verbose ?? false) };
  }),
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
  access: "write",
  domain: "pages",
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
  handler: tryHandler(async ({ page_id, title, verbose }) => {
    const notion = await getClient();
    const response = await notion.pages.update(
      asSdk<UpdatePageBody>({
        page_id,
        properties: {
          title: { title: [{ type: "text", text: { content: title } }] },
        },
      })
    );
    return { ok: true, data: slimPage(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// set_page_property
// ──────────────────────────────────────────────────────────────────────────

// For the title property, accept a bare string as a shorthand and wrap it into
// Notion's rich-text array shape. Avoids forcing the LLM to know the verbose
// {title:[{type:"text",text:{content}}]} form for the most common case.
function wrapTitleShorthand(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const obj = input as Record<string, unknown>;
  if (obj.name === "title" && typeof obj.value === "string") {
    return {
      ...obj,
      value: { title: [{ type: "text", text: { content: obj.value } }] },
    };
  }
  return input;
}

const SetPagePropertyParams = z.preprocess(
  wrapTitleShorthand,
  z.object({
    page_id: z.string(),
    name: z.string().describe("Property name (case-sensitive). Use `title` for the title property; you may pass value as a plain string in that case."),
    value: PROPERTY_VALUE_SCHEMA.describe(
      "Property value object matching the property type, e.g. {checkbox: true}, {select: {name: 'Open'}}. For `name: 'title'` a plain string is accepted as a shorthand."
    ),
    verbose: VERBOSE,
  })
);

register({
  name: "set_page_property",
  access: "write",
  domain: "pages",
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
  handler: tryHandler(async ({ page_id, name, value, verbose }) => {
    const notion = await getClient();
    const response = await notion.pages.update(
      asSdk<UpdatePageBody>({ page_id, properties: { [name]: value } })
    );
    return { ok: true, data: slimPage(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// set_page_properties (plural)
// ──────────────────────────────────────────────────────────────────────────

function wrapTitleShorthandInProperties(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  const obj = input as Record<string, unknown>;
  const props = obj.properties;
  if (typeof props !== "object" || props === null) return input;
  const propsObj = props as Record<string, unknown>;
  if (typeof propsObj.title !== "string") return input;
  return {
    ...obj,
    properties: {
      ...propsObj,
      title: { title: [{ type: "text", text: { content: propsObj.title } }] },
    },
  };
}

const SetPagePropertiesParams = z.preprocess(
  wrapTitleShorthandInProperties,
  z.object({
    page_id: z.string(),
    properties: z
      .record(z.string(), PROPERTY_VALUE_SCHEMA)
      .describe(
        "Map of property name → value, written in one API call. Use this when updating multiple properties on the same page. For the `title` key, a plain string is accepted as a shorthand."
      ),
    verbose: VERBOSE,
  })
);

register({
  name: "set_page_properties",
  access: "write",
  domain: "pages",
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
  handler: tryHandler(async ({ page_id, properties, verbose }) => {
    const notion = await getClient();
    const response = await notion.pages.update(
      asSdk<UpdatePageBody>({ page_id, properties })
    );
    return { ok: true, data: slimPage(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// archive_page / restore_page
// ──────────────────────────────────────────────────────────────────────────

const PageIdParams = z.object({ page_id: z.string(), verbose: VERBOSE });

const archivePageHandler = tryHandler(async ({ page_id, verbose }: z.infer<typeof PageIdParams>) => {
  const notion = await getClient();
  const response = await notion.pages.update(
    asSdk<UpdatePageBody>({ page_id, in_trash: true })
  );
  return { ok: true as const, data: slimPage(response, verbose ?? false) };
});

register({
  name: "archive_page",
  access: "write",
  domain: "pages",
  destructive: true,
  description: "Move a page to trash. Reversible via restore_page. Alias: trash_page.",
  batchable: true,
  schema: PageIdParams,
  example: { page_id: "<page-id>" },
  exampleBatch: { items: [{ page_id: "<page-id-1>" }, { page_id: "<page-id-2>" }] },
  handler: archivePageHandler,
});

register({
  name: "trash_page",
  access: "write",
  domain: "pages",
  destructive: true,
  description: "Alias of archive_page (2025-09-03 surface naming). Moves a page to trash.",
  batchable: true,
  schema: PageIdParams,
  example: { page_id: "<page-id>" },
  exampleBatch: { items: [{ page_id: "<page-id-1>" }, { page_id: "<page-id-2>" }] },
  handler: archivePageHandler,
});

register({
  name: "restore_page",
  access: "write",
  domain: "pages",
  description: "Restore a page previously moved to trash.",
  batchable: true,
  schema: PageIdParams,
  example: { page_id: "<page-id>" },
  handler: tryHandler(async ({ page_id, verbose }) => {
    const notion = await getClient();
    const response = await notion.pages.update(
      asSdk<UpdatePageBody>({ page_id, in_trash: false })
    );
    return { ok: true, data: slimPage(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// search_pages
// ──────────────────────────────────────────────────────────────────────────

const SearchPagesParams = z.object({
  query: z.string().optional().describe("Title substring. Notion search is title-only — it does not search page body content."),
  sort_direction: z.enum(["ascending", "descending"]).optional(),
  page_size: z.number().min(1).max(100).optional(),
  start_cursor: z.string().optional(),
  paginate: z
    .boolean()
    .optional()
    .describe("Auto-walk all pages and return combined results. Ignores start_cursor when set."),
  page_limit: z
    .number()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max pages to fetch when paginate=true (default 10, ~1000 items with page_size=100)."),
  verbose: VERBOSE,
});

register({
  name: "search_pages",
  access: "read",
  domain: "pages",
  description: "Search pages and databases by title. Title-only; does NOT search page body content. Pass paginate:true to auto-walk all pages.",
  batchable: false,
  schema: SearchPagesParams,
  example: { query: "smoke test", page_size: 10 },
  handler: tryHandler(async ({ query, sort_direction, page_size, start_cursor, paginate, page_limit, verbose }): Promise<OperationResult> => {
    const notion = await getClient();
    const sort = sort_direction
      ? { sort: { direction: sort_direction, timestamp: "last_edited_time" as const } }
      : {};

    if (paginate) {
      const { results, truncated, pages_walked } = await paginateAll(
        async (cursor) => {
          const r = await notion.search({
            query: query ?? "",
            ...sort,
            page_size: page_size ?? 100,
            start_cursor: cursor,
          });
          return { results: r.results, has_more: r.has_more, next_cursor: r.next_cursor };
        },
        { limit: page_limit }
      );
      return {
        ok: true,
        data: {
          results: results.map((item) => slimItem(item, verbose ?? false)),
          truncated,
          pages_walked,
        },
      };
    }

    const response = await notion.search({
      query: query ?? "",
      ...sort,
      page_size: page_size ?? 10,
      start_cursor,
    });
    return { ok: true, data: slimList(response, slimItem, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// get_page
// ──────────────────────────────────────────────────────────────────────────

const GetPageParams = z.object({
  page_id: z.string(),
  include_properties: z
    .boolean()
    .optional()
    .describe(
      "When true, attach the page's properties as a flattened name → value map. Off by default to keep the slim response tight; use `verbose: true` for the raw Notion SDK shape."
    ),
  verbose: VERBOSE,
});

register({
  name: "get_page",
  access: "read",
  domain: "pages",
  description:
    "Retrieve a page's metadata and (optionally) properties. No body blocks — use get_block_children for those. Pass `include_properties: true` to also return a flattened properties map.",
  batchable: true,
  schema: GetPageParams,
  example: { page_id: "<page-id>" },
  handler: tryHandler(async ({ page_id, include_properties, verbose }) => {
    const notion = await getClient();
    const response = await notion.pages.retrieve({ page_id });
    return {
      ok: true,
      data: slimPage(response, verbose ?? false, include_properties ?? false),
    };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// move_page
// ──────────────────────────────────────────────────────────────────────────

const MovePageParams = z.object({
  page_id: z.string(),
  parent: PARENT_SCHEMA.describe("New parent (page_id or data_source_id). Same shape as create_page's `parent`."),
  verbose: VERBOSE,
});

register({
  name: "move_page",
  access: "write",
  domain: "pages",
  description: "Move a page to a new parent without recreating it. Preserves the page's blocks, properties, and comments. The destination uses `parent` — same field name as create_page.",
  batchable: true,
  schema: MovePageParams,
  example: {
    page_id: "<page-id>",
    parent: { type: "page_id", page_id: "<new-parent-id>" },
  },
  exampleBatch: {
    items: [
      { page_id: "<p1>", parent: { type: "page_id", page_id: "<dest>" } },
      { page_id: "<p2>", parent: { type: "page_id", page_id: "<dest>" } },
    ],
  },
  handler: tryHandler(async ({ page_id, parent, verbose }) => {
    if (parent.type !== "page_id" && parent.type !== "data_source_id") {
      return {
        ok: false,
        error: {
          code: "unsupported_parent",
          message: `move_page only accepts page_id or data_source_id, received ${parent.type}.`,
          fix:
            parent.type === "database_id"
              ? "Call list_data_sources on the database and pass the resolved data_source_id."
              : "Set parent.type to 'page_id' or 'data_source_id'.",
        },
      };
    }
    const notion = await getClient();
    const response = await notion.pages.move(
      asSdk<MovePageBody>({ page_id, parent })
    );
    return { ok: true, data: slimPage(response, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// get_page_markdown
// ──────────────────────────────────────────────────────────────────────────

const GetPageMarkdownParams = z.object({
  page_id: z.string(),
});

register({
  name: "get_page_markdown",
  access: "read",
  domain: "pages",
  description: "Return a page's body as Notion-rendered markdown. Server-side conversion; round-trips with update_page_markdown.",
  batchable: true,
  schema: GetPageMarkdownParams,
  example: { page_id: "<page-id>" },
  handler: tryHandler(async ({ page_id }) => {
    const notion = await getClient();
    const response = await notion.pages.retrieveMarkdown({ page_id });
    return { ok: true, data: { page_id, markdown: response.markdown ?? "" } };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// update_page_markdown
// ──────────────────────────────────────────────────────────────────────────

const UpdatePageMarkdownParams = z.object({
  page_id: z.string(),
  markdown: z.string().describe("Markdown content. Replaces the existing body by default; with insert_content it is inserted instead."),
  insert_content: z
    .object({
      position: z.enum(["start", "end"]).describe("Insert at start or end of the page."),
      after: z.string().optional().describe("Block id to insert after (mutually exclusive with position in practice — Notion uses whichever is provided)."),
    })
    .optional(),
  allow_deleting_content: z
    .boolean()
    .optional()
    .describe("Required true when a replace would remove existing blocks; the API rejects destructive replaces without it."),
});

register({
  name: "update_page_markdown",
  access: "write",
  domain: "pages",
  description: "Replace (or insert into) a page's body using Notion's server-side markdown renderer. Skip the local remark pipeline.",
  batchable: true,
  schema: UpdatePageMarkdownParams,
  example: {
    page_id: "<page-id>",
    markdown: "## Updated heading\n\nNew body.",
    allow_deleting_content: true,
  },
  handler: tryHandler(async ({ page_id, markdown, insert_content, allow_deleting_content }) => {
    const notion = await getClient();
    const body = insert_content
      ? {
          page_id,
          type: "insert_content" as const,
          insert_content: {
            content: markdown,
            ...(insert_content.after ? { after: insert_content.after } : {}),
            position: { type: insert_content.position },
          },
        }
      : {
          page_id,
          type: "replace_content" as const,
          replace_content: {
            new_str: markdown,
            ...(allow_deleting_content !== undefined ? { allow_deleting_content } : {}),
          },
        };
    const response = await notion.pages.updateMarkdown(asSdk<UpdatePageMarkdownBody>(body));
    return { ok: true, data: { page_id: response.id ?? page_id } };
  }),
});

void RICH_TEXT_ITEM_REQUEST_SCHEMA;
