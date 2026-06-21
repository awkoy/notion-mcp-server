import { z } from "zod";
import { isFullDatabase } from "@notionhq/client";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import type { OperationResult } from "./types.js";
import { tryHandler } from "../utils/handler.js";
import { slimView, slimPage } from "../utils/slim.js";
import { mapWithConcurrency } from "../dispatch/concurrency.js";
import { WHERE_SCHEMA, compileWhere } from "../schema/filter-dsl.js";
import {
  asSdk,
  type CreateViewBody,
  type UpdateViewBody,
  type CreateViewQueryBody,
  type GetViewQueryResultsBody,
  type DeleteViewQueryBody,
} from "../utils/notion-types.js";

const VERBOSE = z.boolean().optional();
// Hydration fans out one pages.retrieve / views.retrieve per id. The dispatch
// rate limiter only gates the operation as a whole, not these inner calls, so
// keep the fan-out gentle (matches the dispatch batch default) to avoid bursting
// past Notion's rate limit — a 429 here would surface as a hydration miss.
const HYDRATE_CONCURRENCY = 3;

const VIEW_TYPES = [
  "table",
  "board",
  "list",
  "calendar",
  "timeline",
  "gallery",
  "form",
  "chart",
  "map",
  "dashboard",
] as const;

// View types whose SDK config carries a required field — we require an explicit
// `configuration` so the call fails locally with a fix instead of a raw API 400.
const REQUIRES_CONFIG: Record<string, string> = {
  calendar: "date_property_id (calendar views group rows by a date property)",
  timeline: "a timeline date/range configuration",
  board: "group_by (board views group by a property)",
  chart: "chart axes/aggregation configuration",
  map: "a location property configuration",
};

type ClientInstance = Awaited<ReturnType<typeof getClient>>;
type OpError = { code: string; message: string; fix: string };

// Resolve the (data_source_id, database_id) pair a view is created under.
// Notion's createView requires BOTH in the body — the data source it targets
// and the database it lives in — even though the SDK types database_id as
// optional. We accept either input and look up the other.
async function resolveViewTarget(
  notion: ClientInstance,
  database_id?: string,
  data_source_id?: string
): Promise<{ data_source_id?: string; database_id?: string; error?: OpError }> {
  if (!database_id && !data_source_id) {
    return {
      error: {
        code: "missing_target",
        message: "Pass data_source_id or database_id.",
        fix: "Provide data_source_id (preferred) or database_id.",
      },
    };
  }
  // data_source given without its database → look up the parent database.
  if (data_source_id && !database_id) {
    const ds = await notion.dataSources.retrieve({ data_source_id });
    const parent = (ds as { parent?: { type?: string; database_id?: string } }).parent;
    const dbId = parent?.type === "database_id" ? parent.database_id : undefined;
    if (!dbId) {
      return {
        error: {
          code: "no_parent_database",
          message: `Could not resolve the parent database of data source ${data_source_id}.`,
          fix: "Pass database_id explicitly alongside data_source_id.",
        },
      };
    }
    return { data_source_id, database_id: dbId };
  }
  // Both given → use as-is.
  if (data_source_id && database_id) {
    return { data_source_id, database_id };
  }
  // database given without a data source → resolve its single data source.
  const db = await notion.databases.retrieve({ database_id: database_id! });
  const sources = isFullDatabase(db) ? db.data_sources : [];
  if (sources.length === 0) {
    return {
      error: {
        code: "no_data_source",
        message: `Database ${database_id} has no data sources.`,
        fix: "Pass data_source_id directly, or check the database in Notion.",
      },
    };
  }
  if (sources.length > 1) {
    return {
      error: {
        code: "multi_source_database",
        message: `Database ${database_id} has ${sources.length} data sources.`,
        fix: `Pass data_source_id. Available: ${sources.map((s) => s.id).join(", ")}.`,
      },
    };
  }
  return { data_source_id: sources[0].id, database_id };
}

