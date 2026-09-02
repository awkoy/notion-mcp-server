import { z } from "zod";
import { isFullDatabase } from "@notionhq/client";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimDatabase, slimItem, slimList } from "../utils/slim.js";
import type { SearchItemResponse } from "../utils/slim.js";
import { DATABASE_PROPERTY_SCHEMA } from "../schema/database.js";
import { PARENT_SCHEMA } from "../schema/page.js";
import { ICON_SCHEMA } from "../schema/icon.js";
import { FILE_SCHEMA } from "../schema/file.js";
import { TEXT_RICH_TEXT_ITEM_REQUEST_SCHEMA } from "../schema/rich-text.js";
import { WHERE_SCHEMA, compileWhere, type PropertyTypes } from "../schema/filter-dsl.js";
import { getDataSourceSchema } from "../services/schema-cache.js";
import type { OperationResult } from "./types.js";
import {
  asSdk,
  type CreateDatabaseBody,
  type QueryDataSourceBody,
  type UpdateDatabaseBody,
} from "../utils/notion-types.js";
import { normalizeNotionId, notionId } from "../schema/id.js";

const VERBOSE = z.boolean().optional();

// Notion's `dataSources.query` accepts page_size up to 100. For
// query_database, `page_limit` is the cap in ITEMS (rows), distinct from the
// `paginate.ts` helper's `limit` which counts PAGES — query rows are the
// natural unit because users care about row counts when they ask for
// "everything matching this filter".
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_ITEM_LIMIT = 1000;
const MAX_ITEM_LIMIT = 1000;

// ──────────────────────────────────────────────────────────────────────────
// create_database
// ──────────────────────────────────────────────────────────────────────────

const CreateDatabaseParams = z.object({
  parent: PARENT_SCHEMA.optional(),
  title: z.string().optional().describe("Plain-text title shortcut."),
  title_rich: z.array(TEXT_RICH_TEXT_ITEM_REQUEST_SCHEMA).optional().describe("Rich-text title; overrides `title`."),
  description: z.array(TEXT_RICH_TEXT_ITEM_REQUEST_SCHEMA).optional(),
  properties: z.record(z.string(), DATABASE_PROPERTY_SCHEMA),
  is_inline: z.boolean().optional(),
  icon: ICON_SCHEMA.nullable().optional(),
  cover: FILE_SCHEMA.nullable().optional(),
  verbose: VERBOSE,
});

function resolveParent(parent: z.infer<typeof PARENT_SCHEMA> | undefined) {
  if (parent) return parent;
  const envId = process.env.NOTION_PAGE_ID;
  if (envId) return { type: "page_id" as const, page_id: normalizeNotionId(envId) };
  return undefined;
}

