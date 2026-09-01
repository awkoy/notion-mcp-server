import { z } from "zod";
import { isFullDatabase } from "@notionhq/client";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimDataSource } from "../utils/slim.js";
import { DATABASE_PROPERTY_SCHEMA } from "../schema/database.js";
import { asSdk, type UpdateDataSourceBody } from "../utils/notion-types.js";
import { notionId } from "../schema/id.js";

const VERBOSE = z.boolean().optional();

const ListDataSourcesParams = z.object({
  database_id: notionId().describe("Database ID to list data sources for."),
  verbose: VERBOSE,
});

register({
  name: "list_data_sources",
  access: "read",
  domain: "data_sources",
  description: "List data sources under a database. Use this before query_database when targeting multi-source databases.",
  batchable: false,
  schema: ListDataSourcesParams,
  example: { database_id: "<database-id>" },
  handler: tryHandler(async ({ database_id, verbose }) => {
    const notion = await getClient();
    const db = await notion.databases.retrieve({ database_id });
    const sources = isFullDatabase(db) ? db.data_sources : [];
    return {
      ok: true,
      data: verbose
        ? { database_id, data_sources: sources }
        : {
            database_id,
            data_sources: sources.map((s) => ({ id: s.id, name: s.name })),
          },
    };
  }),
});

const GetDataSourceParams = z.object({
  data_source_id: notionId(),
  verbose: VERBOSE,
});

register({
  name: "get_data_source",
  access: "read",
  domain: "data_sources",
  description: "Retrieve a single data source's schema (its property definitions and parent database).",
  batchable: true,
  schema: GetDataSourceParams,
  example: { data_source_id: "<data-source-id>" },
  exampleBatch: { items: [{ data_source_id: "<ds-1>" }, { data_source_id: "<ds-2>" }] },
  handler: tryHandler(async ({ data_source_id, verbose }) => {
    const notion = await getClient();
    const ds = await notion.dataSources.retrieve({ data_source_id });
    return { ok: true, data: slimDataSource(ds, verbose ?? false) };
  }),
});

const ListDataSourceTemplatesParams = z.object({
  data_source_id: notionId().describe("Data source ID to list templates for."),
  name: z.string().optional().describe("Case-insensitive substring filter on template name."),
  start_cursor: z.string().optional(),
  page_size: z.number().int().min(1).max(100).optional(),
});

register({
  name: "list_data_source_templates",
  access: "read",
  domain: "data_sources",
  description: "List the page templates available for a data source. Returns {id, name, is_default} per template. Pass a returned id as template.template_id to create_page to apply it.",
  batchable: false,
  schema: ListDataSourceTemplatesParams,
  example: { data_source_id: "<data-source-id>" },
  handler: tryHandler(async ({ data_source_id, name, start_cursor, page_size }) => {
    const notion = await getClient();
    const res = await notion.dataSources.listTemplates({
      data_source_id,
      ...(name !== undefined ? { name } : {}),
      ...(start_cursor !== undefined ? { start_cursor } : {}),
      ...(page_size !== undefined ? { page_size } : {}),
    });
    return {
      ok: true,
      data: { data_source_id, templates: res.templates },
    };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// update_data_source / delete_data_source
// ──────────────────────────────────────────────────────────────────────────

const UpdateDataSourceParams = z.object({
  data_source_id: notionId(),
  title: z.array(z.unknown()).optional().describe("Rich text array for the data source title."),
  properties: z.record(z.string(), DATABASE_PROPERTY_SCHEMA).optional(),
  icon: z.unknown().optional(),
  in_trash: z
    .boolean()
    .optional()
    .describe("Not accepted here — trashing is destructive and lives on delete_data_source (in_trash:false restores). Rejected here so the split is explicit."),
  archived: z
    .boolean()
    .optional()
    .describe("Deprecated alias for `in_trash`; not accepted here either. Call delete_data_source instead."),
  verbose: VERBOSE,
});

const DeleteDataSourceParams = z.object({
  data_source_id: notionId(),
  in_trash: z
    .boolean()
    .optional()
    .describe("Default true. Pass false to restore a data source from trash."),
  archived: z
    .boolean()
    .optional()
    .describe("Deprecated alias for `in_trash` (removed on the 2026-03-11 surface). Routed to `in_trash`."),
  verbose: VERBOSE,
});

register({
  name: "update_data_source",
  access: "write",
  domain: "data_sources",
  description: "Update a data source's schema (properties, title, icon). For database-level metadata use update_database. To trash or restore a data source use delete_data_source.",
  batchable: true,
  schema: UpdateDataSourceParams,
  example: {
    data_source_id: "<data-source-id>",
    properties: {
      // The API cannot create `status` property schemas; use select/multi_select.
      Priority: {
        type: "select",
        select: { options: [{ name: "High", color: "red" }, { name: "Low", color: "gray" }] },
      },
    },
  },
  handler: tryHandler(async ({ data_source_id, title, properties, icon, archived, in_trash, verbose }) => {
    // Kept in the schema (rather than dropped) so a stale caller gets an error
    // pointing at delete_data_source instead of a silent no-op: z.object strips
    // unknown keys, so an absent field would make `{ in_trash: true }` succeed
    // with the data source untouched.
    if (in_trash !== undefined || archived !== undefined) {
      return {
        ok: false,
        error: {
          code: "trash_moved",
          message: "in_trash / archived are no longer accepted on update_data_source — trashing is a destructive operation and lives on delete_data_source.",
          fix: "Call delete_data_source with the same data_source_id. It trashes by default; pass in_trash:false to restore.",
        },
      };
    }
    const notion = await getClient();
    const body = {
      data_source_id,
      ...(title !== undefined ? { title } : {}),
      ...(properties !== undefined ? { properties } : {}),
      ...(icon !== undefined ? { icon } : {}),
    };
    const response = await notion.dataSources.update(asSdk<UpdateDataSourceBody>(body));
    return { ok: true, data: slimDataSource(response, verbose ?? false) };
  }),
});

register({
  name: "delete_data_source",
  access: "write",
  domain: "data_sources",
  destructive: true,
  description: "Move a data source to trash, with every page in it. Reversible: pass in_trash:false to restore. To trash the whole database use delete_database.",
  batchable: true,
  schema: DeleteDataSourceParams,
  example: { data_source_id: "<data-source-id>" },
  exampleBatch: {
    items: [{ data_source_id: "<data-source-id-1>" }, { data_source_id: "<data-source-id-2>" }],
  },
  handler: tryHandler(async ({ data_source_id, in_trash, archived, verbose }) => {
    const notion = await getClient();
    // `archived` was removed on the 2026-03-11 surface; route the legacy alias
    // into `in_trash` so we never send a field the API rejects.
    const response = await notion.dataSources.update(
      asSdk<UpdateDataSourceBody>({
        data_source_id,
        in_trash: in_trash ?? archived ?? true,
      })
    );
    return { ok: true, data: slimDataSource(response, verbose ?? false) };
  }),
});
