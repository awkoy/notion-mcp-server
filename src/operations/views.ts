import { z } from "zod";
import { isFullDatabase } from "../utils/notion-sdk-runtime.js";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import type { OperationResult } from "./types.js";
import { tryHandler } from "../utils/handler.js";
import { slimView, slimPage, truncatedRowWarnings } from "../utils/slim.js";
import { mapWithConcurrency } from "../dispatch/concurrency.js";
import { stableStringify } from "../utils/stable-json.js";
import { WHERE_SCHEMA, compileWhere, type PropertyTypes } from "../schema/filter-dsl.js";
import {
  asSdk,
  type CreateViewBody,
  type UpdateViewBody,
  type CreateViewQueryBody,
  type GetViewQueryResultsBody,
  type DeleteViewQueryBody,
} from "../utils/notion-types.js";
import { notionId } from "../schema/id.js";

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

const DASHBOARD_PLACEMENT = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("new_row"),
    row_index: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    type: z.literal("existing_row"),
    row_index: z.number().int().min(0),
  }).strict(),
]);

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

// Validate mutually exclusive filter inputs before making any API requests.
function viewFilterConflict(where: unknown, filter: unknown): OpError | undefined {
  if (where === undefined || filter === undefined) return undefined;
  return {
    code: "filter_conflict",
    message: "Pass `where` (typed DSL) or `filter` (raw JSON), not both.",
    fix: "Use exactly one of `where` or `filter`.",
  };
}

// Use the data source's property types when compiling `where`, rather than
// misinferring (for example) a status property's string as a select.
function compileViewFilter(
  where: unknown,
  filter: unknown,
  propertyTypes?: PropertyTypes
): { ok: true; filter?: unknown } | { ok: false; error: OpError } {
  const conflict = viewFilterConflict(where, filter);
  if (conflict) return { ok: false, error: conflict };
  if (where !== undefined) {
    try {
      return { ok: true, filter: compileWhere(where as never, propertyTypes) };
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

// Reject missing/unusable schemas rather than silently falling back to value
// inference, which is precisely what caused the status/select false conflict.
type ViewFilterProperties = Record<string, { id?: string; type: string }>;
async function resolveViewFilterProperties(
  notion: ClientInstance,
  dataSourceId: string
): Promise<{ ok: true; properties: ViewFilterProperties } | { ok: false; error: OpError }> {
  try {
    const source = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
    const properties = (source as { properties?: unknown }).properties;
    if (
      !properties || typeof properties !== "object" || Array.isArray(properties) ||
      Object.keys(properties).length === 0 ||
      Object.values(properties).some(
        (item) => !item || typeof item !== "object" || Array.isArray(item) ||
          typeof (item as { type?: unknown }).type !== "string" ||
          (item as { type: string }).type.trim().length === 0
      )
    ) {
      return { ok: false, error: {
        code: "view_filter_schema_unavailable",
        message: "The data source did not return usable property types.",
        fix: "Verify the target data_source_id and its schema before retrying.",
      } };
    }
    return { ok: true, properties: properties as ViewFilterProperties };
  } catch {
    return { ok: false, error: {
      code: "view_filter_schema_unavailable",
      message: "The data source's property types could not be retrieved.",
      fix: "Verify data source access and retry only after checking its schema.",
    } };
  }
}

// Notion often returns property IDs, not property names, in saved view filters.
// Data source property IDs may themselves be percent-encoded in API responses.
// Canonicalize both filters against the same source schema before declaring an
// exact match, otherwise a safe rerun can spuriously conflict with its own view.
function canonicalViewFilter(
  filter: unknown,
  properties: Record<string, { id?: string }> = {}
): string {
  const decodeId = (value: string): string => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const aliases = new Map<string, string>();
  for (const [name, config] of Object.entries(properties)) {
    const id = decodeId(config.id ?? name);
    aliases.set(name, id);
    if (config.id) aliases.set(config.id, id);
    aliases.set(id, id);
  }
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        key === "property" && typeof item === "string"
          ? (aliases.get(item) ?? item)
          : normalize(item),
      ])
    );
  };
  return stableStringify(normalize(filter ?? null));
}

// ──────────────────────────────────────────────────────────────────────────
// get_view
// ──────────────────────────────────────────────────────────────────────────