register({
  name: "create_database",
  access: "write",
  domain: "databases",
  description: "Create a new database. Properties is a map of name → property-type definition.",
  batchable: true,
  schema: CreateDatabaseParams,
  example: {
    title: "Tasks",
    properties: {
      Name: { type: "title", title: {} },
      Status: {
        type: "select",
        select: {
          options: [
            { name: "Open", color: "blue" },
            { name: "Done", color: "green" },
          ],
        },
      },
    },
  },
  rollback: async (data) => {
    if (typeof data !== "object" || data === null) return;
    const id = (data as { id?: string }).id;
    if (!id) return;
    const notion = await getClient();
    await notion.databases.update(asSdk<UpdateDatabaseBody>({ database_id: id, in_trash: true }));
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
    const titleRich = params.title_rich
      ? params.title_rich
      : params.title
        ? [{ type: "text" as const, text: { content: params.title } }]
        : [];
    const notion = await getClient();
    const body = {
      parent,
      title: titleRich,
      ...(params.description ? { description: params.description } : {}),
      initial_data_source: { properties: params.properties },
      is_inline: params.is_inline ?? false,
      ...(params.icon !== undefined ? { icon: params.icon } : {}),
      ...(params.cover !== undefined ? { cover: params.cover } : {}),
    };
    const response = await notion.databases.create(asSdk<CreateDatabaseBody>(body));
    return { ok: true, data: slimDatabase(response, params.verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// query_database
// ──────────────────────────────────────────────────────────────────────────

type Sort =
  | { property: string; direction: "ascending" | "descending" }
  | { timestamp: "created_time" | "last_edited_time"; direction: "ascending" | "descending" };

/** `"-Due Date"` → `{ property: "Due Date", direction: "descending" }`. */
function compileSort(sort: string | Sort): Sort {
  if (typeof sort !== "string") return sort;
  const descending = sort.startsWith("-");
  const name = descending ? sort.slice(1) : sort;
  const direction = descending ? "descending" : "ascending";
  if (name === "created_time" || name === "last_edited_time") return { timestamp: name, direction };
  return { property: name, direction };
}

const QueryDatabaseParams = z
  .object({
    database_id: notionId()
      .optional()
      .describe(
        "Database ID. If the database has exactly one data source, we resolve it automatically. For multi-source databases, pass data_source_id instead."
      ),
    data_source_id: notionId()
      .optional()
      .describe(
        "Data source ID. Use for multi-source databases or when you've already resolved the source via list_data_sources."
      ),
    where: WHERE_SCHEMA.optional().describe(
      "Filter by property name: a plain value means equals ({ Status: 'Done', Priority: 'High' }), an operator object refines it ({ Score: { gte: 3 }, Name: { contains: 'x' }, Due: { before: '2026-01-01' } }, null means empty), AND/OR arrays and NOT compose. Property types come from the data source, so status and select just work. Mutually exclusive with `filter`."
    ),
    filter: z.unknown().optional().describe(
      "Raw Notion filter JSON. Use this for edge cases the `where` DSL can't express. Mutually exclusive with `where`."
    ),
    sorts: z
      .array(
        z.union([
          z
            .string()
            .describe(
              "Property name, ascending; prefix with '-' for descending. 'created_time' / 'last_edited_time' sort by timestamp."
            ),
          z.object({ property: z.string(), direction: z.enum(["ascending", "descending"]) }),
          z.object({
            timestamp: z.enum(["created_time", "last_edited_time"]),
            direction: z.enum(["ascending", "descending"]),
          }),
        ])
      )
      .optional()
      .describe("Sort order, e.g. ['-Due Date', 'Priority'] or [{ property: 'Due Date', direction: 'descending' }]."),
    start_cursor: z.string().optional(),
    page_size: z.number().min(1).max(MAX_PAGE_SIZE).optional(),
    paginate: z.boolean().optional().describe(
      "Walk all result pages, up to `page_limit` items. Returns {results, truncated, pages_walked} envelope instead of {has_more, next_cursor}."
    ),
    page_limit: z
      .number()
      .min(1)
      .max(MAX_ITEM_LIMIT)
      .optional()
      .describe(`Maximum items (rows) to return when \`paginate:true\`. Defaults to ${DEFAULT_ITEM_LIMIT}.`),
    verbose: VERBOSE,
  })
  .refine((v) => Boolean(v.database_id) !== Boolean(v.data_source_id), {
    message: "Pass exactly one of `database_id` or `data_source_id`.",
  })
  .refine((v) => !(v.where !== undefined && v.filter !== undefined), {
    message: "Pass either `where` (typed DSL) or `filter` (raw Notion JSON), not both.",
  });

register({
  name: "query_database",
  access: "read",
  domain: "databases",
  description:
    "Query a database's rows with an optional `where` filter ({ Status: 'Done', Score: { gte: 3 } }) and sorts (['-Due Date']). Results are slim page objects with their properties.",
  batchable: false,
  schema: QueryDatabaseParams,
  example: {
    database_id: "<database-id>",
    where: { Status: "Done", Priority: { in: ["High", "Medium"] } },
    sorts: ["-Due Date"],
    page_size: 50,
  },
  handler: tryHandler(async ({
    database_id,
    data_source_id,
    where,
    filter,
    sorts,
    start_cursor,
    page_size,
    paginate,
    page_limit,
    verbose,
  }): Promise<OperationResult<unknown>> => {
    const notion = await getClient();
    let dsId = data_source_id;
    if (!dsId) {
      const db = await notion.databases.retrieve({ database_id: database_id! });
      const sources = isFullDatabase(db) ? db.data_sources : [];
      if (sources.length === 0) {
        return {
          ok: false,
          error: {
            code: "no_data_source",
            message: `Database ${database_id} has no data sources.`,
            fix: "Pass data_source_id directly, or check the database in Notion.",
          },
        };
      }
      if (sources.length > 1) {
        return {
          ok: false,
          error: {
            code: "multi_source_database",
            message: `Database ${database_id} has ${sources.length} data sources. Pass data_source_id explicitly.`,
            fix: `Call list_data_sources first, then pass data_source_id. Available IDs: ${sources.map((s) => s.id).join(", ")}.`,
          },
        };
      }
      dsId = sources[0].id;
    }

    let compiledFilter: unknown;
    if (where !== undefined) {
      // The data source's property types make the filter exact (status vs
      // select, title vs rich_text) and let an unknown name fail here with
      // the valid names instead of at Notion. Cached; a failed lookup just
      // falls back to inferring types from the values.
      let types: PropertyTypes | undefined;
      try {
        const schema = await getDataSourceSchema(dsId);
        if (Object.keys(schema).length > 0) types = schema;
      } catch {
        types = undefined;
      }
      try {
        compiledFilter = compileWhere(where, types);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "where_compile_error",
            message: err instanceof Error ? err.message : String(err),
            fix: "Check the `where` clause: property names as in get_data_source, a plain value or an operator object per property. Pass `__type` to force a property type, or fall back to raw `filter`.",
          },
        };
      }
    } else if (filter !== undefined) {
      compiledFilter = filter;
    }

    const baseBody = {
      data_source_id: dsId,
      ...(compiledFilter !== undefined ? { filter: compiledFilter } : {}),
      ...(sorts !== undefined ? { sorts: sorts.map(compileSort) } : {}),
    };
    const pageSize = page_size ?? DEFAULT_PAGE_SIZE;
    const runQuery = (cursor: string | undefined, size: number) =>
      notion.dataSources.query(
        asSdk<QueryDataSourceBody>({
          ...baseBody,
          ...(cursor !== undefined ? { start_cursor: cursor } : {}),
          page_size: size,
        })
      );

    // query_database results are data source rows (pages). The SDK response
    // type also admits data source objects themselves, so dispatch via slimItem
    // — only the page branch consumes includeProperties=true, which is the
    // common case and keeps callers off verbose=true (10x larger).
    const slimRow = (item: SearchItemResponse, v?: boolean) => slimItem(item, v ?? false, true);

    if (paginate) {
      const limit = page_limit ?? DEFAULT_ITEM_LIMIT;
      const collected: unknown[] = [];
      let cursor: string | undefined = start_cursor;
      let pagesWalked = 0;
      let hasMore = false;
      while (collected.length < limit) {
        const remaining = limit - collected.length;
        const response = await runQuery(cursor, Math.min(pageSize, remaining));
        pagesWalked += 1;
        const slim = slimList(response, slimRow, verbose ?? false);
        for (const item of slim.results) {
          if (collected.length >= limit) break;
          collected.push(item);
        }
        hasMore = Boolean(slim.has_more && slim.next_cursor);
        if (!hasMore || collected.length >= limit) break;
        cursor = slim.next_cursor ?? undefined;
      }
      if (verbose) {
        return {
          ok: true,
          data: {
            results: collected,
            truncated: hasMore && collected.length >= limit,
            pages_walked: pagesWalked,
          },
        };
      }
      const { parent, rows } = hoistParent(collected as RowWithParent[]);
      return {
        ok: true,
        data: {
          ...(parent !== undefined ? { parent } : {}),
          results: rows,
          truncated: hasMore && collected.length >= limit,
          pages_walked: pagesWalked,
        },
      };
    }

    const response = await runQuery(start_cursor, pageSize);
    const slim = slimList(response, slimRow, verbose ?? false);
    if (verbose) return { ok: true, data: slim };
    const { parent, rows } = hoistParent(slim.results as RowWithParent[]);
    return {
      ok: true,
      data: {
        ...(parent !== undefined ? { parent } : {}),
        results: rows,
        has_more: slim.has_more,
        next_cursor: slim.next_cursor,
      },
    };
  }),
});

type RowWithParent = { parent?: unknown } & Record<string, unknown>;

// query_database rows always come from one data source, so the `parent`
// object is identical across every result. Lift it to the list level — on
// a 100-row page that saves ~80 bytes per row, ≈8KB per response.
function hoistParent(rows: readonly RowWithParent[]): {
  parent?: unknown;
  rows: Array<Omit<RowWithParent, "parent">>;
} {
  if (rows.length === 0) return { rows: [] };
  const first = rows[0];
  if (first.parent === undefined) return { rows: rows.slice() };
  const parent = first.parent;
  return {
    parent,
    rows: rows.map(({ parent: _omit, ...rest }) => rest),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// update_database / delete_database
// ──────────────────────────────────────────────────────────────────────────

const UpdateDatabaseParams = z.object({
  database_id: notionId(),
  title: z.string().optional(),
  title_rich: z.array(TEXT_RICH_TEXT_ITEM_REQUEST_SCHEMA).optional(),
  description: z.array(TEXT_RICH_TEXT_ITEM_REQUEST_SCHEMA).optional(),
  // Nullable so a `{ Name: null }` delete attempt reaches the properties_moved
  // redirect below instead of dying in validation with no pointer.
  properties: z
    .record(z.string(), DATABASE_PROPERTY_SCHEMA.nullable())
    .optional()
    .describe("Deprecated on the 2025-09-03 surface — properties live on the data source. Call update_data_source instead (there, null deletes a property). Rejected here so the migration is explicit."),
  is_inline: z.boolean().optional(),
  is_locked: z.boolean().optional(),
  in_trash: z
    .boolean()
    .optional()
    .describe("Not accepted here — trashing is destructive and lives on delete_database (in_trash:false restores). Rejected here so the split is explicit."),
  archived: z
    .boolean()
    .optional()
    .describe("Deprecated alias for `in_trash`; not accepted here either. Call delete_database instead."),
  icon: ICON_SCHEMA.nullable().optional(),
  cover: FILE_SCHEMA.nullable().optional(),
  verbose: VERBOSE,
});

const DeleteDatabaseParams = z.object({
  database_id: notionId(),
  in_trash: z
    .boolean()
    .optional()
    .describe("Default true. Pass false to restore a database from trash."),
  archived: z.boolean().optional().describe("Deprecated alias for `in_trash`. Use `in_trash` on the 2025-09-03 surface."),
  verbose: VERBOSE,
});

register({
  name: "update_database",
  access: "write",
  domain: "databases",
  description: "Update database-level metadata (title, description, icon, cover, is_inline, is_locked). To trash or restore a database use delete_database.",
  batchable: true,
  schema: UpdateDatabaseParams,
  example: {
    database_id: "<database-id>",
    title: "Renamed",
  },
  handler: tryHandler(async (params) => {
    if (params.properties) {
      return {
        ok: false,
        error: {
          code: "properties_moved",
          message: "Property definitions are no longer accepted on update_database in the 2025-09-03 surface.",
          fix: "Call list_data_sources to resolve the data_source_id, then update_data_source with the same properties map.",
        },
      };
    }
    // Kept in the schema (rather than dropped) so a stale caller gets an error
    // pointing at delete_database instead of a silent no-op: z.object strips
    // unknown keys, so an absent field would make `{ in_trash: true }` succeed
    // with the database untouched.
    if (params.in_trash !== undefined || params.archived !== undefined) {
      return {
        ok: false,
        error: {
          code: "trash_moved",
          message: "in_trash / archived are no longer accepted on update_database — trashing is a destructive operation and lives on delete_database.",
          fix: "Call delete_database with the same database_id. It trashes by default; pass in_trash:false to restore.",
        },
      };
    }
    const titleRich = params.title_rich
      ? params.title_rich
      : params.title !== undefined
        ? [{ type: "text" as const, text: { content: params.title } }]
        : undefined;
    const notion = await getClient();
    const body = {
      database_id: params.database_id,
      ...(titleRich ? { title: titleRich } : {}),
      ...(params.description ? { description: params.description } : {}),
      ...(params.is_inline !== undefined ? { is_inline: params.is_inline } : {}),
      ...(params.is_locked !== undefined ? { is_locked: params.is_locked } : {}),
      ...(params.icon !== undefined ? { icon: params.icon } : {}),
      ...(params.cover !== undefined ? { cover: params.cover } : {}),
    };
    const response = await notion.databases.update(asSdk<UpdateDatabaseBody>(body));
    return { ok: true, data: slimDatabase(response, params.verbose ?? false) };
  }),
});

register({
  name: "delete_database",
  access: "write",
  domain: "databases",
  destructive: true,
  description: "Move a database to trash, with every page in it. Reversible: pass in_trash:false to restore.",
  batchable: true,
  schema: DeleteDatabaseParams,
  example: { database_id: "<database-id>" },
  exampleBatch: {
    items: [{ database_id: "<database-id-1>" }, { database_id: "<database-id-2>" }],
  },
  handler: tryHandler(async (params) => {
    const notion = await getClient();
    const response = await notion.databases.update(
      asSdk<UpdateDatabaseBody>({
        database_id: params.database_id,
        in_trash: params.in_trash ?? params.archived ?? true,
      })
    );
    return { ok: true, data: slimDatabase(response, params.verbose ?? false) };
  }),
});