// Compile the typed `where` DSL into a Notion filter, or pass `filter` through.
function compileViewFilter(
  where: unknown,
  filter: unknown
): { ok: true; filter?: unknown } | { ok: false; error: OpError } {
  if (where !== undefined && filter !== undefined) {
    return {
      ok: false,
      error: {
        code: "filter_conflict",
        message: "Pass `where` (typed DSL) or `filter` (raw JSON), not both.",
        fix: "Use exactly one of `where` or `filter`.",
      },
    };
  }
  if (where !== undefined) {
    try {
      return { ok: true, filter: compileWhere(where as never) };
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "where_compile_error",
          message: err instanceof Error ? err.message : String(err),
          fix: "Check the `where` clause shape, or fall back to raw `filter`.",
        },
      };
    }
  }
  if (filter !== undefined) return { ok: true, filter };
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────
// get_view
// ──────────────────────────────────────────────────────────────────────────

const GetViewParams = z.object({
  view_id: z.string().describe("View ID to retrieve."),
  verbose: VERBOSE,
});

register({
  name: "get_view",
  access: "read",
  domain: "views",
  description:
    "Retrieve a single database view's configuration (name, type, filter, sorts, layout).",
  batchable: true,
  schema: GetViewParams,
  example: { view_id: "<view-id>" },
  handler: tryHandler(async ({ view_id, verbose }) => {
    const notion = await getClient();
    const view = await notion.views.retrieve({ view_id });
    return { ok: true, data: slimView(view, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// list_views
// ──────────────────────────────────────────────────────────────────────────

const ListViewsParams = z
  .object({
    database_id: z.string().optional().describe("List views under this database."),
    data_source_id: z.string().optional().describe("List views under this data source."),
    start_cursor: z.string().optional(),
    page_size: z.number().min(1).max(100).optional(),
    hydrate: z
      .boolean()
      .optional()
      .describe("Fetch each view's name/type (default true). Set false for a cheap id-only list."),
    verbose: VERBOSE,
  })
  .refine((v) => Boolean(v.database_id) || Boolean(v.data_source_id), {
    message: "Pass database_id or data_source_id.",
  });

register({
  name: "list_views",
  access: "read",
  domain: "views",
  description:
    "List views under a database or data source. Hydrates id-only refs to {id,name,type} by default.",
  batchable: false,
  schema: ListViewsParams,
  example: { database_id: "<database-id>" },
  handler: tryHandler(async ({ database_id, data_source_id, start_cursor, page_size, hydrate, verbose }) => {
    const notion = await getClient();
    const list = await notion.views.list({
      ...(database_id ? { database_id } : {}),
      ...(data_source_id ? { data_source_id } : {}),
      ...(start_cursor ? { start_cursor } : {}),
      ...(page_size ? { page_size } : {}),
    });
    const refs = (list.results ?? []) as Array<{ id: string }>;
    const envelope = {
      has_more: list.has_more ?? false,
      next_cursor: list.next_cursor ?? null,
    };
    if (hydrate === false) {
      return { ok: true, data: { results: refs.map((r) => ({ id: r.id })), ...envelope } };
    }
    const results = await mapWithConcurrency(refs, HYDRATE_CONCURRENCY, async (ref) => {
      const view = await notion.views.retrieve({ view_id: ref.id });
      return slimView(view, verbose ?? false);
    });
    return { ok: true, data: { results, ...envelope } };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// query_view
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_ITEM_LIMIT = 1000;
const MAX_ITEM_LIMIT = 1000;

const QueryViewParams = z.object({
  view_id: z.string().describe("View ID. Executes the view's stored filters/sorts server-side."),
  page_size: z.number().min(1).max(MAX_PAGE_SIZE).optional(),
  paginate: z.boolean().optional().describe("Walk all result pages, up to page_limit rows."),
  page_limit: z
    .number()
    .min(1)
    .max(MAX_ITEM_LIMIT)
    .optional()
    .describe(`Max rows when paginate:true (default ${DEFAULT_ITEM_LIMIT}).`),
  hydrate: z
    .boolean()
    .optional()
    .describe("Fetch full row data for each result (default true). Set false to return ordered ids only."),
  verbose: VERBOSE,
});

// Loose narrow over the view-query response (create + results share this shape).
type ViewQueryPage = {
  id: string;
  total_count?: number;
  results: Array<{ id: string }>;
  has_more?: boolean;
  next_cursor?: string | null;
  request_status?: { type: "complete" | "incomplete"; incomplete_reason?: string };
};

register({
  name: "query_view",
  access: "read",
  domain: "views",
  description:
    "Query a view: runs its stored filters/sorts and returns the matching rows. Hydrates row data by default.",
  batchable: false,
  schema: QueryViewParams,
  example: { view_id: "<view-id>", page_size: 50 },
  handler: tryHandler(async ({
    view_id,
    page_size,
    paginate,
    page_limit,
    hydrate,
    verbose,
  }): Promise<OperationResult<unknown>> => {
    const notion = await getClient();
    const pageSize = page_size ?? DEFAULT_PAGE_SIZE;
    const doHydrate = hydrate !== false;

    const hydrateIds = async (refs: Array<{ id: string }>) => {
      if (!doHydrate) return refs.map((r) => ({ id: r.id }));
      return mapWithConcurrency(refs, HYDRATE_CONCURRENCY, async (ref) => {
        try {
          const page = await notion.pages.retrieve({ page_id: ref.id });
          return slimPage(page, verbose ?? false, true);
        } catch {
          // A row deleted between query and hydrate — surface the id, keep going.
          return { id: ref.id, _hydration_failed: true };
        }
      });
    };

    const first = (await notion.views.queries.create(
      asSdk<CreateViewQueryBody>({ view_id, page_size: pageSize })
    )) as unknown as ViewQueryPage;
    const queryId = first.id;
    const totalCount = first.total_count;

    if (!paginate) {
      const rows = await hydrateIds(first.results ?? []);
      const truncated = first.request_status?.type === "incomplete";
      return {
        ok: true,
        data: {
          ...(totalCount !== undefined ? { total_count: totalCount } : {}),
          results: rows,
          has_more: first.has_more ?? false,
          next_cursor: first.next_cursor ?? null,
          ...(truncated ? { truncated: true } : {}),
        },
      };
    }

    // paginate: accumulate refs across pages up to page_limit, then hydrate once.
    const limit = page_limit ?? DEFAULT_ITEM_LIMIT;
    const refs: Array<{ id: string }> = [];
    let page: ViewQueryPage = first;
    let pagesWalked = 1;
    let incomplete = first.request_status?.type === "incomplete";
    for (const r of page.results ?? []) {
      if (refs.length >= limit) break;
      refs.push({ id: r.id });
    }
    while (refs.length < limit && page.has_more && page.next_cursor) {
      page = (await notion.views.queries.results(
        asSdk<GetViewQueryResultsBody>({
          view_id,
          query_id: queryId,
          start_cursor: page.next_cursor,
          page_size: pageSize,
        })
      )) as unknown as ViewQueryPage;
      pagesWalked += 1;
      if (page.request_status?.type === "incomplete") incomplete = true;
      for (const r of page.results ?? []) {
        if (refs.length >= limit) break;
        refs.push({ id: r.id });
      }
    }
    // Best-effort cleanup of the server-side query job.
    try {
      await notion.views.queries.delete(
        asSdk<DeleteViewQueryBody>({ view_id, query_id: queryId })
      );
    } catch {
      /* ignore cleanup failures */
    }

    const rows = await hydrateIds(refs);
    const truncated = incomplete || (Boolean(page.has_more) && refs.length >= limit);
    return {
      ok: true,
      data: {
        ...(totalCount !== undefined ? { total_count: totalCount } : {}),
        results: rows,
        truncated,
        pages_walked: pagesWalked,
      },
    };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// create_view
// ──────────────────────────────────────────────────────────────────────────

const CreateViewParams = z.object({
  data_source_id: z.string().optional(),
  database_id: z
    .string()
    .optional()
    .describe("Single-source databases are auto-resolved; multi-source require data_source_id."),
  name: z.string().describe("View name."),
  type: z.enum(VIEW_TYPES).describe("View type."),
  where: WHERE_SCHEMA.optional().describe(
    "Typed filter DSL (same shape as query_database `where`). Mutually exclusive with `filter`."
  ),
  filter: z.unknown().optional().describe("Raw Notion view filter JSON. Mutually exclusive with `where`."),
  sorts: z.array(z.unknown()).optional(),
  configuration: z
    .unknown()
    .optional()
    .describe("Type-specific layout/grouping config (required for calendar/board/timeline/chart/map)."),
  verbose: VERBOSE,
});

register({
  name: "create_view",
  access: "write",
  domain: "views",
  description:
    "Create a database view. table/list/gallery/form need only name+type; calendar/board/timeline/chart/map require `configuration`.",
  batchable: true,
  schema: CreateViewParams,
  example: {
    data_source_id: "<data-source-id>",
    name: "Open Tasks",
    type: "table",
    where: { Status: "Open" },
  },
  rollback: async (data) => {
    const id = (data as { id?: string } | null)?.id;
    if (!id) return;
    const notion = await getClient();
    try {
      await notion.views.delete({ view_id: id });
    } catch {
      /* ignore */
    }
  },
  handler: tryHandler(async ({ data_source_id, database_id, name, type, where, filter, sorts, configuration, verbose }) => {
    if (REQUIRES_CONFIG[type] && configuration === undefined) {
      return {
        ok: false,
        error: {
          code: "missing_view_config",
          message: `A ${type} view requires \`configuration\`.`,
          fix: `Pass \`configuration\` with ${REQUIRES_CONFIG[type]}.`,
        },
      };
    }
    // Validate inputs (filter shape) before any network call, so bad input
    // surfaces without a round-trip and regardless of target resolution.
    const compiled = compileViewFilter(where, filter);
    if (!compiled.ok) return { ok: false, error: compiled.error };
    const notion = await getClient();
    const resolved = await resolveViewTarget(notion, database_id, data_source_id);
    if (resolved.error) return { ok: false, error: resolved.error };
    const body = {
      data_source_id: resolved.data_source_id,
      // createView requires database_id in the body (SDK types it optional, but
      // the API rejects a body without it — confirmed against the live API).
      database_id: resolved.database_id,
      name,
      type,
      ...(compiled.filter !== undefined ? { filter: compiled.filter } : {}),
      ...(sorts !== undefined ? { sorts } : {}),
      ...(configuration !== undefined ? { configuration } : {}),
    };
    const view = await notion.views.create(asSdk<CreateViewBody>(body));
    return { ok: true, data: slimView(view, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// update_view
// ──────────────────────────────────────────────────────────────────────────

const UpdateViewParams = z.object({
  view_id: z.string(),
  name: z.string().optional(),
  where: WHERE_SCHEMA.optional().describe(
    "Replace the view filter (typed DSL). Mutually exclusive with `filter`."
  ),
  filter: z.unknown().optional().describe("Replace the view filter (raw JSON). Mutually exclusive with `where`."),
  sorts: z.array(z.unknown()).optional(),
  configuration: z.unknown().optional(),
  clear: z
    .array(z.enum(["filter", "sorts", "configuration"]))
    .optional()
    .describe("Fields to clear (set to null)."),
  verbose: VERBOSE,
});

register({
  name: "update_view",
  access: "write",
  domain: "views",
  description:
    "Update a view's name/filter/sorts/configuration. Use `clear` to remove filter/sorts/configuration.",
  batchable: true,
  schema: UpdateViewParams,
  example: { view_id: "<view-id>", name: "Renamed" },
  handler: tryHandler(async ({ view_id, name, where, filter, sorts, configuration, clear, verbose }) => {
    const compiled = compileViewFilter(where, filter);
    if (!compiled.ok) return { ok: false, error: compiled.error };
    const toClear = new Set(clear ?? []);
    const body: Record<string, unknown> = { view_id };
    if (name !== undefined) body.name = name;
    if (compiled.filter !== undefined) body.filter = compiled.filter;
    if (sorts !== undefined) body.sorts = sorts;
    if (configuration !== undefined) body.configuration = configuration;
    if (toClear.has("filter")) body.filter = null;
    if (toClear.has("sorts")) body.sorts = null;
    if (toClear.has("configuration")) body.configuration = null;
    const notion = await getClient();
    const view = await notion.views.update(asSdk<UpdateViewBody>(body));
    return { ok: true, data: slimView(view, verbose ?? false) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// delete_view
// ──────────────────────────────────────────────────────────────────────────

const DeleteViewParams = z.object({ view_id: z.string() });

register({
  name: "delete_view",
  access: "write",
  domain: "views",
  destructive: true,
  description:
    "Delete a database view. Irreversible. Honors NOTION_READ_ONLY and the operation allow/block lists.",
  batchable: true,
  schema: DeleteViewParams,
  example: { view_id: "<view-id>" },
  handler: tryHandler(async ({ view_id }) => {
    const notion = await getClient();
    const result = await notion.views.delete({ view_id });
    const r = result as { id?: string; deleted?: boolean };
    return { ok: true, data: { id: r.id ?? view_id, deleted: r.deleted ?? true } };
  }),
});
