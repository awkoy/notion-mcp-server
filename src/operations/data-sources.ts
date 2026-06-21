import { z } from "zod";
import { isFullDatabase } from "@notionhq/client";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimDataSource } from "../utils/slim.js";
import { DATABASE_PROPERTY_SCHEMA } from "../schema/database.js";
import { asSdk, type UpdateDataSourceBody } from "../utils/notion-types.js";

const VERBOSE = z.boolean().optional();

const ListDataSourcesParams = z.object({
  database_id: z.string().describe("Database ID to list data sources for."),
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
  data_source_id: z.string(),
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

const UpdateDataSourceParams = z.object({
  data_source_id: z.string(),
  title: z.array(z.unknown()).optional().describe("Rich text array for the data source title."),
  properties: z.record(z.string(), DATABASE_PROPERTY_SCHEMA).optional(),
  icon: z.unknown().optional(),
  archived: z.boolean().optional().describe("Deprecated alias for in_trash (removed on the 2026-03-11 surface). Routed to in_trash."),
  in_trash: z.boolean().optional(),
  verbose: VERBOSE,
});

register({
  name: "update_data_source",
  access: "write",
  domain: "data_sources",
  description: "Update a data source's schema (properties, title, icon). For database-level metadata use update_database.",
  batchable: true,
  schema: UpdateDataSourceParams,
  example: {
    data_source_id: "<data-source-id>",
    properties: {
      Status: { type: "status", status: { options: [] } },
    },
  },
  handler: tryHandler(async ({ data_source_id, title, properties, icon, archived, in_trash, verbose }) => {
    const notion = await getClient();
    // `archived` was removed on the 2026-03-11 surface; route the legacy alias
    // into `in_trash` so we never send a field the API rejects.
    const trash = in_trash ?? archived;
    const body = {
      data_source_id,
      ...(title !== undefined ? { title } : {}),
      ...(properties !== undefined ? { properties } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(trash !== undefined ? { in_trash: trash } : {}),
    };
    const response = await notion.dataSources.update(asSdk<UpdateDataSourceBody>(body));
    return { ok: true, data: slimDataSource(response, verbose ?? false) };
  }),
});