const GetViewParams = z.object({
  view_id: notionId("view").describe("View ID to retrieve."),
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
    database_id: notionId().optional().describe("List views under this database."),
    data_source_id: notionId().optional().describe("List views under this data source."),
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
  view_id: notionId("view").describe("View ID. Executes the view's stored filters/sorts server-side."),
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
        ...truncatedRowWarnings(rows),
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
      ...truncatedRowWarnings(rows),
    };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// create_view
// ──────────────────────────────────────────────────────────────────────────

// Serialize check-then-create Dashboard mutations inside this server process.
// No local mutex can coordinate separate MCP servers or external Notion writers.
const dashboardWrites = new Map<string, Promise<void>>();
// A completed create whose membership readback lagged must not be retried as
// a fresh create in this process. Keep the ID until a later read confirms it.
const pendingDashboardWidgetIds = new Map<string, string>();

function serializeDashboardWrite<T>(viewId: string, run: () => Promise<T>): Promise<T> {
  const previous = dashboardWrites.get(viewId) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(() => {}, () => {});
  dashboardWrites.set(viewId, settled);
  void settled.then(() => {
    if (dashboardWrites.get(viewId) === settled) dashboardWrites.delete(viewId);
  });
  return current;
}

// Notion exposes dashboard rows as read-only layout metadata. Never guess
// row placement or create a duplicate after layout cannot be inspected.
function checkDashboardCapacity(
  dashboard: unknown,
  placement?: z.infer<typeof DASHBOARD_PLACEMENT>
): OpError | undefined {
  const view = dashboard as {
    type?: string;
    configuration?: { type?: string; rows?: Array<{ widgets?: unknown[] }> };
  };
  if (view.type !== "dashboard") return {
    code: "not_dashboard", message: "view_id does not identify a Dashboard view.",
    fix: "Pass the id of a view with type dashboard, not a page or table view.",
  };
  const rows = view.configuration?.rows;
  if (!Array.isArray(rows)) return {
    code: "dashboard_layout_unavailable",
    message: "Dashboard row layout could not be verified.",
    fix: "Retrieve the Dashboard with get_view(verbose:true) and check its configuration.rows.",
  };
  const total = rows.reduce((count, row) => count + (row.widgets?.length ?? 0), 0);
  if (total >= 12) return {
    code: "dashboard_full", message: "Dashboard already has 12 widgets.",
    fix: "Remove or reorganize widgets in Notion before adding another.",
  };
  if (placement?.type === "existing_row") {
    const row = rows[placement.row_index];
    if (!row) return {
      code: "invalid_dashboard_row", message: "Requested Dashboard row does not exist.",
      fix: `Choose an existing row index 0..${Math.max(0, rows.length - 1)} or new_row.`,
    };
    if ((row.widgets?.length ?? 0) >= 4) return {
      code: "dashboard_row_full", message: "Dashboard row already has 4 widgets.",
      fix: "Use placement.type=new_row, or another row with space.",
    };
  }
  if (placement?.type === "new_row" && placement.row_index !== undefined &&
    placement.row_index > rows.length) return {
    code: "invalid_dashboard_row", message: "New row index is beyond the Dashboard.",
    fix: `Choose an insertion index from 0..${rows.length}.`,
  };
  return undefined;
}

const CreateViewParams = z.object({
  data_source_id: notionId().optional(),
  database_id: notionId()
    .optional()
    .describe("Single-source databases are auto-resolved; multi-source require data_source_id."),
  view_id: notionId("view").optional().describe(
    "Target Dashboard view for a widget. Requires data_source_id; cannot combine with database_id."
  ),
  placement: DASHBOARD_PLACEMENT.optional().describe(
    "Dashboard widget location: new_row (optional row_index) or existing_row (required row_index)."
  ),
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
    "Create a database view, or add a filtered widget to an existing Dashboard with view_id, data_source_id and optional placement. Honors 4-per-row/12-total limits.",
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
  handler: tryHandler(async ({
    data_source_id, database_id, view_id, placement,
    name, type, where, filter, sorts, configuration, verbose,
  }) => {
    const run = async (): Promise<OperationResult<unknown>> => {
    if (REQUIRES_CONFIG[type] && configuration === undefined) {
      return { ok: false, error: {
        code: "missing_view_config",
        message: `A ${type} view requires \`configuration\`.`,
        fix: `Pass \`configuration\` with ${REQUIRES_CONFIG[type]}.`,
      } };
    }
    if (view_id && (database_id || !data_source_id || type === "dashboard")) {
      return { ok: false, error: {
        code: "invalid_dashboard_target",
        message: "A Dashboard widget needs view_id and data_source_id, no database_id, and cannot itself be a dashboard.",
        fix: "Use {view_id, data_source_id, name, type:'table'|'list'|...} without database_id.",
      } };
    }
    if (placement && !view_id) return { ok: false, error: {
      code: "placement_without_dashboard", message: "placement requires view_id.",
      fix: "Supply the Dashboard view_id or remove placement.",
    } };
    const conflict = viewFilterConflict(where, filter);
    if (conflict) return { ok: false, error: conflict };
    const notion = await getClient();
    if (view_id) {
      const dashboard = await notion.views.retrieve({ view_id });
      const error = checkDashboardCapacity(dashboard, placement);
      if (error) return { ok: false, error };
    }
    const resolved = view_id
      ? { data_source_id }
      : await resolveViewTarget(notion, database_id, data_source_id);
    if (resolved.error) return { ok: false, error: resolved.error };
    if (!resolved.data_source_id) return { ok: false, error: {
      code: "missing_target", message: "The view's data source could not be resolved.",
      fix: "Supply a valid data_source_id.",
    } };
    // Ordinary views and Dashboard widgets use the declared property type.
    const propertyResult = where !== undefined
      ? await resolveViewFilterProperties(notion, resolved.data_source_id)
      : { ok: true as const, properties: {} as ViewFilterProperties };
    if (!propertyResult.ok) return { ok: false, error: propertyResult.error };
    const compiled = compileViewFilter(where, filter, propertyResult.properties);
    if (!compiled.ok) return { ok: false, error: compiled.error };
    const body = {
      data_source_id: resolved.data_source_id,
      // Dashboard widgets are scoped to view_id; ordinary views keep their database_id.
      ...(view_id ? { view_id } : { database_id: resolved.database_id }),
      ...(view_id && placement ? { placement } : {}),
      name,
      type,
      ...(compiled.filter !== undefined ? { filter: compiled.filter } : {}),
      ...(sorts !== undefined ? { sorts } : {}),
      ...(configuration !== undefined ? { configuration } : {}),
    };
    const view = await notion.views.create(asSdk<CreateViewBody>(body));
    return { ok: true, data: slimView(view, verbose ?? false) };
    };
    return view_id ? serializeDashboardWrite(view_id, run) : run();
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// ensure_dashboard_widget
// ──────────────────────────────────────────────────────────────────────────

// A single-widget reconciler. Compare actual dashboard membership, source,
// type and filter before creating. Same-name mismatches are an explicit HOLD.
const EnsureDashboardWidgetParams = CreateViewParams.pick({
  view_id: true, data_source_id: true, placement: true,
  name: true, type: true, where: true, filter: true,
  sorts: true, configuration: true, verbose: true,
}).extend({
  view_id: notionId("view"),
  data_source_id: notionId(),
  dry_run: z.boolean().optional().describe("Report create/existing without writing."),
});

register({
  name: "ensure_dashboard_widget",
  access: "write",
  domain: "views",
  description: "Idempotently reconcile one named Dashboard widget by membership, data source, type and filter. A mismatched same-name widget is a conflict, not a duplicate opportunity.",
  batchable: true,
  schema: EnsureDashboardWidgetParams,
  example: {
    view_id: "<dashboard-view-id>", data_source_id: "<data-source-id>",
    name: "Open Tasks", type: "table", where: { Status: "Open" },
    dry_run: true,
  },
  // No atomic rollback: ensure may reuse an existing widget. Deleting it on
  // failure of another batch item would be destructive.
  handler: tryHandler(async ({
    view_id, data_source_id, placement, name, type, where, filter,
    sorts, configuration, verbose, dry_run,
  }): Promise<OperationResult<unknown>> => {
    const run = async (): Promise<OperationResult<unknown>> => {
    if (type === "dashboard") return { ok: false, error: {
      code: "nested_dashboard_not_supported",
      message: "A Dashboard widget cannot itself be another Dashboard.",
      fix: "Choose a table, list, chart, board or another widget view type.",
    } };
    if (REQUIRES_CONFIG[type] && configuration === undefined) return { ok: false, error: {
      code: "missing_view_config", message: `A ${type} widget needs configuration.`,
      fix: `Pass configuration with ${REQUIRES_CONFIG[type]}.`,
    } };
    const conflict = viewFilterConflict(where, filter);
    if (conflict) return { ok: false, error: conflict };
    const notion = await getClient();
    const dashboard = await notion.views.retrieve({ view_id });
    const target = dashboard as {
      type?: string; configuration?: { rows?: Array<{widgets?: Array<{view_id?: string}>}> };
    };
    if (target.type !== "dashboard" || !Array.isArray(target.configuration?.rows)) {
      return { ok: false, error: checkDashboardCapacity(dashboard) ?? {
        code: "dashboard_layout_unavailable", message: "Dashboard layout not available.",
        fix: "Inspect get_view(verbose:true).",
      } };
    }
    const ids = target.configuration.rows.flatMap((row) => row.widgets ?? [])
      .map((widget) => widget.view_id).filter((id): id is string => Boolean(id));
    const existingViews = await mapWithConcurrency(ids, HYDRATE_CONCURRENCY, async (id) =>
      notion.views.retrieve({ view_id: id })
    );
    const fullViews = existingViews as Array<{
      id: string; name?: string; type?: string; data_source_id?: string;
      filter?: unknown; dashboard_view_id?: string;
    }>;
    const sameName = fullViews.filter((item) => item.name === name);
    const conflictError: OpError = {
      code: "dashboard_widget_conflict",
      message: `Widget "${name}" exists with different source, type or filter (or is duplicated).`,
      fix: "Inspect the existing widget and reconcile the intended source/filter before creating.",
    };
    // Reject objective source/type conflicts and duplicates *before* asking
    // for a schema. Never interpret a foreign source's filter with ours.
    if (sameName.length > 1 ||
      (sameName.length === 1 && (
        sameName[0].type !== type || sameName[0].data_source_id !== data_source_id
      ))) return { ok: false, error: conflictError };

    const pendingKey = JSON.stringify([view_id, name]);
    const pendingId = pendingDashboardWidgetIds.get(pendingKey);
    const pendingError: OpError | undefined = pendingId ? {
      code: "dashboard_widget_verification_pending",
      message: `Widget "${name}" was created as ${pendingId}, but membership is not yet verifiable.`,
      fix: "Inspect the Dashboard and created widget before attempting another creation.",
    } : undefined;
    // If the last create has not appeared in Dashboard membership yet, do not
    // issue a schema request or another create; preserve the uncertainty HOLD.
    if (pendingError && sameName.length === 0) return { ok: false, error: pendingError };

    const needsPropertyMapping = sameName.length === 1 &&
      (filter != null || sameName[0].filter != null);
    const propertyResult = (where !== undefined || needsPropertyMapping)
      ? await resolveViewFilterProperties(notion, data_source_id)
      : { ok: true as const, properties: {} as ViewFilterProperties };
    if (!propertyResult.ok) return { ok: false, error: pendingError ?? propertyResult.error };
    const properties = propertyResult.properties;
    const compiled = compileViewFilter(where, filter, properties);
    if (!compiled.ok) return { ok: false, error: compiled.error };
    const expectedFilter = canonicalViewFilter(compiled.filter, properties);
    const matches = sameName.filter((item) =>
      item.type === type && item.data_source_id === data_source_id &&
      canonicalViewFilter(item.filter, properties) === expectedFilter
    );
    if (sameName.length === 1 && matches.length === 0)
      return { ok: false, error: conflictError };
    if (matches.length === 1) {
      pendingDashboardWidgetIds.delete(pendingKey);
      return {
        ok: true, data: { action: "existing", widget: slimView(matches[0], verbose ?? false), verified: true },
      };
    }
    const capacityError = checkDashboardCapacity(dashboard, placement);
    if (capacityError) return { ok: false, error: capacityError };
    if (dry_run) return { ok: true, data: {
      action: "would_create", dashboard_view_id: view_id,
      data_source_id, name, type, placement: placement ?? { type: "new_row" },
    } };
    const created = await notion.views.create(asSdk<CreateViewBody>({
      view_id, data_source_id, name, type,
      ...(placement ? { placement } : {}),
      ...(compiled.filter !== undefined ? { filter: compiled.filter } : {}),
      ...(sorts ? { sorts } : {}),
      ...(configuration !== undefined ? { configuration } : {}),
    }));
    // Read-after-write verification is best effort; a successful mutation
    // must NEVER be represented as a failed create merely because reads lag.
    let verified = false;
    try {
      const child = await notion.views.retrieve({ view_id: created.id });
      const parent = await notion.views.retrieve({ view_id });
      const p = parent as { configuration?: { rows?: Array<{ widgets?: Array<{view_id?: string}> }> } };
      verified = (child as {dashboard_view_id?: string}).dashboard_view_id === view_id &&
        Boolean(p.configuration?.rows?.some((r) => r.widgets?.some((w) => w.view_id === created.id)));
    } catch { /* The created id remains authoritative; do not retry blindly. */ }
    if (verified) pendingDashboardWidgetIds.delete(pendingKey);
    else pendingDashboardWidgetIds.set(pendingKey, created.id);
    return { ok: true, data: {
      action: "created", widget: slimView(created, verbose ?? false), verified,
      ...(verified ? {} : { verification_required: true }),
    } };
    };
    return serializeDashboardWrite(view_id, run);
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// update_view
// ──────────────────────────────────────────────────────────────────────────

const UpdateViewParams = z.object({
  view_id: notionId("view"),
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

const DeleteViewParams = z.object({ view_id: notionId("view") });

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
